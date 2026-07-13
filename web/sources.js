// candidate sources from the ch4id feature catalogue (features.fgb — ogim +
// osm + mapstand + gem on gcs), streamed via flatgeobuf bbox queries over
// http range requests. loaded optimistically for the viewport past MIN_ZOOM,
// plus a radius query around the selected plume with the attributed
// feature(s) highlighted.

import { map } from './map.js';
import { escapeHtml, fmtMetres, formatDist, haversineM } from './util.js';

const bucket = document.querySelector('meta[name="data-bucket"]')?.content;
const FGB = `${bucket || 'data'}/features.fgb`;
const MIN_ZOOM = 13;
const MAX_SCAN = 4000, MAX_SHOW = 300;
const HL = '#ffc861', DIM = 'rgba(255,255,255,0.35)';

// ch4id feature ids are OSM:w<id>; older attributions carry OSM:way/<id>
export const normId = id => id.replace(/^OSM:(way|node|relation)\//, (_, t) => `OSM:${t[0]}`);

// nearest vertex of a geometry to (lat, lon) → {d, lon, lat}
const nearest = (lat, lon, c) => typeof c[0] === 'number'
    ? { d: haversineM(lat, lon, c[1], c[0]), lon: c[0], lat: c[1] }
    : c.map(x => nearest(lat, lon, x)).reduce((m, x) => x.d < m.d ? x : m);

const firstVertex = c => typeof c[0] === 'number' ? c : firstVertex(c[0]);

async function fetchRect(rect) {
    const out = [];
    try {
        for await (const f of flatgeobuf.deserialize(FGB, rect)) {
            out.push(f);
            if (out.length >= MAX_SCAN) break;
        }
    } catch (err) { console.warn('features.fgb query failed:', err); }
    return out;
}

// ── state: viewport sweep + per-plume selection, merged for display ──

let viewFeats = [], plumeFeats = [], hlIds = new Set();
let sweepEpoch = 0, plumeEpoch = 0, swept = null;

function render() {
    const seen = new Set(), features = [];
    for (const f of [...plumeFeats, ...viewFeats]) {
        if (seen.has(f.properties.id)) continue;
        seen.add(f.properties.id);
        f.properties.hl = hlIds.has(f.properties.id);
        features.push(f);
    }
    map.getSource('sources')?.setData({ type: 'FeatureCollection', features });
}

// viewport sweep — refetch on moveend unless still inside the padded rect
async function sweep() {
    if (map.getZoom() < MIN_ZOOM) {
        if (viewFeats.length) { viewFeats = []; swept = null; render(); }
        return;
    }
    const b = map.getBounds();
    if (swept && b.getWest() >= swept.minX && b.getEast() <= swept.maxX
              && b.getSouth() >= swept.minY && b.getNorth() <= swept.maxY) return;
    const px = (b.getEast() - b.getWest()) * 0.3, py = (b.getNorth() - b.getSouth()) * 0.3;
    const rect = { minX: b.getWest() - px, minY: b.getSouth() - py, maxX: b.getEast() + px, maxY: b.getNorth() + py };
    const e = ++sweepEpoch;
    const feats = await fetchRect(rect);
    if (e !== sweepEpoch) return;
    viewFeats = feats;
    swept = rect;
    render();
}

// radius query around the selected plume; the rect is stretched to cover the
// attribution's assessed source point so a distant attributed feature
// (coarse-sensor upwind search) still loads, and attributed ids survive both
// the radius cut and the display cap. returns candidates nearest-first.
export async function selectPlume(lon, lat, radiusKm, rec) {
    hlIds = new Set((rec?.attributed_ids || []).map(normId));
    const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
    const rect = { minX: lon - dLon, minY: lat - dLat, maxX: lon + dLon, maxY: lat + dLat };
    if (rec?.lat != null) {
        rect.minX = Math.min(rect.minX, rec.lon - 0.02); rect.maxX = Math.max(rect.maxX, rec.lon + 0.02);
        rect.minY = Math.min(rect.minY, rec.lat - 0.02); rect.maxY = Math.max(rect.maxY, rec.lat + 0.02);
    }
    const e = ++plumeEpoch;
    const feats = await fetchRect(rect);
    if (e !== plumeEpoch) return [];
    for (const f of feats) {
        const n = nearest(lat, lon, f.geometry.coordinates);
        Object.assign(f.properties, { dist: n.d, alon: n.lon, alat: n.lat });
    }
    feats.sort((a, b) => a.properties.dist - b.properties.dist);
    plumeFeats = feats.filter((f, i) =>
        (i < MAX_SHOW && f.properties.dist <= radiusKm * 1000) || hlIds.has(f.properties.id));
    render();
    return plumeFeats;
}

export function clearSelection() {
    plumeFeats = [];
    hlIds = new Set();
    render();
}

// ── display ──

const hlCase = (a, b) => ['case', ['get', 'hl'], a, b];

export function addSourceLayers() {
    map.addSource('sources', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'src-fills', type: 'fill', source: 'sources',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': hlCase(HL, '#ffffff'), 'fill-opacity': hlCase(0.15, 0.04) },
    });
    map.addLayer({
        id: 'src-lines', type: 'line', source: 'sources',
        filter: ['!=', ['geometry-type'], 'Point'],
        paint: { 'line-color': hlCase(HL, DIM), 'line-width': hlCase(2.5, 1.2) },
    });
    map.addLayer({
        id: 'src-points', type: 'circle', source: 'sources',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
            'circle-radius': hlCase(6, 3.5),
            'circle-color': hlCase(HL, 'transparent'),
            'circle-stroke-color': hlCase('rgba(0,0,0,0.8)', DIM),
            'circle-stroke-width': 1.5,
        },
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'plume-popup', offset: 10 });
    for (const layer of ['src-points', 'src-lines', 'src-fills']) {
        map.on('mousemove', layer, e => {
            const p = e.features[0].properties;
            const kind = (p.kind || '').replace(/_/g, ' ');
            const title = p.name || kind;
            const detail = [kind, p.operator, p.status, p.fuel, p.dist != null && fmtMetres(p.dist)]
                .filter(v => v && v !== title).map(escapeHtml).join(' · ');
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${escapeHtml(title)}</strong>${p.hl ? ' ★' : ''}<br>${detail}<br><small>${escapeHtml(p.id)}</small>`)
                .addTo(map);
        });
        map.on('mouseleave', layer, () => popup.remove());
    }

    map.on('moveend', sweep);
    sweep();
}

// ── nearby-sources accordion (detail panel) ──

export function nearbyMarkup(feats) {
    if (!feats.length) return '';
    return `<details class="nearby-accordion">
        <summary class="nearby-summary">Nearby sources <span class="nearby-count">${feats.length}</span></summary>
        <div class="nearby-list">
            ${feats.map(({ properties: p }) => `<div class="nearby-item" onclick="flyToSource('${escapeHtml(p.id)}')">
                <div class="nearby-name">${escapeHtml(p.name || (p.kind || '').replace(/_/g, ' '))}</div>
                <div class="nearby-meta">${[p.operator, formatDist(p.dist / 1000)].filter(Boolean).map(escapeHtml).join(' · ')}</div>
                <div class="nearby-id">${escapeHtml(p.id.replace(':', ' '))}</div>
            </div>`).join('')}
        </div>
    </details>`;
}

// window-bound for inline onclick handlers
window.flyToSource = id => {
    const f = [...plumeFeats, ...viewFeats].find(f => f.properties.id === id);
    if (!f) return;
    const [lon, lat] = f.properties.alon != null
        ? [f.properties.alon, f.properties.alat]
        : firstVertex(f.geometry.coordinates);
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 16) });
};
