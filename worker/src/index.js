// firedamp-api — Cloudflare Worker proxy for OpenRouter, with D1-backed
// response cache + dataset of plume analyses.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        const origin = req.headers.get('Origin') || '';

        if (req.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
        }

        try {
            if (url.pathname === '/api/analyse' && req.method === 'POST') {
                return await analyse(req, env, ctx, origin);
            }
            if (url.pathname === '/api/analyses' && req.method === 'GET') {
                return await listAnalyses(req, env, origin);
            }
        } catch (err) {
            console.error('handler error', err);
            return new Response(`internal error: ${err?.message || 'unknown'}`, {
                status: 500,
                headers: corsHeaders(origin, env),
            });
        }
        if (url.pathname === '/healthz') {
            return new Response('ok', { headers: corsHeaders(origin, env) });
        }
        return new Response('not found', { status: 404, headers: corsHeaders(origin, env) });
    }
};

function originAllowed(origin, env) {
    if (!origin) return false;
    return env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).includes(origin);
}

function corsHeaders(origin, env) {
    const h = {
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
    if (originAllowed(origin, env)) h['Access-Control-Allow-Origin'] = origin;
    return h;
}

async function analyse(req, env, ctx, origin) {
    if (!originAllowed(origin, env)) {
        return new Response('forbidden', { status: 403, headers: corsHeaders(origin, env) });
    }

    let body;
    try { body = await req.json(); }
    catch { return new Response('bad json', { status: 400, headers: corsHeaders(origin, env) }); }

    const { plumeId, prompt, image, lat, lon, dt, rate, src, force } = body || {};
    if (!plumeId || !prompt) {
        return new Response('plumeId and prompt required', { status: 400, headers: corsHeaders(origin, env) });
    }

    const promptSha = await sha256(prompt);
    const model = env.MODEL;

    // Cache lookup — by (plume_id, model, prompt_sha). Older prompts persist as
    // separate rows so we keep a full history; newest matching row wins.
    // ?force=1 / { force: true } skips the cache and forces a fresh generation;
    // the old row stays in the dataset for comparison.
    const cached = force ? null : await env.DB.prepare(
        `SELECT response FROM analyses
         WHERE plume_id = ? AND model = ? AND prompt_sha = ?
         ORDER BY created_at DESC LIMIT 1`
    ).bind(plumeId, model, promptSha).first();

    if (cached?.response) {
        return new Response(replaySSE(cached.response), {
            headers: {
                ...corsHeaders(origin, env),
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'X-Firedamp-Cache': 'hit',
            }
        });
    }

    // Miss → forward to OpenRouter
    const userContent = [{ type: 'text', text: prompt }];
    if (image) userContent.push({ type: 'image_url', image_url: { url: image } });

    const orResp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': origin,
            'X-Title': 'firedamp',
        },
        body: JSON.stringify({
            model,
            stream: true,
            temperature: 0.3,
            max_tokens: 600,
            messages: [{ role: 'user', content: userContent }],
        }),
    });

    if (!orResp.ok || !orResp.body) {
        const errText = await orResp.text().catch(() => '');
        return new Response(errText.slice(0, 500) || `openrouter ${orResp.status}`, {
            status: orResp.status,
            headers: corsHeaders(origin, env),
        });
    }

    // Tee: one branch streams to the browser, the other accumulates the full
    // text and writes to D1 once the upstream finishes. ctx.waitUntil keeps
    // the worker alive past the response so the DB write completes.
    const [toClient, toStore] = orResp.body.tee();

    ctx.waitUntil((async () => {
        try {
            const text = await collectSSEText(toStore);
            if (!text.trim()) return;
            const sourceLabel = parseSourceLine(text);
            await env.DB.prepare(
                `INSERT INTO analyses
                 (plume_id, model, response, source_label, lat, lon, plume_date, plume_rate, plume_src, prompt_sha, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                plumeId, model, text, sourceLabel,
                numOrNull(lat), numOrNull(lon),
                strOrNull(dt), numOrNull(rate), strOrNull(src),
                promptSha, Date.now()
            ).run();
        } catch (err) {
            console.error('store failed', err);
        }
    })());

    return new Response(toClient, {
        headers: {
            ...corsHeaders(origin, env),
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Firedamp-Cache': 'miss',
        }
    });
}

async function listAnalyses(req, env, origin) {
    if (!originAllowed(origin, env)) {
        return new Response('forbidden', { status: 403, headers: corsHeaders(origin, env) });
    }
    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const stmt = env.DB.prepare(
        `SELECT plume_id, model, source_label, lat, lon, plume_date, plume_rate, plume_src, response, created_at
         FROM analyses
         WHERE created_at > ?
         ORDER BY created_at DESC LIMIT ?`
    ).bind(since, limit);
    const r = await stmt.all();
    return Response.json(r.results || [], { headers: corsHeaders(origin, env) });
}

// ── helpers ──

async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function replaySSE(text) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(c) {
            const ev = JSON.stringify({ choices: [{ delta: { content: text } }] });
            c.enqueue(encoder.encode(`data: ${ev}\n\n`));
            c.enqueue(encoder.encode(`data: [DONE]\n\n`));
            c.close();
        }
    });
}

async function collectSSEText(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const p = t.slice(5).trim();
            if (!p || p === '[DONE]') continue;
            try {
                const ev = JSON.parse(p);
                const c = ev.choices?.[0]?.delta?.content
                       ?? ev.choices?.[0]?.message?.content
                       ?? '';
                if (c) text += c;
            } catch { /* skip malformed line */ }
        }
    }
    return text;
}

function parseSourceLine(text) {
    const m = text.match(/^\s*SOURCE\s*:\s*([^\n]+)/i);
    return m ? m[1].trim() : null;
}

function numOrNull(v) { return (v === undefined || v === null || v === '') ? null : Number(v); }
function strOrNull(v) { return (v === undefined || v === null || v === '') ? null : String(v); }
