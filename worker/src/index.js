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

        if (url.pathname === '/healthz') {
            return new Response('ok', { headers: corsHeaders(origin, env) });
        }

        try {
            if (url.pathname === '/api/analyse' && req.method === 'POST') {
                return await analyse(req, env, ctx, origin);
            }
            if (url.pathname === '/api/analyses' && req.method === 'GET') {
                return await listAnalyses(req, env, origin);
            }
            if (url.pathname.startsWith('/api/analysis/') && req.method === 'GET') {
                return await peekAnalysis(req, env, origin, decodeURIComponent(url.pathname.slice('/api/analysis/'.length)));
            }
        } catch (err) {
            console.error('handler error', err);
            return new Response(`internal error: ${err?.message || 'unknown'}`, {
                status: 500,
                headers: corsHeaders(origin, env),
            });
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

    const { plumeId, prompt, image, lat, lon, dt, rate, src, force, place, windSpeed, windDirFrom } = body || {};
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

    const orFetch = (m) => fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.OPENROUTER_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': origin,
            'X-Title': 'firedamp',
        },
        body: JSON.stringify({
            model: m,
            stream: true,
            temperature: 0.3,
            max_tokens: 700,
            messages: [{ role: 'user', content: userContent }],
            // JSON schema output where the provider supports it. We do NOT set
            // require_parameters: some routes ignore structured outputs, and
            // requiring it can leave no eligible provider. The prompt itself
            // asks for the JSON object, and the client parses defensively
            // (parseAnalysis / safeJsonParse), so providers that ignore
            // response_format still yield usable output. The per-field
            // descriptions act as soft instructions where the schema is applied.
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'plume_analysis',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            source_label: {
                                type: 'string',
                                description:
                                    "At most 8 words naming the source in plain English for a journalist. " +
                                    "Examples: 'Caerus Uinta gas well', 'Unlabelled tank battery', " +
                                    "'Sanitary landfill', 'Coal mine vent', 'No obvious source within 2 km'. " +
                                    "Never contains 'OGIM:' or 'OSM:'; those go in attributed_id. " +
                                    "Never a field name like 'Sector Waste'.",
                            },
                            source_kind: {
                                type: 'string',
                                enum: ['well', 'facility', 'pipeline', 'mine', 'landfill', 'other', 'none'],
                                description: "Use 'none' only when no source is identifiable from the image or data.",
                            },
                            attributed_id: {
                                type: ['string', 'null'],
                                description:
                                    "Copy verbatim from one of the supplied lists, in either 'OGIM:<id>' or " +
                                    "'OSM:<type>/<id>' form. Use null when the visible source has no matching list " +
                                    "entry (common for unlabelled pads). Never invent IDs. Never use a separator " +
                                    "other than the colon.",
                            },
                            paragraph: {
                                type: 'string',
                                description:
                                    "1 to 3 plain sentences. State the source and the visible evidence. " +
                                    "Do not list rejected hypotheses, do not describe overlay markers/colours, " +
                                    "do not end with 'no obvious source within 2 km' unless that IS the answer. " +
                                    "No markdown, no lists, no news/incident claims.",
                            },
                        },
                        required: ['source_label', 'source_kind', 'attributed_id', 'paragraph'],
                    },
                },
            },
        }),
    });

    // Retry transient 429/502/503 with backoff, then fail over to MODEL_FALLBACK
    // (a cheaper sibling) if configured, so a single provider hiccup never breaks
    // the feature. The result is always cached/stored under env.MODEL so peek
    // stays coherent regardless of which model actually answered. All retries
    // happen here, before the body is consumed; once streaming starts we are
    // committed.
    const fallback = env.MODEL_FALLBACK || null;
    const attempts = fallback
        ? [[model, 0], [model, 1000], [fallback, 0], [fallback, 1500]]
        : [[model, 0], [model, 1000], [model, 2500], [model, 4000]];
    let orResp;
    for (let i = 0; i < attempts.length; i++) {
        const [m, delay] = attempts[i];
        if (delay) await new Promise(r => setTimeout(r, delay));
        orResp = await orFetch(m);
        if (orResp.ok || ![429, 502, 503].includes(orResp.status)) break;
        // Free the connection before retrying — but keep the last failed body so
        // its error can be surfaced.
        if (i < attempts.length - 1) { try { await orResp.body?.cancel(); } catch { /* ignore */ } }
    }

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
            const parsed = safeJsonParse(text);
            await env.DB.prepare(
                `INSERT INTO analyses
                 (plume_id, model, response, source_label, source_kind, attributed_id, paragraph,
                  lat, lon, plume_date, plume_rate, plume_src, prompt_sha, created_at,
                  place_name, wind_speed, wind_dir_from)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                plumeId, model, text,
                strOrNull(parsed?.source_label),
                strOrNull(parsed?.source_kind),
                strOrNull(parsed?.attributed_id),
                strOrNull(parsed?.paragraph),
                numOrNull(lat), numOrNull(lon),
                strOrNull(dt), numOrNull(rate), strOrNull(src),
                promptSha, Date.now(),
                strOrNull(place), numOrNull(windSpeed), numOrNull(windDirFrom)
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

// Lightweight peek used by the browser before deciding to run the full
// pipeline. Returns the latest cached analysis for a plume_id (regardless of
// prompt_sha) so a returning user gets an instant render and we skip Overpass,
// Nominatim, Open-Meteo, and image capture entirely. 404 means "no row yet,
// run the full pipeline".
async function peekAnalysis(req, env, origin, plumeId) {
    if (!originAllowed(origin, env)) {
        return new Response('forbidden', { status: 403, headers: corsHeaders(origin, env) });
    }
    if (!plumeId) {
        return new Response('plumeId required', { status: 400, headers: corsHeaders(origin, env) });
    }
    const r = await env.DB.prepare(
        `SELECT response, source_label, source_kind, attributed_id, paragraph,
                place_name, wind_speed, wind_dir_from, created_at
         FROM analyses
         WHERE plume_id = ? AND model = ?
         ORDER BY created_at DESC LIMIT 1`
    ).bind(plumeId, env.MODEL).first();
    if (!r) {
        return new Response('null', { status: 404, headers: corsHeaders(origin, env) });
    }
    return Response.json(r, { headers: corsHeaders(origin, env) });
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

function safeJsonParse(text) {
    try { return JSON.parse(text); }
    catch { /* try to find first {...} block */ }
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

function numOrNull(v) { return (v === undefined || v === null || v === '') ? null : Number(v); }
function strOrNull(v) { return (v === undefined || v === null || v === '') ? null : String(v); }
