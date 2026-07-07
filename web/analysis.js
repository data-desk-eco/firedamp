// AI plume analysis — one annotated Esri map (OGIM/OSM pins) + text KEY,
// routed through the firedamp-api Cloudflare Worker, which holds the
// OpenRouter key as a server secret and caches every response in D1.
// See worker/README for setup. The Worker emits OpenRouter-shaped SSE.

import { SRC_LABELS } from './plumes.js';
import { loadNearbyInfra, nearbyMarkup } from './ogim.js';
import { escapeHtml, compass, boundsDist, haversineM, fmtMetres, offsetLatLon } from './util.js';

const FIREDAMP_API = (() => {
    // override for local Worker development: ?api=local
    if (new URLSearchParams(location.search).get('api') === 'local') {
        return 'http://localhost:8787';
    }
    return document.querySelector('meta[name="firedamp-api"]')?.content?.trim() || '';
})();
const OPENROUTER_MODEL_LABEL = 'Qwen3-VL';
// ?debug — skip the peek fast-path and show the exact prompt + annotated map
// sent to the model. the worker still serves its D1 cache, so no LLM cost.
const DEBUG_AI = new URLSearchParams(location.search).has('debug');

let analysisRequestId = 0;

// bulk agent-produced attributions, one static json for the whole dataset
let attribDb = null;
async function staticAttribution(id) {
    attribDb ??= fetch('data/attributions.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
    return (await attribDb)[id] || null;
}

// invalidate any in-flight pipeline/stream (called when the panel closes)
export function cancelAnalysis() {
    analysisRequestId++;
}

// ── external data sources ──

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

// broad mode (tight frames around precise sensors) also sweeps generic
// industrial and agricultural buildings — real sources are often mapped only
// as building=industrial plus a name (mine vent shafts, gas plants) — while
// wide TROPOMI frames keep named buildings only so barns don't drown the KEY.
function buildOverpassQuery(south, west, north, east, broad) {
    const bbox = `${south},${west},${north},${east}`;
    return `[out:json][timeout:25];(
        nwr["man_made"~"^(petroleum_well|pipeline|pumping_station|storage_tank|works|gasometer|flare|chimney|kiln|mineshaft|adit|spoil_heap|tailings_pond|wastewater_plant|digester)$"](${bbox});
        nwr["industrial"](${bbox});
        nwr["landuse"~"^(industrial|quarry|landfill${broad ? '|farmyard' : ''})$"](${bbox});
        nwr["building"~"^(industrial|barn|cowshed|sty|stable|silo|digester|slurry_tank)$"]${broad ? '' : '["name"]'}(${bbox});
        nwr["power"="plant"](${bbox});
        nwr["plant:source"~"gas|oil|coal|biogas"](${bbox});
        nwr["generator:source"="biogas"](${bbox});
        nwr["amenity"~"^(waste_transfer_station|waste_disposal)$"](${bbox});
        nwr["amenity"="recycling"]["recycling_type"="centre"](${bbox});
        nwr["pipeline"="substation"](${bbox});
        nwr["substance"~"gas|oil|petroleum|natural_gas"](${bbox});
        nwr["aeroway"="aerodrome"](${bbox});
    );out tags bb;`;
}

async function queryOverpass(south, west, north, east, broad) {
    const query = buildOverpassQuery(south, west, north, east, broad);
    for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
            const resp = await fetch(endpoint, {
                method: 'POST',
                body: `data=${encodeURIComponent(query)}`,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            if (resp.status === 429 || resp.status === 504) continue;
            if (!resp.ok) throw new Error(`Overpass ${resp.status}`);
            return await resp.json();
        } catch (err) {
            console.warn(`Overpass (${endpoint}) failed:`, err);
        }
    }
    return null;
}

function summariseOsmElements(elements, plumeLat, plumeLon) {
    const items = [];
    const seen = new Set();
    for (const el of elements) {
        if (!el.tags) continue;
        const name = el.tags['name:en'] || el.tags.name || '';
        const b = el.bounds || null;
        const lat = el.lat ?? (b ? (b.minlat + b.maxlat) / 2 : null);
        const lon = el.lon ?? (b ? (b.minlon + b.maxlon) / 2 : null);
        const keep = {};
        for (const [k, v] of Object.entries(el.tags)) {
            if (['source', 'source:date', 'created_by', 'note', 'fixme', 'FIXME',
                 'addr:housenumber', 'addr:street', 'addr:city', 'addr:postcode',
                 'building:levels', 'roof:shape', 'roof:material'].includes(k)) continue;
            if (k.startsWith('name:') && k !== 'name:en') continue;
            keep[k] = v;
        }
        const key = `${name}:${JSON.stringify(keep)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dist = (lat != null && lon != null && plumeLat != null && plumeLon != null)
            ? boundsDist(plumeLat, plumeLon, b, lat, lon) : null;
        items.push({ osmId: `${el.type}/${el.id}`, name, lat, lon, bounds: b, tags: keep, dist });
    }
    // sort by distance ascending so the LLM sees the closest entries first
    items.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
    return items.slice(0, 60);
}

// reverse geocode via Nominatim — gives the LLM an authoritative place name
// (town, region, country) so it doesn't have to guess from raw lat/lon.
async function reverseGeocode(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1&accept-language=en`;
    try {
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data || !data.address) return null;
        const a = data.address;
        // build a short, readable hierarchy: locality, region, country
        const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county || '';
        const region = a.state || a.region || a.province || a.state_district || '';
        const country = a.country || '';
        const display = [locality, region, country].filter(Boolean).join(', ');
        return { display: display || data.display_name || null, country, region, locality };
    } catch (err) {
        console.warn('Nominatim reverse geocode failed:', err);
        return null;
    }
}

// daily-mean surface wind at the plume coordinate from Open-Meteo's historical
// archive (no API key, CORS-friendly). returns the daily vector mean so brief
// gusts in random directions don't dominate. useful for the "upwind" reasoning,
// especially for SRON / TROPOMI where the source is often several km upwind of
// the published centroid.
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

// ── per-sensor spatial model ──
// one row per source/sensor class, matched top-down. specM is the published
// positional accuracy of the reported coordinate (m); empM is an adopted
// override where observed repeat-detection scatter contradicts it — keep the
// evidence in a comment with each override. the dashed map ring is drawn at
// empM ?? specM; viewM (frame half-width, m) and searchKm (candidate-gathering
// radius) scale with it.
const SENSORS = [
    // carbon mapper airborne — aviris-ng/gao/av3 fly 3–8 m pixels
    { src: 'cm', sat: /AVIRIS|GAO|AV3|AV20/, specM: 30, viewM: 80, searchKm: 1 },
    // carbon mapper tanager-1 / enmap — 30 m pixels
    { src: 'cm', sat: /TANAGER|ENMAP/, specM: 45, viewM: 130, searchKm: 1 },
    // carbon mapper satellite fallback — emit etc., 60 m pixels
    { src: 'cm', specM: 100, viewM: 320, searchKm: 1.5 },
    // imeo — analyst-vetted, mixed sensors from ~25 m pixels up to tropomi
    { src: 'imeo', specM: 600, viewM: 1600, searchKm: 2.5 },
    // ghgsat c-series — 25 m pixels, nominally ~50 m. widened: 10 repeat
    // detections over the jankowice mine vent shaft (2023–24) scatter ~130 m,
    // and the old 160 m frame cropped the shaft out of the KEY (2026-07)
    { src: 'ghgsat', specM: 50, empM: 150, viewM: 450, searchKm: 1 },
    // sron — tropomi 5.5×7 km pixel; the plume drifts before imaging, so the
    // source sits ≈2 km (isolated) to 10 km+ (cluttered) away, almost always
    // upwind — hence upwind, which shifts the frame so the search area fills it
    { src: 'sron', specM: 4000, viewM: 5500, searchKm: 11, upwind: true },
    { specM: 300, viewM: 1200, searchKm: 2 }, // unknown source
];

function plumeUncertainty(p) {
    const sat = String(p.sat || '').toUpperCase();
    const s = SENSORS.find(r => (!r.src || r.src === p.src) && (!r.sat || r.sat.test(sat)));
    const ringM = s.empM ?? s.specM;
    const note = `The dashed ring shows its positional uncertainty (~${fmtMetres(ringM)}).`
        + (s.upwind ? ' TROPOMI plumes drift before imaging, so the source is usually upwind of the ⊕, sometimes beyond the ring.' : '');
    return { ringM, viewM: s.viewM, searchKm: s.searchKm, windBias: !!s.upwind, note };
}

// ── candidates + prompt ──

// pick the most descriptive single type tag for an OSM feature
const OSM_TYPE_KEYS = ['man_made', 'industrial', 'power', 'plant:source',
                       'substance', 'building', 'landuse', 'amenity', 'aeroway', 'pipeline'];
function osmShortType(tags) {
    for (const k of OSM_TYPE_KEYS) if (tags[k]) return String(tags[k]).replace(/_/g, ' ');
    return 'site';
}

// merge OGIM + OSM into one numbered candidate list shared by the map pins and
// the text KEY, so every number on the image has a matching key entry. closest
// to the marker first, capped, and limited to features inside the map frame.
function buildCandidates(ogimItems, osmFeatures, centerLat, centerLon, viewM, max = 12) {
    const cands = [];
    for (const it of ogimItems) {
        const typeOrCategory = it.type && it.type !== 'N/A' ? it.type : it.category;
        const label = [it.name, typeOrCategory, it.operator]
            .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ');
        cands.push({ id: `OGIM:${it.ogimId}`, kind: it.kind, lat: it.lat, lon: it.lon,
            dist: it.dist != null ? it.dist * 1000 : null, label, geometry: it.geometry });
    }
    for (const f of osmFeatures) {
        if (f.lat == null || f.lon == null) continue;
        const type = osmShortType(f.tags);
        const kind = /well/.test(type) ? 'well' : /pipeline/.test(type) ? 'pipeline' : 'facility';
        const name = f.name && f.name !== '(unnamed)' ? f.name : null;
        const label = [name, type, f.tags.product || f.tags.resource, f.tags.operator].filter(Boolean).join(' · ');
        cands.push({ id: `OSM:${f.osmId}`, kind, lat: f.lat, lon: f.lon, bounds: f.bounds,
            dist: f.dist ?? null, label, geometry: null });
    }
    const margin = viewM * 1.05;
    return cands
        .filter(c => boundsDist(centerLat, centerLon, c.bounds, c.lat, c.lon) <= margin)
        .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))
        .slice(0, max)
        .map((c, i) => ({ ...c, n: i + 1 }));
}

