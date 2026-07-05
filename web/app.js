// entry point — data load, layer assembly, UI wiring

import { map } from './map.js';
import { parsePlumes, addPlumeLayers, setFilter } from './plumes.js';
import { addOGIMLayers, toggleOGIM, updateOgimToggleEnabled } from './ogim.js';
import { setupInteractions, restorePermalink, refreshNearby } from './detail.js';
import { buildSpatialGrid, isWithinRadius } from './util.js';
import { CUSTOM_LAYERS } from './layers.js';

map.on('load', async () => {
    const buf = await fetch('data/plumes.bin').then(r => r.arrayBuffer());
    let plumes = parsePlumes(buf);

    // reveal the ghgsat toggle/legend only when local-only ghgsat data is present
    if (plumes.some(p => p.src === 'ghgsat'))
        document.querySelectorAll('[data-ghgsat]').forEach(el => { el.hidden = false; });

    // OGIM layers (hidden by default, rendered below plumes)
    await addOGIMLayers();

    plumes = await applyCustomLayer(plumes);

    addPlumeLayers(plumes);
    setupInteractions();
    restorePermalink(plumes);
});

// custom overlay layers via ?layer=<slug> — see layers.js. may filter the
// plume set to a radius around the layer's sites.
async function applyCustomLayer(plumes) {
    const slug = new URLSearchParams(location.search).get('layer');
    const layer = slug && CUSTOM_LAYERS[slug];
    if (!layer) return plumes;
    const color = layer.color || '#00ff00';

    // resolve site coordinates for proximity filtering: [[lon, lat], ...]
    let siteCoords = null;
    if (layer.sitesUrl) {
        siteCoords = await fetch(layer.sitesUrl).then(r => r.json());
    } else if (layer.sites) {
        siteCoords = layer.sites.map(s => [s.lon, s.lat]);
    }

    // filter plumes to radius around layer sites
    if (siteCoords && layer.filterRadius) {
        const before = plumes.length;
        const grid = buildSpatialGrid(siteCoords, 0.1);
        plumes = plumes.filter(p => isWithinRadius(p.lon, p.lat, grid, 0.1, layer.filterRadius));
        console.log(`Layer "${slug}": filtered ${before} plumes → ${plumes.length} within ${layer.filterRadius} km of ${siteCoords.length} sites`);
    }

    // OGIM operator highlight layers (rendered above base OGIM, below plumes)
    if (layer.ogimOperators && map.getSource('ogim')) {
        const opFilter = ['in', ['get', 'OPERATOR'], ['literal', layer.ogimOperators]];
        map.addLayer({
            id: 'custom-ogim-wells',
            type: 'circle',
            source: 'ogim',
            'source-layer': 'wells',
            minzoom: 3,
            filter: opFilter,
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 1, 6, 2, 10, 4, 14, 6],
                'circle-color': color,
                'circle-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 8, 0.3, 14, 0],
                'circle-stroke-color': color,
                'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 6, 1, 10, 1.5, 14, 2],
                'circle-stroke-opacity': 0.8
            }
        });
        map.addLayer({
            id: 'custom-ogim-facilities',
            type: 'circle',
            source: 'ogim',
            'source-layer': 'facilities',
            minzoom: 3,
            filter: opFilter,
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 6, 4, 10, 6, 14, 8],
                'circle-color': color,
                'circle-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 8, 0.3, 14, 0],
                'circle-stroke-color': color,
                'circle-stroke-width': 2,
                'circle-stroke-opacity': 0.9
            }
        });
    }

    // static site markers with labels (for layers with explicit sites)
    if (layer.sites) {
        map.addSource('custom-layer', {
            type: 'geojson',
            data: {
                type: 'FeatureCollection',
                features: layer.sites.map(s => ({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
                    properties: { name: s.name }
                }))
            }
        });
        map.addLayer({
            id: 'custom-layer-circles',
            type: 'circle',
            source: 'custom-layer',
            paint: {
                'circle-radius': 14,
                'circle-color': 'transparent',
                'circle-stroke-color': color,
                'circle-stroke-width': 3,
                'circle-stroke-opacity': 0.9
            }
        });
        map.addLayer({
            id: 'custom-layer-labels',
            type: 'symbol',
            source: 'custom-layer',
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 11,
                'text-offset': [0, -1.8],
                'text-anchor': 'bottom'
            },
            paint: {
                'text-color': color,
                'text-halo-color': 'rgba(0,0,0,0.8)',
                'text-halo-width': 1.5
            }
        });
    }

    return plumes;
}

// ── UI wiring ──

// per-source visibility toggles
document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const on = btn.classList.toggle('active');
        const layerId = `plumes-${btn.dataset.src}`;
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
    });
});

// sector / year / rate filter button groups
for (const key of ['sec', 'year', 'rate']) {
    const btns = document.querySelectorAll(`[data-${key}]`);
    btns.forEach(btn => btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setFilter(key, btn.dataset[key]);
    }));
}

document.getElementById('ogim-toggle').addEventListener('change', e => {
    toggleOGIM(e.target.checked);
    refreshNearby();
});

document.getElementById('collapse-toggle').addEventListener('click', () => {
    document.getElementById('left-panel').classList.toggle('collapsed');
});

document.getElementById('legend-collapse').addEventListener('click', () => {
    document.getElementById('legend').classList.toggle('collapsed');
});

function updateMapCentre() {
    const c = map.getCenter();
    document.getElementById('map-centre').textContent = `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
}
map.on('move', () => { updateMapCentre(); updateOgimToggleEnabled(); });
map.on('load', () => { updateMapCentre(); updateOgimToggleEnabled(); });
