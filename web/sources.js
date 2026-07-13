// nearby candidate sources: flatgeobuf bbox queries (http range requests
// against gcs) over the ch4id feature catalogue (features.fgb — ogim + osm +
// mapstand + gem), displayed per selected plume with the attributed
// feature(s) highlighted.

import { map } from './map.js';
import { escapeHtml, fmtMetres, haversineM } from './util.js';

const bucket = document.querySelector('meta[name="ogim-bucket"]')?.content;
const FGB = `${bucket || 'data'}/features.fgb`;
const EMPTY = { type: 'FeatureCollection', features: [] };
const MAX_SCAN = 4000, MAX_SHOW = 300;
const HL = '#ffc861', DIM = 'rgba(255,255,255,0.35)';

// ch4id feature ids are OSM:w<id>; older attributions carry OSM:way/<id>
export const normId = id => id.replace(/^OSM:(way|node|relation)\//, (_, t) => `OSM:${t[0]}`);

// nearest vertex distance (m) from the plume to any coordinate of a geometry
const minDist = (lat, lon, c) => typeof c[0] === 'number'
    ? haversineM(lat, lon, c[1], c[0])
    : c.reduce((m, x) => Math.min(m, minDist(lat, lon, x)), Infinity);

// bbox-stream the catalogue and keep the nearest candidates. the rect is
// stretched to cover the attribution's assessed source point so a distant
// attributed feature (coarse-sensor upwind search) still loads, and
// attributed ids survive both the radius cut and the display cap.
export async function querySources(lon, lat, radiusKm, rec) {
    const attr = new Set((rec?.attributed_ids || []).map(normId));
    const dLat = radiusKm / 111, dLon = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
    const rect = { minX: lon - dLon, minY: lat - dLat, maxX: lon + dLon, maxY: lat + dLat };
    if (rec?.lat != null) {
        rect.minX = Math.min(rect.minX, rec.lon - 0.02); rect.maxX = Math.max(rect.maxX, rec.lon + 0.02);
        rect.minY = Math.min(rect.minY, rec.lat - 0.02); rect.maxY = Math.max(rect.maxY, rec.lat + 0.02);
    }
    const out = [];
    try {
        for await (const f of flatgeobuf.deserialize(FGB, rect)) {
            f.properties.dist = minDist(lat, lon, f.geometry.coordinates);
            f.properties.hl = attr.has(f.properties.id);
            out.push(f);
            if (out.length >= MAX_SCAN) break;
        }
    } catch (err) { console.warn('features.fgb query failed:', err); }
    out.sort((a, b) => a.properties.dist - b.properties.dist);
    const near = out.filter(f => f.properties.dist <= radiusKm * 1000).slice(0, MAX_SHOW);
    return [...new Set([...out.filter(f => f.properties.hl), ...near])];
}

// ── display ──

const hlCase = (a, b) => ['case', ['get', 'hl'], a, b];

export function addSourceLayers() {
    map.addSource('sources', { type: 'geojson', data: EMPTY });
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
            const detail = [kind, p.operator, p.status, p.fuel, fmtMetres(p.dist)]
                .filter(v => v && v !== title).map(escapeHtml).join(' · ');
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${escapeHtml(title)}</strong>${p.hl ? ' ★' : ''}<br>${detail}<br><small>${escapeHtml(p.id)}</small>`)
                .addTo(map);
        });
        map.on('mouseleave', layer, () => popup.remove());
    }
}

export function showSources(feats) {
    map.getSource('sources')?.setData({ type: 'FeatureCollection', features: feats });
}
export const clearSources = () => showSources([]);
