// OGIM infrastructure: PMTiles layers, visibility toggle, proximity queries

import { map } from './map.js';
import { escapeHtml, formatDist, haversineKm } from './util.js';

const ogimBucket = document.querySelector('meta[name="ogim-bucket"]')?.content;
const ogimUrl = ogimBucket ? `${ogimBucket}/ogim.pmtiles` : 'data/ogim.pmtiles';

export let ogimVisible = false;

function createOGIMIcons() {
    const canvas = document.createElement('canvas');

    // × icon for wells
    const ws = 16;
    canvas.width = ws; canvas.height = ws;
    const wctx = canvas.getContext('2d', { willReadFrequently: true });
    wctx.clearRect(0, 0, ws, ws);
    wctx.strokeStyle = 'white';
    wctx.lineWidth = 2;
    wctx.lineCap = 'round';
    const wp = 4;
    wctx.beginPath();
    wctx.moveTo(wp, wp); wctx.lineTo(ws - wp, ws - wp);
    wctx.moveTo(ws - wp, wp); wctx.lineTo(wp, ws - wp);
    wctx.stroke();
    map.addImage('well-x', { width: ws, height: ws, data: wctx.getImageData(0, 0, ws, ws).data });

    // ◆ icon for facilities
    const fs = 16;
    canvas.width = fs; canvas.height = fs;
    const fctx = canvas.getContext('2d');
    fctx.clearRect(0, 0, fs, fs);
    fctx.fillStyle = 'rgba(255, 200, 100, 0.8)';
    const mid = fs / 2, r = 5;
    fctx.beginPath();
    fctx.moveTo(mid, mid - r);
    fctx.lineTo(mid + r, mid);
    fctx.lineTo(mid, mid + r);
    fctx.lineTo(mid - r, mid);
    fctx.closePath();
    fctx.fill();
    map.addImage('facility-diamond', { width: fs, height: fs, data: fctx.getImageData(0, 0, fs, fs).data });
}

export async function addOGIMLayers() {
    try {
        createOGIMIcons();

        map.addSource('ogim', {
            type: 'vector',
            url: `pmtiles://${ogimUrl}`,
            maxzoom: 14
        });

        map.addLayer({
            id: 'ogim-pipelines',
            type: 'line',
            source: 'ogim',
            'source-layer': 'pipelines',
            minzoom: 6,
            layout: { visibility: 'none' },
            paint: {
                'line-color': 'rgba(255, 255, 255, 0.3)',
                'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 14, 2]
            }
        });

        map.addLayer({
            id: 'ogim-facilities',
            type: 'symbol',
            source: 'ogim',
            'source-layer': 'facilities',
            minzoom: 6,
            layout: {
                visibility: 'none',
                'icon-image': 'facility-diamond',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.4, 12, 0.7, 16, 1]
            },
            paint: { 'icon-opacity': 0.8 }
        });

        map.addLayer({
            id: 'ogim-wells',
            type: 'symbol',
            source: 'ogim',
            'source-layer': 'wells',
            minzoom: 8,
            layout: {
                visibility: 'none',
                'icon-image': 'well-x',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 0.6, 16, 0.8]
            },
            paint: { 'icon-opacity': 0.6 }
        });

        // invisible preload layers — keep tiles loaded for proximity queries
        map.addLayer({
            id: 'ogim-preload',
            type: 'circle',
            source: 'ogim',
            'source-layer': 'facilities',
            paint: { 'circle-radius': 0, 'circle-opacity': 0 }
        });
        map.addLayer({
            id: 'ogim-wells-preload',
            type: 'circle',
            source: 'ogim',
            'source-layer': 'wells',
            minzoom: 8,
            paint: { 'circle-radius': 0, 'circle-opacity': 0 }
        });
        map.addLayer({
            id: 'ogim-pipelines-preload',
            type: 'line',
            source: 'ogim',
            'source-layer': 'pipelines',
            minzoom: 6,
            paint: { 'line-opacity': 0, 'line-width': 0 }
        });
    } catch (e) {
        console.warn('OGIM layers not available:', e.message);
    }
}

// ── proximity queries ──

// only filter clearly defunct features. 'N/A' on FAC_TYPE is common for
// facilities whose role is captured in CATEGORY instead (e.g. GATHERING AND
// PROCESSING plants like Ladder Creek) and on plenty of active wells too —
// dropping them used to leave the AI pipeline with an empty nearby list even
// when a named facility was sitting right under the plume.
const SKIP_TYPES = new Set(['DRY HOLE', 'UNKNOWN', '']);
const SKIP_STATUSES = new Set(['ABANDONED', 'INACTIVE']);