function formatCandidateKey(cands) {
    if (!cands.length) return 'No catalogued infrastructure in the frame.';
    return cands.map(c => `${c.n}. ${c.id} — ${c.label || c.kind} · ${c.dist === 0 ? 'site contains the ⊕' : fmtMetres(c.dist)}`).join('\n');
}

function sectorHint(sec) {
    switch (sec) {
        case 'og':    return 'Catalogue sector: oil & gas.';
        case 'coal':  return 'Catalogue sector: coal.';
        case 'waste': return 'Catalogue sector: waste.';
        case 'other': return 'Catalogue sector: other/unclear.';
        default:      return '';
    }
}

// minimal by design: primarily data (detection record, map, wind, KEY) plus a
// few neutral sentences of instructions. the model is trusted to read the
// imagery and judge for itself, rather than being walked through a rulebook.
function buildPlumePrompt(p, candidates, unc, place, wind, spanKm) {
    const lat = Number(p.lat).toFixed(4);
    const lon = Number(p.lon).toFixed(4);
    const rateThr = (Number(p.rate) / 1000).toFixed(2);
    const date = p.dt || 'unknown';
    const sat = p.sat || 'unknown sensor';
    const src = SRC_LABELS[p.src] || p.src;
    const placeStr = place?.display || 'an unknown location';
    const sector = sectorHint(p.sec);

    const windLine = wind
        ? ` Daily-mean surface wind was ${wind.speed.toFixed(1)} m/s toward the ${compass(wind.toDeg)} — the cyan arrow shows the drift; upwind is ${compass(wind.fromDeg)}.`
        : '';
    const pipeNote = candidates.some(c => c.kind === 'pipeline') ? ' Yellow lines are pipelines.' : '';

    return `You are a methane source-attribution analyst. You are shown one annotated satellite map and everything OpenStreetMap and the OGIM oil-&-gas inventory record for this spot (the KEY).

A ${src} satellite (${sat}) measured a ${rateThr} t/hr methane plume near ${lat}°, ${lon}° in ${placeStr} on ${date}.${sector ? ' ' + sector : ''}

THE MAP
A satellite image about ${spanKm} km across. The pink ⊕ marks the reported detection coordinate. ${unc.note}${windLine} Numbered pins mark the KEY entries.${pipeNote}

KEY (nearest the ⊕ first)
${formatCandidateKey(candidates)}

From the imagery and the KEY, identify the single most likely source of this plume, or state that none is apparent. Reply with ONLY this JSON object: {"source_label":…, "source_kind":…, "attributed_id":…, "paragraph":…}
- source_label: ≤8 words of plain English for a journalist (e.g. "Unlabelled tank battery", "No obvious source nearby").
- source_kind: one of well, facility, pipeline, mine, landfill, other, none.
- attributed_id: an id copied verbatim from the KEY, or null when the source isn't listed there.
- paragraph: 1–3 sentences naming the source and the visible evidence, expressing an honest degree of confidence ("likely", "most consistent with" — never certainty) and not mentioning the map annotations.`;
}

