// Plume source attribution — served entirely from the bulk agent-produced
// dataset: the ch4id pipeline exports web/data/attributions.parquet (git
// source of truth) → scripts/build_attr.py → data/attributions.bin (FDA2,
// shipped). there is no live vision/LLM pipeline in the browser any more.
// wind is fetched separately as an independent panel stat.

import { selectPlume, clearSelection } from './sources.js';
import { escapeHtml, compass } from './util.js';

let analysisRequestId = 0;

const KIND = ['well', 'facility', 'pipeline', 'mine', 'landfill', 'other', 'none'];
const CONF = ['high', 'medium', 'low'];
const VERIFIED = ['confirmed', 'refuted', 'unclear'];

// FDA2 parser — mirror of scripts/build_attr.py
function parseAttributions(buf) {
    const b = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder();
    if (td.decode(b.subarray(0, 4)) !== 'FDA2') return {};
    const n = dv.getUint32(4, true);
    let o = 8;
    const models = [];
    for (let m = b[o++]; m > 0; m--) { const l = b[o++]; models.push(td.decode(b.subarray(o, o += l))); }
    const str = () => {
        let l = 0, s = 0, c;
        do { c = b[o++]; l |= (c & 0x7f) << s; s += 7; } while (c & 0x80);
        return td.decode(b.subarray(o, o += l));
    };
    const db = {};
    for (let i = 0; i < n; i++) {
        const kc = b[o], days = dv.getUint16(o + 1, true), model = models[b[o + 3]], fl = b[o + 4];
        o += 5;
        let lat = null, lon = null;
        if (fl & 4) { lat = dv.getFloat32(o, true); lon = dv.getFloat32(o + 4, true); o += 8; }
        const id = str();
        db[id] = {
            source_label: str(), source_name: str() || null, operator: str() || null,
            attributed_ids: str().split('\x1f').filter(Boolean), paragraph: str(),
            evidence: str().split('\x1f').filter(Boolean), verify_notes: str() || null,
            source_kind: KIND[kc >> 4], confidence: CONF[kc & 15], model, lat, lon,
            verified: VERIFIED[fl & 3] || null,
            run_at: new Date(Date.UTC(2020, 0, 1) + days * 864e5).toISOString().slice(0, 10),
        };
    }
    return db;
}

// bulk agent-produced attributions, one static binary for the whole dataset.
// loaded once and shared: the detail panel reads records by id, and app.js
// reads the key set to give attributed plumes a filled marker.
let attribDb = null;
export function loadAttributions() {
    return attribDb ??= fetch('data/attributions.bin')
        .then(async r => r.ok ? parseAttributions(await r.arrayBuffer()) : {})
        .catch(() => ({}));
}
async function staticAttribution(id) {
    return (await loadAttributions())[id] || null;
}

// invalidate any in-flight lookup (called when the panel closes)
export function cancelAnalysis() {
    analysisRequestId++;
    clearSelection();
}

// ── wind (independent panel stat) ──

// daily-mean surface wind at the plume coordinate from Open-Meteo's historical
// archive (no API key, CORS-friendly). returns the daily vector mean so brief
// gusts in random directions don't dominate.
async function fetchWind(lat, lon, dateISO) {
    if (!dateISO) return null;
    const url = `https://archive-api.open-meteo.com/v1/archive`
        + `?latitude=${lat}&longitude=${lon}`
        + `&start_date=${dateISO}&end_date=${dateISO}`
        + `&hourly=wind_speed_10m,wind_direction_10m`
        + `&wind_speed_unit=ms&timezone=auto`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        const speeds = data.hourly?.wind_speed_10m;
        const dirs = data.hourly?.wind_direction_10m;
        if (!speeds || !dirs) return null;
        // vector-mean wind. wind_direction is "FROM", convert to "TO" for
        // the vector sum so opposing winds cancel rather than averaging in
        // direction space (which is unstable around 0°/360°).
        let u = 0, v = 0, n = 0;
        for (let i = 0; i < speeds.length; i++) {
            const s = speeds[i], d = dirs[i];
            if (s == null || d == null) continue;
            const radTo = ((d + 180) % 360) * Math.PI / 180;
            u += s * Math.sin(radTo);
            v += s * Math.cos(radTo);
            n++;
        }
        if (n === 0) return null;
        u /= n; v /= n;
        const speed = Math.sqrt(u * u + v * v);
        const toDeg = (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
        const fromDeg = (toDeg + 180) % 360;
        return { speed, fromDeg, toDeg };
    } catch (err) {
        console.warn('Open-Meteo failed:', err);
        return null;
    }
}