export function findNearbyInfra(lon, lat, { maxResults = 12, radiusKm = 2 } = {}) {
    if (!map.getSource('ogim')) return [];
    const results = [];
    const seen = new Set();
    for (const sourceLayer of ['facilities', 'wells', 'pipelines']) {
        for (const f of map.querySourceFeatures('ogim', { sourceLayer })) {
            const id = f.properties.OGIM_ID;
            if (seen.has(id)) continue;
            seen.add(id);
            const type = (f.properties.FAC_TYPE || '').trim();
            const status = (f.properties.OGIM_STATUS || '').trim();
            if (SKIP_TYPES.has(type) || SKIP_STATUSES.has(status)) continue;

            // pipelines are LineString / MultiLineString — find the closest
            // vertex. wells / facilities are Points.
            let closest = null;
            const g = f.geometry;
            if (g.type === 'Point') {
                closest = { lon: g.coordinates[0], lat: g.coordinates[1] };
            } else if (g.type === 'LineString') {
                closest = closestVertex(lat, lon, g.coordinates);
            } else if (g.type === 'MultiLineString') {
                for (const part of g.coordinates) {
                    const c = closestVertex(lat, lon, part);
                    if (!closest || c.dist < closest.dist) closest = c;
                }
            }
            if (!closest) continue;
            const dist = closest.dist != null ? closest.dist : haversineKm(lat, lon, closest.lat, closest.lon);
            if (dist > radiusKm) continue;

            const kind = sourceLayer === 'facilities' ? 'facility'
                       : sourceLayer === 'wells' ? 'well' : 'pipeline';
            const fallbackName = sourceLayer === 'pipelines' ? (type || 'Pipeline')
                              : sourceLayer === 'facilities' ? 'Facility' : 'Well';
            const category = (f.properties.CATEGORY || '').trim();
            results.push({
                kind,
                name: f.properties.FAC_NAME || type || category || fallbackName,
                type,
                category,
                operator: f.properties.OPERATOR || '',
                status,
                country: f.properties.COUNTRY || '',
                ogimId: id,
                lon: closest.lon,
                lat: closest.lat,
                dist,
                geometry: kind === 'pipeline' ? g : null
            });
        }
    }
    results.sort((a, b) => a.dist - b.dist);
    return results.slice(0, maxResults);
}

function closestVertex(lat, lon, coords) {
    let best = null;
    for (const [vlon, vlat] of coords) {
        const d = haversineKm(lat, lon, vlat, vlon);
        if (!best || d < best.dist) best = { lon: vlon, lat: vlat, dist: d };
    }
    return best;
}

// wait for OGIM tiles around (lon,lat) to load, then return nearby infra.
// used by the AI pipeline so it works regardless of the visual toggle state.
//
// opening a plume from a permalink triggers a flyTo() in parallel with the
// analysis pipeline; if we only wait for map.loaded() we can race the flyTo
// and end up querying tiles before they arrive, returning an empty list even
// when OGIM has matching features. re-querying after each idle event until we
// either find features or hit a 7 s budget catches that race.
export async function loadNearbyInfra(lon, lat, opts = {}) {
    if (!map.getSource('ogim')) return [];
    const deadline = Date.now() + 7000;
    let items = [];
    while (Date.now() < deadline) {
        await Promise.race([
            new Promise(r => map.once('idle', r)),
            new Promise(r => setTimeout(r, 1500)),
        ]);
        // force tile loading at the plume location regardless of the OGIM
        // visibility toggle. wells/facilities/pipelines live in separate
        // source layers so querying each one is what kicks off the fetch.
        map.querySourceFeatures('ogim', { sourceLayer: 'wells' });
        map.querySourceFeatures('ogim', { sourceLayer: 'facilities' });
        map.querySourceFeatures('ogim', { sourceLayer: 'pipelines' });
        items = findNearbyInfra(lon, lat, opts);
        if (items.length > 0) return items;
    }
    return items;
}

export function nearbyMarkup(nearby) {
    if (!nearby || !nearby.length) return '';
    return `<details class="nearby-accordion">
        <summary class="nearby-summary">Nearby infrastructure <span class="nearby-count">${nearby.length}</span></summary>
        <div class="nearby-list">
            ${nearby.map(f => `<div class="nearby-item" onclick="flyToInfra(${f.lon},${f.lat})">
                <div class="nearby-name">${escapeHtml(f.name)}</div>
                <div class="nearby-meta">${[f.operator, formatDist(f.dist)].filter(Boolean).map(escapeHtml).join(' · ')}</div>
                <div class="nearby-id">OGIM ${f.ogimId}</div>
            </div>`).join('')}
        </div>
    </details>`;
}

// ── toggle ──

const OGIM_MIN_ZOOM = 6;

export function toggleOGIM(visible) {
    ogimVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['ogim-wells', 'ogim-pipelines', 'ogim-facilities']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    document.getElementById('legend-infra').style.display = visible ? 'block' : 'none';
}

// OGIM PMTiles minzoom is 6. below that the toggle has no effect, so disable
// it with a tooltip explaining why; auto-uncheck if the user zooms out while
// it's on, so the legend stays honest.
export function updateOgimToggleEnabled() {
    const toggle = document.getElementById('ogim-toggle');
    if (!toggle) return;
    const zoomedIn = map.getZoom() >= OGIM_MIN_ZOOM;
    const row = toggle.closest('.toggle-row');
    if (zoomedIn) {
        toggle.disabled = false;
        if (row) row.classList.remove('disabled');
        toggle.title = '';
    } else {
        toggle.disabled = true;
        if (row) row.classList.add('disabled');
        toggle.title = `Zoom in past level ${OGIM_MIN_ZOOM} to enable`;
        if (toggle.checked) {
            toggle.checked = false;
            toggleOGIM(false);
        }
    }
}

// ── fly-to helpers (window-bound for inline onclick handlers) ──

function flyToInfra(lon, lat) {
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14) });
}

// find the OGIM feature in the source and fly to it.
function flyToOgim(ogimId) {
    if (!map.getSource('ogim')) return;
    for (const layer of ['facilities', 'wells', 'pipelines']) {
        for (const f of map.querySourceFeatures('ogim', { sourceLayer: layer })) {
            if (String(f.properties.OGIM_ID) === String(ogimId)) {
                const g = f.geometry;
                let lng, lat;
                if (g.type === 'Point') { [lng, lat] = g.coordinates; }
                else if (g.type === 'LineString') { [lng, lat] = g.coordinates[0]; }
                else if (g.type === 'MultiLineString') { [lng, lat] = g.coordinates[0][0]; }
                else continue;
                map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 17) });
                return;
            }
        }
    }
}

window.flyToInfra = flyToInfra;
window.flyToOgim = flyToOgim;
