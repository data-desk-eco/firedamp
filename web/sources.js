// candidate sources from the ch4id feature catalogue (features.fgb — ogim +
// osm + mapstand + gem point features on gcs), streamed via flatgeobuf bbox
// queries over http range requests. loaded optimistically for the viewport
// past MIN_ZOOM, plus a radius query around the selected plume with the
// attributed feature(s) highlighted.

import { map } from './map.js';
import { escapeHtml, fmtMetres, haversineM } from './util.js';

const bucket = document.querySelector('meta[name="data-bucket"]')?.content;
const FGB = `${bucket || 'data'}/features.fgb`;
const MIN_ZOOM = 13;
const MAX_SCAN = 4000, MAX_SHOW = 300;
const HL = '#ffc861', PT = '#ffffff';

// ch4id feature ids are OSM:w<id>; older attributions carry OSM:way/<id>
export const normId = id => id.replace(/^OSM:(way|node|relation)\//, (_, t) => `OSM:${t[0]}`);

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
// the radius cut and the display cap.
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
    if (e !== plumeEpoch) return;
    for (const f of feats) {
        const [flon, flat] = f.geometry.coordinates;
        f.properties.dist = haversineM(lat, lon, flat, flon);
    }
    feats.sort((a, b) => a.properties.dist - b.properties.dist);
    plumeFeats = feats.filter((f, i) =>
        (i < MAX_SHOW && f.properties.dist <= radiusKm * 1000) || hlIds.has(f.properties.id));
    render();
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
    // invisible fat twin of src-points: the hover/touch target
    map.addLayer({
        id: 'src-hit', type: 'circle', source: 'sources',
        paint: { 'circle-radius': 12, 'circle-opacity': 0, 'circle-stroke-width': 0 },
    });
    map.addLayer({
        id: 'src-points', type: 'symbol', source: 'sources',
        layout: {
            'text-field': '×',
            'text-font': ['Noto Sans Regular'],
            'text-size': hlCase(44, 30),
            'text-allow-overlap': true,
            'text-ignore-placement': true,
        },
        paint: {
            'text-color': hlCase(HL, PT),
            'text-halo-color': 'rgba(0,0,0,0.8)',
            'text-halo-width': 1,
        },
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'plume-popup', offset: 10 });
    const show = e => {
        const p = e.features[0].properties;
        const kind = (p.kind || '').replace(/_/g, ' ');
        const title = p.name || kind;
        const detail = [kind, p.operator, p.status, p.fuel, p.detail, p.dist != null && fmtMetres(p.dist)]
            .filter(v => v && v !== title).map(escapeHtml).join(' · ');
        popup.setLngLat(e.lngLat)
            .setHTML(`<strong>${escapeHtml(title)}</strong>${p.hl ? ' ★' : ''}<br>${detail}<br><small>${escapeHtml(p.id)}</small>`)
            .addTo(map);
    };
    map.on('mousemove', 'src-hit', show);
    map.on('click', 'src-hit', show); // touch
    map.on('mouseleave', 'src-hit', () => popup.remove());

    map.on('moveend', sweep);
    sweep();
}

// window-bound for the attribution label's inline onclick handler
window.flyToSource = id => {
    const f = [...plumeFeats, ...viewFeats].find(f => f.properties.id === id);
    if (f) map.flyTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 16) });
};