// render wind into the stats grid. SVG arrow rotates so the head points in the
// direction the wind is blowing TO (i.e. the direction the plume drifts).
function renderWind(wind) {
    const el = document.getElementById('stat-wind');
    if (!el) return;
    if (!wind) {
        el.querySelector('.stat-wind-big').textContent = '—';
        return;
    }
    const speed = wind.speed.toFixed(1);
    el.title = `${speed} m/s from ${compass(wind.fromDeg)} (${Math.round(wind.fromDeg)}°)`;
    el.querySelector('.stat-wind-big').innerHTML = `
        <svg class="wind-arrow" viewBox="0 0 24 24" style="transform: rotate(${wind.toDeg}deg)">
            <path d="M12 4 L12 20 M12 4 L7 9 M12 4 L17 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="wind-speed">${speed}</span>`;
}

// ── attribution rendering ──

function parseAnalysis(text) {
    if (typeof text !== 'string') return null;
    try { return JSON.parse(text); }
    catch { /* try first {...} */ }
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

function renderAnalysisHTML(text) {
    const p = parseAnalysis(text);
    if (!p) return `<p class="enrich-para">${escapeHtml(text)}</p>`;
    const labelHtml = sourceLabelHtml(p.source_label || '', p.attributed_ids);
    const evidence = Array.isArray(p.evidence) && p.evidence.length
        ? `<div class="enrich-evidence">${p.evidence.map((u, i) =>
            `<a href="${escapeHtml(u)}" target="_blank" rel="noopener" title="${escapeHtml(u)}">[${i + 1}]</a>`).join(' ')}</div>`
        : '';
    // adversarial-verification badge; the verify pass's notes live in the tooltip
    const badge = { confirmed: 'verified', refuted: 'disputed' }[p.verified];
    const badgeHtml = badge
        ? ` <span class="enrich-badge enrich-${badge}" title="${escapeHtml(p.verify_notes || '')}">${badge}</span>` : '';
    return `<div class="enrich-report">
        <div class="enrich-source">${labelHtml}${p.confidence ? ` <span class="enrich-conf">${escapeHtml(p.confidence)}</span>` : ''}${badgeHtml}</div>
        ${p.paragraph ? `<p class="enrich-para">${escapeHtml(p.paragraph)}</p>` : ''}
        ${evidence}
    </div>`;
}

// make an attributed source label link out: OSM ids (short w/n/r or long
// way/node/relation form) link to osm, anything else flies to the feature.
function sourceLabelHtml(label, ids) {
    if (!label) return '';
    const safe = escapeHtml(label);
    const id = ids?.[0];
    if (!id) return safe;
    const idSafe = escapeHtml(ids.join(' '));
    const osm = id.match(/^OSM:(?:(w|n|r)|(way|node|relation)\/)(\d+)$/);
    if (osm) {
        const type = osm[2] || { w: 'way', n: 'node', r: 'relation' }[osm[1]];
        return `<a class="enrich-attrib" href="https://www.openstreetmap.org/${type}/${osm[3]}" target="_blank" rel="noopener" title="${idSafe}">${safe}</a>`;
    }
    return `<a class="enrich-attrib" href="#" onclick="flyToSource('${escapeHtml(id)}');return false" title="${idSafe}">${safe}</a>`;
}

// ── pipeline ──

export function runPlumeAnalysis(feature) {
    const id = ++analysisRequestId;
    const p = feature.properties;
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    const plumeId = p.id || `${lat.toFixed(4)},${lon.toFixed(4)}`;

    const targetEl = () => analysisRequestId === id ? document.getElementById('enrich-results') : null;

    // wind stat — independent of attribution.
    fetchWind(lat, lon, p.dt).then(w => { if (analysisRequestId === id) renderWind(w); });

    // attribution — sole source is the bulk agentic dataset — then the
    // nearby candidate sources from the ch4id catalogue, attributed ones
    // highlighted. coarse sensors get a wider candidate radius.
    (async () => {
        clearSelection();
        const rec = await staticAttribution(plumeId);
        if (analysisRequestId !== id) return;
        const el = targetEl();
        if (el) el.innerHTML = rec
            ? renderAnalysisHTML(JSON.stringify(rec))
            : '<span class="enrich-empty">No source attribution yet.</span>';
        const radiusKm = /tropomi|viirs|goes|s3/i.test(p.sat || '') ? 10 : 3;
        selectPlume(lon, lat, radiusKm, rec);
    })();
}
