// Plume source attribution — served entirely from the bulk agent-produced
// dataset (agent/run.py → data/attributions.json). there is no live
// vision/LLM pipeline in the browser any more: attributions.json, committed to
// git and validated at build time, is the single source of truth. wind is
// fetched separately as an independent panel stat.

import { loadNearbyInfra, nearbyMarkup } from './ogim.js';
import { escapeHtml, compass } from './util.js';

let analysisRequestId = 0;

// bulk agent-produced attributions, one static json for the whole dataset.
// loaded once and shared: the detail panel reads records by id, and app.js
// reads the key set to give attributed plumes a filled marker.
let attribDb = null;
export function loadAttributions() {
    return attribDb ??= fetch('data/attributions.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
}
async function staticAttribution(id) {
    return (await loadAttributions())[id] || null;
}

// invalidate any in-flight lookup (called when the panel closes)
export function cancelAnalysis() {
    analysisRequestId++;
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
    const labelHtml = sourceLabelHtml(p.source_label || '', p.attributed_id);
    const evidence = Array.isArray(p.evidence) && p.evidence.length
        ? `<div class="enrich-evidence">${p.evidence.map((u, i) =>
            `<a href="${escapeHtml(u)}" target="_blank" rel="noopener" title="${escapeHtml(u)}">[${i + 1}]</a>`).join(' ')}</div>`
        : '';
    return `<div class="enrich-report">
        <div class="enrich-source">${labelHtml}${p.confidence ? ` <span class="enrich-conf">${escapeHtml(p.confidence)}</span>` : ''}</div>
        ${p.paragraph ? `<p class="enrich-para">${escapeHtml(p.paragraph)}</p>` : ''}
        ${evidence}
    </div>`;
}

// make an OGIM-attributed source label fly the map to that feature on click.
function sourceLabelHtml(label, attributedId) {
    if (!label) return '';
    const safe = escapeHtml(label);
    if (!attributedId) return safe;
    const idSafe = escapeHtml(attributedId);
    if (attributedId.startsWith('OGIM:')) {
        const ogimId = attributedId.slice(5);
        return `<a class="enrich-attrib" href="#" onclick="flyToOgim('${escapeHtml(ogimId)}');return false" title="${idSafe}">${safe}</a>`;
    }
    if (attributedId.startsWith('OSM:')) {
        const osmRef = attributedId.slice(4); // e.g. "way/12345"
        return `<a class="enrich-attrib" href="https://www.openstreetmap.org/${escapeHtml(osmRef)}" target="_blank" rel="noopener" title="${idSafe}">${safe}</a>`;
    }
    return safe;
}

// ── pipeline ──

export function runPlumeAnalysis(feature) {
    const id = ++analysisRequestId;
    const p = feature.properties;
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    const plumeId = p.id || `${lat.toFixed(4)},${lon.toFixed(4)}`;

    const targetEl = () => analysisRequestId === id ? document.getElementById('enrich-results') : null;

    // OGIM nearby list is local-tile-derived (free) — populate independently.
    (async () => {
        const items = await loadNearbyInfra(lon, lat, { maxResults: 20, radiusKm: 2 });
        if (analysisRequestId !== id) return;
        const c = document.getElementById('detail-nearby');
        if (c) c.innerHTML = nearbyMarkup(items);
    })();

    // wind stat — independent of attribution.
    fetchWind(lat, lon, p.dt).then(w => { if (analysisRequestId === id) renderWind(w); });

    // attribution — sole source is the bulk agentic dataset.
    (async () => {
        const el = targetEl();
        if (!el) return;
        const rec = await staticAttribution(plumeId);
        if (analysisRequestId !== id) return;
        const el2 = targetEl();
        if (!el2) return;
        el2.innerHTML = rec
            ? renderAnalysisHTML(JSON.stringify(rec))
            : '<span class="enrich-empty">No source attribution yet.</span>';
    })();
}