// ── annotated Esri imagery snapshot ──

function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const x = (lon + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
}

// pin colours by kind. each candidate is drawn as a numbered disc keyed to the
// text KEY in the prompt.
const PIN_FILL = { well: '#ffffff', facility: '#ffc861', pipeline: '#ffe664', mine: '#c9a0ff', landfill: '#9be39b', other: '#7ecbff' };

// one annotated satellite map: Esri imagery framed to the plume's spatial
// uncertainty, with a dashed uncertainty ring, a wind arrow, the detection ⊕,
// and numbered pins for the supplied candidates. returns a JPEG data URL.
async function captureAnnotatedMap({ centerLon, centerLat, plumeLon, plumeLat, viewM, ringM, candidates = [], wind = null }) {
    centerLon = ((centerLon + 180) % 360 + 360) % 360 - 180;

    // choose zoom + grid so the frame spans ~2·viewM, keeping detail by using a
    // 3×3 tile mosaic for the wider (SRON) frames.
    const EARTH = 40075016.686;
    const grid = viewM > 800 ? 3 : 2;
    const span = 2 * viewM * 1.08;
    let zoom = Math.round(Math.log2(EARTH * Math.cos(centerLat * Math.PI / 180) * grid / span));
    zoom = Math.max(10, Math.min(19, zoom));
    const maxTile = 2 ** zoom;
    const mPerPx = EARTH * Math.cos(centerLat * Math.PI / 180) / (256 * maxTile);

    const TILE = 256;
    const W = TILE * grid, H = TILE * grid;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const t = lonLatToTile(centerLon, centerLat, zoom);
    const baseX = Math.round(t.x - grid / 2);
    const baseY = Math.round(t.y - grid / 2);

    const loads = [];
    for (let dx = 0; dx < grid; dx++) {
        for (let dy = 0; dy < grid; dy++) {
            const x = ((baseX + dx) % maxTile + maxTile) % maxTile;
            const y = Math.max(0, Math.min(maxTile - 1, baseY + dy));
            const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`;
            loads.push(new Promise(resolve => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { ctx.drawImage(img, dx * TILE, dy * TILE); resolve(); };
                // a missing tile (common at the highest zooms) shouldn't sink the
                // whole capture — skip it and keep the rest of the mosaic.
                img.onerror = () => resolve();
                img.src = url;
            }));
        }
    }
    await Promise.all(loads);

    const project = (plon, plat) => {
        const pt = lonLatToTile(plon, plat, zoom);
        return { x: (pt.x - baseX) * TILE, y: (pt.y - baseY) * TILE };
    };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // pipelines first, so pins land on top.
    for (const c of candidates) {
        if (c.kind !== 'pipeline' || !c.geometry) continue;
        const segs = c.geometry.type === 'LineString' ? [c.geometry.coordinates] : c.geometry.coordinates;
        for (const pass of [{ s: 'rgba(0,0,0,0.55)', w: 5 }, { s: 'rgba(255,230,100,0.95)', w: 2 }]) {
            ctx.strokeStyle = pass.s; ctx.lineWidth = pass.w;
            for (const seg of segs) {
                ctx.beginPath();
                seg.forEach(([plon, plat], i) => {
                    const p = project(plon, plat);
                    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
                });
                ctx.stroke();
            }
        }
    }

    const plume = project(plumeLon, plumeLat);

    // dashed uncertainty ring around the detection coordinate.
    const ringPx = ringM / mPerPx;
    if (ringPx > 8) {
        ctx.save();
        ctx.setLineDash([8, 7]);
        ctx.strokeStyle = 'rgba(255,45,209,0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(plume.x, plume.y, ringPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // wind arrow from the detection coordinate, pointing the way the plume drifts.
    if (wind && wind.toDeg != null) {
        const len = Math.min(W, H) * 0.16;
        const a = wind.toDeg * Math.PI / 180; // bearing → screen vector (0°=up, clockwise)
        const dx = Math.sin(a), dy = -Math.cos(a);
        const ex = plume.x + dx * len, ey = plume.y + dy * len;
        ctx.strokeStyle = 'rgba(120,235,255,0.95)';
        ctx.fillStyle = 'rgba(120,235,255,0.95)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(plume.x, plume.y); ctx.lineTo(ex, ey); ctx.stroke();
        const head = 9, ha = 0.5;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - head * Math.sin(a - ha), ey + head * Math.cos(a - ha));
        ctx.lineTo(ex - head * Math.sin(a + ha), ey + head * Math.cos(a + ha));
        ctx.closePath(); ctx.fill();
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('drift', ex + dx * 18, ey + dy * 18);
        ctx.fillText('upwind', plume.x - dx * len, plume.y - dy * len);
    }

    // numbered candidate pins.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of candidates) {
        const { x, y } = project(c.lon, c.lat);
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
        ctx.beginPath();
        ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = PIN_FILL[c.kind] || PIN_FILL.other;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.stroke();
        ctx.fillStyle = '#000';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText(String(c.n), x, y + 0.5);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    // detection coordinate — magenta ⊕ on top of everything.
    ctx.strokeStyle = '#ff2dd1';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(plume.x, plume.y, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(plume.x - 22, plume.y); ctx.lineTo(plume.x - 7, plume.y);
    ctx.moveTo(plume.x + 7, plume.y); ctx.lineTo(plume.x + 22, plume.y);
    ctx.moveTo(plume.x, plume.y - 22); ctx.lineTo(plume.x, plume.y - 7);
    ctx.moveTo(plume.x, plume.y + 7); ctx.lineTo(plume.x, plume.y + 22);
    ctx.stroke();

    return canvas.toDataURL('image/jpeg', 0.9);
}

// ── response rendering ──

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

// ── worker round-trip ──

async function streamPlumeLLM(container, prompt, plume, mapOpts, { force = false, place = null, wind = null } = {}) {
    if (!FIREDAMP_API) {
        container.innerHTML = '<span class="enrich-empty">Analysis API not configured. Set <code>meta[name=&quot;firedamp-api&quot;]</code> in index.html.</span>';
        return;
    }
    const lat = mapOpts.plumeLat, lon = mapOpts.plumeLon;

    container.innerHTML = `<div class="enrich-status">Capturing imagery…</div>`;
    const statusEl = container.querySelector('.enrich-status');

    let imageDataUrl = null;
    try {
        imageDataUrl = await captureAnnotatedMap(mapOpts);
    } catch (err) {
        console.warn('Esri snapshot failed, proceeding text-only:', err);
    }

    if (DEBUG_AI) {
        document.getElementById('enrich-debug')?.remove();
        container.insertAdjacentHTML('beforebegin',
            `<details id="enrich-debug" open><summary>agent input</summary>` +
            (imageDataUrl ? `<img src="${imageDataUrl}" alt="annotated map">` : '<em>no image (capture failed)</em>') +
            `<pre>${escapeHtml(prompt)}</pre></details>`);
        console.log('[firedamp debug] prompt:\n' + prompt, '\nimage:', imageDataUrl);
    }

    statusEl.textContent = `Querying ${OPENROUTER_MODEL_LABEL}…`;

    try {
        const resp = await fetch(`${FIREDAMP_API}/api/analyse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                plumeId: plume.id || `${lat.toFixed(4)},${lon.toFixed(4)}`,
                prompt,
                image: imageDataUrl,
                lat, lon,
                dt: plume.dt, rate: plume.rate, src: plume.src,
                place: place?.display || null,
                windSpeed: wind?.speed ?? null,
                windDirFrom: wind?.fromDeg ?? null,
                force,
            }),
        });
        if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            throw new Error(`firedamp-api ${resp.status}: ${errBody.slice(0, 200)}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let text = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let event;
                try { event = JSON.parse(payload); } catch { continue; }
                const choice = event.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta || choice.message || {};
                if (delta.content) {
                    text += delta.content;
                    // JSON streams aren't useful to render partially; show a
                    // progress dot count so the user knows it's working.
                    if (statusEl) statusEl.textContent = 'Analysing' + '.'.repeat(((text.length / 40) | 0) % 4);
                }
            }
        }

        if (!text.trim()) {
            container.innerHTML = '<span class="enrich-empty">Analysis unavailable</span>';
            return;
        }
        container.innerHTML = renderAnalysisHTML(text);
    } catch (err) {
        console.warn('Analysis stream failed:', err);
        statusEl.style.display = 'none';
        container.innerHTML = `<span class="enrich-empty">Analysis failed: ${escapeHtml(String(err.message || err))}</span>`;
    }
}

// ── pipeline ──

export function runPlumeAnalysis(feature, { force = false } = {}) {
    const id = ++analysisRequestId;
    const p = feature.properties;
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    const plumeId = p.id || `${lat.toFixed(4)},${lon.toFixed(4)}`;

    const targetEl = () => analysisRequestId === id ? document.getElementById('enrich-results') : null;

    // OGIM nearby list is local-tile-derived (free) — populate independently
    // of the AI path so it shows up immediately on every plume select.
    (async () => {
        const items = await loadNearbyInfra(lon, lat, { maxResults: 20, radiusKm: 2 });
        if (analysisRequestId !== id) return;
        const c = document.getElementById('detail-nearby');
        if (c) c.innerHTML = nearbyMarkup(items);
    })();

    (async () => {
        const el = targetEl();
        if (!el) return;

        // static agentic attributions (agent/run.py → data/attributions.json)
        // take precedence over the on-demand worker path; ↻ forces a live run.
        if (!force) {
            const rec = await staticAttribution(plumeId);
            if (analysisRequestId !== id) return;
            if (rec) {
                el.innerHTML = renderAnalysisHTML(JSON.stringify(rec));
                fetchWind(lat, lon, p.dt).then(w => { if (analysisRequestId === id) renderWind(w); });
                return;
            }
        }

        // fast path: if the Worker already has a cached analysis for this
        // plume, use it directly and skip Overpass / Nominatim / Open-Meteo
        // / image capture / OpenRouter entirely. this is what makes
        // re-opening a previously-analysed plume effectively free.
        if (!force && !DEBUG_AI && FIREDAMP_API) {
            try {
                const peek = await fetch(`${FIREDAMP_API}/api/analysis/${encodeURIComponent(plumeId)}`);
                if (analysisRequestId !== id) return;
                if (peek.ok) {
                    const row = await peek.json();
                    el.innerHTML = renderAnalysisHTML(row.response);
                    renderWind(row.wind_speed != null && row.wind_dir_from != null ? {
                        speed: row.wind_speed,
                        fromDeg: row.wind_dir_from,
                        toDeg: (row.wind_dir_from + 180) % 360,
                    } : null);
                    return;
                }
            } catch (err) {
                // fall through to full pipeline
                console.warn('peek failed, running full pipeline:', err);
            }
        }

        el.innerHTML = '<div class="enrich-loading">Loading nearby infrastructure and place…</div>';

        // search radius scales with the source's spatial uncertainty (SRON spans
        // ~11 km). the Overpass box is capped to keep the query from timing out
        // in dense basins; OGIM tiles are local and cheap, so they get the full
        // radius.
        const unc = plumeUncertainty(p);
        const obKm = Math.min(unc.searchKm, 8);
        const dLat = obKm / 111;
        const dLon = obKm / (111 * Math.cos(lat * Math.PI / 180));

        const windPromise = fetchWind(lat, lon, p.dt).then(w => {
            if (analysisRequestId === id) renderWind(w);
            return w;
        });

        const [overpassData, ogimItems, place] = await Promise.all([
            queryOverpass(lat - dLat, lon - dLon, lat + dLat, lon + dLon, unc.searchKm <= 1.5),
            loadNearbyInfra(lon, lat, { maxResults: 40, radiusKm: unc.searchKm }),
            reverseGeocode(lat, lon),
        ]);
        if (analysisRequestId !== id) return;

        const osmFeatures = overpassData?.elements ? summariseOsmElements(overpassData.elements, lat, lon) : [];

        // wind feeds upwind reasoning and, for SRON, biases the map frame, so it
        // is load-bearing here. Open-Meteo is usually already resolved by the
        // time Overpass returns; the slack is a backstop (a touch longer when
        // the frame depends on it). a slow response never permanently blocks.
        const wind = await Promise.race([
            windPromise,
            new Promise(r => setTimeout(() => r(null), unc.windBias ? 2500 : 400)),
        ]);

        // one artifact: frame the map to the uncertainty, shifting it upwind for
        // SRON so the likely-source region fills it. candidates are numbered for
        // both the pins and the text KEY.
        let centerLat = lat, centerLon = lon;
        if (unc.windBias && wind) {
            const c = offsetLatLon(lat, lon, unc.viewM * 0.55, wind.fromDeg);
            centerLat = c.lat; centerLon = c.lon;
        }
        const candidates = buildCandidates(ogimItems, osmFeatures, centerLat, centerLon, unc.viewM);
        const spanKm = unc.viewM >= 1000 ? Math.round(unc.viewM * 2 / 1000) : (unc.viewM * 2 / 1000).toFixed(1);
        const prompt = buildPlumePrompt(p, candidates, unc, place, wind, spanKm);

        const el2 = targetEl();
        if (!el2) return;
        await streamPlumeLLM(el2, prompt, p, {
            centerLon, centerLat, plumeLon: lon, plumeLat: lat,
            viewM: unc.viewM, ringM: unc.ringM, candidates, wind,
        }, { force, place, wind });
    })();
}
