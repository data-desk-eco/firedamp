// mapstand oil and gas licence areas — the private deploy only (config.js
// gates on PRIVATE; mapstand acreage is licensed data). polygons stream from
// the archive's web/licences.fgb by flatgeobuf bbox query over http range
// requests, the same shape as candidates.js, drawn as a thin purple boundary
// over a faint wash beneath every plume layer.

import { hoverPopup } from './vendor/cartograph/shell.js';
import { map as dd } from './vendor/dd/palette.js';
import { escapeHtml } from './vendor/cartograph/util.js';

const bucket = document.querySelector('meta[name="data-bucket"]')?.content;
const FGB = `${bucket}/web/licences.fgb`;
const MIN_ZOOM = 6;          // whole-continent viewports would sweep the world
const MAX_SCAN = 1500;
const C = dd.adjusted.purple;

export const LICENCE_LAYERS = ['licences-fill', 'licences-line', 'licences-label'];

let map, epoch = 0, swept = null;

// refetch on moveend unless the viewport is still inside the padded rect we
// last swept (same skip rule as the candidate sweep)
async function sweep() {
    if (map.getZoom() < MIN_ZOOM) {
        if (swept) { swept = null; set([]); }
        return;
    }
    const b = map.getBounds();
    if (swept && b.getWest() >= swept.minX && b.getEast() <= swept.maxX
              && b.getSouth() >= swept.minY && b.getNorth() <= swept.maxY) return;
    const px = (b.getEast() - b.getWest()) * 0.3, py = (b.getNorth() - b.getSouth()) * 0.3;
    const rect = { minX: b.getWest() - px, minY: b.getSouth() - py,
                   maxX: b.getEast() + px, maxY: b.getNorth() + py };
    const e = ++epoch, out = [];
    try {
        for await (const f of flatgeobuf.deserialize(FGB, rect)) {
            out.push(f);
            if (out.length >= MAX_SCAN) break;
        }
    } catch (err) { return void console.warn('licences.fgb query failed:', err); }
    if (e !== epoch) return;
    swept = rect;
    set(out);
}

const set = features =>
    map.getSource('licences')?.setData({ type: 'FeatureCollection', features });

export function addLicenceLayers(m) {
    map = m;
    map.addSource('licences', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'licences-fill', type: 'fill', source: 'licences',
        paint: { 'fill-color': C, 'fill-opacity': 0.07 },
    });
    map.addLayer({
        id: 'licences-line', type: 'line', source: 'licences',
        paint: { 'line-color': C, 'line-width': 1, 'line-opacity': 0.8 },
    });
    // licence name at the polygon centre, tinted to its boundary. collision
    // drops them where acreage is dense (alberta is 55% of the layer), so they
    // only start once the viewport is tight enough to read
    map.addLayer({
        id: 'licences-label', type: 'symbol', source: 'licences',
        minzoom: 8,
        layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Montserrat Regular'], 'text-size': 10,
        },
        paint: { 'text-color': C, 'text-halo-color': dd.adjusted.black, 'text-halo-width': 1 },
    });

    hoverPopup(map, 'licences-fill', p => {
        const term = [p.start_date, p.end_date].filter(Boolean).join(' – ');
        const detail = [p.operator, p.country, p.shore,
                        p.area_sqkm && `${Number(p.area_sqkm).toLocaleString()} km²`, term]
            .filter(Boolean).map(escapeHtml).join(' · ');
        return `<span class="dd-title">${escapeHtml(p.name || 'Licence area')}</span><br>${detail}`;
    }, { click: false });

    map.on('moveend', sweep);
    sweep();
}
