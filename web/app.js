// ---------------------------------------------------------------------------
// Firedamp plume map — MapLibre GL
// ---------------------------------------------------------------------------

const SRC_COLORS = {
    cm:   '#00ffff',
    imeo: '#ff00ff',
    sron: '#ffff00'
};

const SRC_LABELS = {
    cm:   'Carbon Mapper',
    imeo: 'IMEO / MARS',
    sron: 'SRON'
};

// ---------------------------------------------------------------------------
// AI analysis — routed through the firedamp-api Cloudflare Worker, which
// holds the OpenRouter key as a server secret and caches every response in
// D1. See worker/README for setup. The Worker emits OpenRouter-shaped SSE.
// ---------------------------------------------------------------------------

const FIREDAMP_API = (() => {
    // Override for local Worker development: ?api=local
    if (new URLSearchParams(location.search).get('api') === 'local') {
        return 'http://localhost:8787';
    }
    return document.querySelector('meta[name="firedamp-api"]')?.content?.trim() || '';
})();
const OPENROUTER_MODEL_LABEL = 'Qwen3-VL';

let analysisRequestId = 0;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let plumesData = null;       // raw plumes array from plumes.json
let activeSources = new Set(['cm', 'imeo', 'sron']);
let activeSector = 'all';
let activeYear = 'all';
let activeRate = 'all';
let ogimVisible = false;
let selectedFeature = null;
let overlappingFeatures = [];
let overlapIndex = 0;

// ---------------------------------------------------------------------------
// Plume permalink helpers — #plume=<id> (standalone, no map coords needed)
// ---------------------------------------------------------------------------

function setPlumeHash(id) {
    const target = id ? '#plume=' + encodeURIComponent(id) : '';
    if (location.hash === target) return;
    if (id) {
        history.replaceState(null, '', target);
    } else {
        history.replaceState(null, '', location.pathname + location.search);
    }
}

function getPlumeHash() {
    const m = location.hash.match(/plume=([^&]*)/);
    return m ? decodeURIComponent(m[1]) : null;
}

// ---------------------------------------------------------------------------
// PMTiles protocol — must be registered before map creation
// ---------------------------------------------------------------------------

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const ogimBucket = document.querySelector('meta[name="ogim-bucket"]')?.content;
const ogimUrl = ogimBucket ? `${ogimBucket}/ogim.pmtiles` : 'data/ogim.pmtiles';

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
            satellite: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            },
            labels: {
                type: 'vector',
                url: 'https://tiles.openfreemap.org/planet',
                attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://openstreetmap.org">OSM</a>'
            }
        },
        layers: [
        {
            id: 'basemap',
            type: 'raster',
            source: 'satellite',
            paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.65 }
        },
        {
            id: 'country-borders',
            type: 'line',
            source: 'labels',
            'source-layer': 'boundary',
            filter: ['==', ['get', 'admin_level'], 2],
            paint: {
                'line-color': 'rgba(255, 255, 255, 0.25)',
                'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.5]
            }
        },
        {
            id: 'country-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['==', ['get', 'class'], 'country'],
            minzoom: 2,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 14],
                'text-transform': 'uppercase',
                'text-letter-spacing': 0.15,
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.85)',
                'text-halo-color': 'rgba(0, 0, 0, 0.6)',
                'text-halo-width': 1.5
            }
        },
        {
            id: 'state-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['==', ['get', 'class'], 'state'],
            minzoom: 4,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 12],
                'text-letter-spacing': 0.1,
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.6)',
                'text-halo-color': 'rgba(0, 0, 0, 0.5)',
                'text-halo-width': 1
            }
        },
        {
            id: 'city-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
            minzoom: 4,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14, 14, 18],
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.9)',
                'text-halo-color': 'rgba(0, 0, 0, 0.6)',
                'text-halo-width': 1.5
            }
        },
        {
            id: 'village-labels',
            type: 'symbol',
            source: 'labels',
            'source-layer': 'place',
            filter: ['in', ['get', 'class'], ['literal', ['village', 'suburb', 'neighbourhood']]],
            minzoom: 10,
            layout: {
                'symbol-sort-key': ['get', 'rank'],
                'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
                'text-font': ['Noto Sans Regular'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 14],
                'text-max-width': 8
            },
            paint: {
                'text-color': 'rgba(255, 255, 255, 0.7)',
                'text-halo-color': 'rgba(0, 0, 0, 0.5)',
                'text-halo-width': 1
            }
        }]
    },
    hash: 'map',
    center: [-98, 39],
    zoom: 4,
    minZoom: 1.5,
    maxZoom: 18
});

map.on('style.load', () => map.setProjection({ type: 'globe' }));

// ---------------------------------------------------------------------------
// Radius expression (log scale)
// ---------------------------------------------------------------------------

const radiusExpr = [
    'interpolate', ['linear'],
    ['ln', ['+', ['get', 'rate'], 1]],
    Math.log(501),   3,
    Math.log(1001),  5,
    Math.log(5001),  8,
    Math.log(10001), 12
];

// ---------------------------------------------------------------------------
// Build GeoJSON from plumes array
// ---------------------------------------------------------------------------

function plumesToGeoJSON(plumes) {
    return {
        type: 'FeatureCollection',
        features: plumes.map(p => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
            properties: p
        }))
    };
}

// ---------------------------------------------------------------------------
// Filter expression
// ---------------------------------------------------------------------------

function buildFilter(src) {
    const filters = ['all', ['==', ['get', 'src'], src]];
    if (activeSector !== 'all') {
        filters.push(['==', ['get', 'sec'], activeSector]);
    }
    if (activeYear === 'pre2023') {
        filters.push(['<', ['slice', ['get', 'dt'], 0, 4], '2023']);
    } else if (activeYear !== 'all') {
        filters.push(['==', ['slice', ['get', 'dt'], 0, 4], activeYear]);
    }
    if (activeRate !== 'all') {
        filters.push(['>=', ['get', 'rate'], Number(activeRate) * 1000]);
    }
    return filters;
}

// ---------------------------------------------------------------------------
// Apply filters to all plume layers
// ---------------------------------------------------------------------------

function applyFilters() {
    for (const src of ['cm', 'imeo', 'sron']) {
        const layerId = `plumes-${src}`;
        if (!map.getLayer(layerId)) continue;
        map.setFilter(layerId, buildFilter(src));
    }
}


// ---------------------------------------------------------------------------
// Binary parser
// ---------------------------------------------------------------------------

function parsePlumes(buffer) {
    const view = new DataView(buffer);
    let offset = 0;

    // Magic
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'FDP1') throw new Error('Invalid plumes binary');
    offset = 4;

    // Plume count
    const count = view.getUint32(offset, true);
    offset += 4;

    // Satellite table
    const satCount = view.getUint8(offset);
    offset += 1;
    const satTable = [];
    for (let i = 0; i < satCount; i++) {
        const len = view.getUint8(offset);
        offset += 1;
        satTable.push(new TextDecoder().decode(new Uint8Array(buffer, offset, len)));
        offset += len;
    }

    // Records
    const SRC_NAMES = ['cm', 'imeo', 'sron'];
    const SEC_NAMES = [null, 'og', 'coal', 'waste', 'other'];
    const EPOCH = Date.UTC(2020, 0, 1);
    const DAY_MS = 86400000;

    const plumes = new Array(count);
    for (let i = 0; i < count; i++) {
        const base = offset + i * 20;
        const lat = view.getFloat32(base, true);
        const lon = view.getFloat32(base + 4, true);
        const days = view.getUint16(base + 8, true);
        const rate = view.getUint32(base + 10, true);
        const unc = view.getUint32(base + 14, true);
        const srcSec = view.getUint8(base + 18);
        const satIdx = view.getUint8(base + 19);

        const src = SRC_NAMES[srcSec & 0x03];
        const sec = SEC_NAMES[(srcSec >> 2) & 0x07];
        const dt = new Date(EPOCH + days * DAY_MS).toISOString().slice(0, 10);
        const sat = satTable[satIdx];

        const p = { lat, lon, dt, rate, src, sat };
        if (unc) p.unc = unc;
        if (sec) p.sec = sec;
        plumes[i] = p;
    }

    // IDs block — SRON IDs use "display|link" composite format
    const idsOffset = offset + count * 20;
    const ids = new TextDecoder().decode(new Uint8Array(buffer, idsOffset)).split('\n');
    for (let i = 0; i < count; i++) {
        const raw = ids[i];
        const pipe = raw.indexOf('|');
        if (pipe !== -1) {
            plumes[i].id = raw.substring(0, pipe);
            plumes[i].link = raw.substring(pipe + 1);
        } else {
            plumes[i].id = raw;
        }
    }

    return plumes;
}

// ---------------------------------------------------------------------------
// Data loading & layer setup
// ---------------------------------------------------------------------------

map.on('load', async () => {
    // Load binary data
    const buf = await fetch('data/plumes.bin').then(r => r.arrayBuffer());
    plumesData = parsePlumes(buf);

    // OGIM layers (hidden by default, rendered below plumes)
    await addOGIMLayers();

    // ----- Custom overlay layers via ?layer=<slug> -----
    const layerSlug = new URLSearchParams(location.search).get('layer');
    let customLayer = null;

    if (layerSlug && typeof CUSTOM_LAYERS !== 'undefined' && CUSTOM_LAYERS[layerSlug]) {
        customLayer = CUSTOM_LAYERS[layerSlug];
        const color = customLayer.color || '#00ff00';

        // Resolve site coordinates for proximity filtering: [[lon, lat], ...]
        let siteCoords = null;
        if (customLayer.sitesUrl) {
            siteCoords = await fetch(customLayer.sitesUrl).then(r => r.json());
        } else if (customLayer.sites) {
            siteCoords = customLayer.sites.map(s => [s.lon, s.lat]);
        }

        // Filter plumes to radius around layer sites
        if (siteCoords && customLayer.filterRadius) {
            const before = plumesData.length;
            const grid = buildSpatialGrid(siteCoords, 0.1);
            plumesData = plumesData.filter(p =>
                isWithinRadius(p.lon, p.lat, grid, 0.1, customLayer.filterRadius)
            );
            console.log(`Layer "${layerSlug}": filtered ${before} plumes → ${plumesData.length} within ${customLayer.filterRadius} km of ${siteCoords.length} sites`);
        }

        // OGIM operator highlight layers (rendered above base OGIM, below plumes)
        if (customLayer.ogimOperators && map.getSource('ogim')) {
            const opFilter = ['in', ['get', 'OPERATOR'], ['literal', customLayer.ogimOperators]];
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

        // Static site markers with labels (for layers with explicit sites)
        if (customLayer.sites) {
            const sitesGeoJSON = {
                type: 'FeatureCollection',
                features: customLayer.sites.map(s => ({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
                    properties: { name: s.name }
                }))
            };
            map.addSource('custom-layer', { type: 'geojson', data: sitesGeoJSON });
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
    }

    // Add plumes source (single GeoJSON, split into per-source layers)
    const geojson = plumesToGeoJSON(plumesData);
    map.addSource('plumes', { type: 'geojson', data: geojson });

    // One circle layer per source for independent toggling
    for (const src of ['cm', 'imeo', 'sron']) {
        map.addLayer({
            id: `plumes-${src}`,
            type: 'circle',
            source: 'plumes',
            filter: buildFilter(src),
            paint: {
                'circle-radius': radiusExpr,
                'circle-color': SRC_COLORS[src],
                'circle-opacity': 0,
                'circle-stroke-color': SRC_COLORS[src],
                'circle-stroke-width': 1.5,
                'circle-stroke-opacity': 0.75
            }
        });
    }

    // Highlight ring for selected plume
    map.addSource('plume-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'plume-highlight',
        type: 'circle',
        source: 'plume-highlight',
        paint: {
            'circle-radius': 18,
            'circle-color': 'transparent',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2.5,
            'circle-stroke-opacity': 0.9
        }
    });

    // Interactions
    setupInteractions();

    // Restore plume from permalink
    const linkedId = getPlumeHash();
    if (linkedId) {
        const match = plumesData.find(p => p.id === linkedId);
        if (match) {
            const feat = {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [match.lon, match.lat] },
                properties: match
            };
            showDetail(feat, true);
            map.flyTo({ center: [match.lon, match.lat], zoom: Math.max(map.getZoom(), 15) });
        }
    }

});

// ---------------------------------------------------------------------------
// OGIM infrastructure layers
// ---------------------------------------------------------------------------

function createOGIMIcons() {
    const canvas = document.createElement('canvas');
    const ctxOpts = { willReadFrequently: true };

    // × icon for wells
    const ws = 16;
    canvas.width = ws; canvas.height = ws;
    const wctx = canvas.getContext('2d', ctxOpts);
    wctx.clearRect(0, 0, ws, ws);
    wctx.strokeStyle = 'white';
    wctx.lineWidth = 2;
    wctx.lineCap = 'round';
    const wp = 4;
    wctx.beginPath();
    wctx.moveTo(wp, wp); wctx.lineTo(ws - wp, ws - wp);
    wctx.moveTo(ws - wp, wp); wctx.lineTo(wp, ws - wp);
    wctx.stroke();
    const wd = wctx.getImageData(0, 0, ws, ws);
    map.addImage('well-x', { width: ws, height: ws, data: wd.data });

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
    const fd = fctx.getImageData(0, 0, fs, fs);
    map.addImage('facility-diamond', { width: fs, height: fs, data: fd.data });
}

async function addOGIMLayers() {
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
            paint: {
                'icon-opacity': 0.8
            }
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
            paint: {
                'icon-opacity': 0.6
            }
        });
        // Invisible preload layers — keep tiles loaded for proximity queries
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

// ---------------------------------------------------------------------------
// Proximity helpers
// ---------------------------------------------------------------------------

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Only filter clearly defunct features. 'N/A' on FAC_TYPE is common for
// facilities whose role is captured in CATEGORY instead (e.g. GATHERING AND
// PROCESSING plants like Ladder Creek) and on plenty of active wells too —
// dropping them used to leave the AI pipeline with an empty nearby list even
// when a named facility was sitting right under the plume.
const SKIP_TYPES = new Set(['DRY HOLE', 'UNKNOWN', '']);
const SKIP_STATUSES = new Set(['ABANDONED', 'INACTIVE']);

function findNearbyInfra(lon, lat, { maxResults = 12, radiusKm = 2 } = {}) {
    if (!map.getSource('ogim')) return [];
    const results = [];
    const seen = new Set();
    for (const sourceLayer of ['facilities', 'wells', 'pipelines']) {
        const features = map.querySourceFeatures('ogim', { sourceLayer });
        for (const f of features) {
            const id = f.properties.OGIM_ID;
            if (seen.has(id)) continue;
            seen.add(id);
            const type = (f.properties.FAC_TYPE || '').trim();
            const status = (f.properties.OGIM_STATUS || '').trim();
            if (SKIP_TYPES.has(type) || SKIP_STATUSES.has(status)) continue;

            // Pipelines are LineString / MultiLineString — find the closest vertex.
            // Wells / facilities are Points.
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

// Wait for OGIM tiles around (lon,lat) to load, then return nearby infra.
// Used by the AI pipeline so it works regardless of the visual toggle state.
//
// Opening a plume from a permalink triggers a flyTo() in parallel with the
// analysis pipeline; if we only wait for `map.loaded()` we can race the flyTo
// and end up querying tiles before they arrive, returning an empty list even
// when OGIM has matching features. Re-querying after each idle event until we
// either find features or hit a 7 s budget catches that race.
async function loadNearbyInfra(lon, lat, opts = {}) {
    if (!map.getSource('ogim')) return [];
    const deadline = Date.now() + 7000;
    let items = [];
    while (Date.now() < deadline) {
        await Promise.race([
            new Promise(r => map.once('idle', r)),
            new Promise(r => setTimeout(r, 1500)),
        ]);
        // Force tile loading at the plume location regardless of the OGIM
        // visibility toggle. Wells/facilities/pipelines live in separate
        // source layers so querying each one is what kicks off the fetch.
        map.querySourceFeatures('ogim', { sourceLayer: 'wells' });
        map.querySourceFeatures('ogim', { sourceLayer: 'facilities' });
        map.querySourceFeatures('ogim', { sourceLayer: 'pipelines' });
        items = findNearbyInfra(lon, lat, opts);
        if (items.length > 0) return items;
    }
    return items;
}

function formatDist(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
}

function nearbyMarkup(nearby) {
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

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Spatial grid for fast proximity filtering (custom layers)
// ---------------------------------------------------------------------------

function buildSpatialGrid(sites, cellDeg) {
    const grid = new Map();
    for (const [lon, lat] of sites) {
        const key = Math.floor(lon / cellDeg) + ',' + Math.floor(lat / cellDeg);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push([lon, lat]);
    }
    return grid;
}

function isWithinRadius(lon, lat, grid, cellDeg, radiusKm) {
    const cx = Math.floor(lon / cellDeg);
    const cy = Math.floor(lat / cellDeg);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const cell = grid.get((cx + dx) + ',' + (cy + dy));
            if (!cell) continue;
            for (const [slon, slat] of cell) {
                if (haversineKm(lat, lon, slat, slon) <= radiusKm) return true;
            }
        }
    }
    return false;
}

const OGIM_MIN_ZOOM = 6;

function toggleOGIM(visible) {
    ogimVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['ogim-wells', 'ogim-pipelines', 'ogim-facilities']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    document.getElementById('legend-infra').style.display = visible ? 'block' : 'none';
    // Refresh nearby infra section only (avoid re-running AI analysis)
    if (selectedFeature) {
        const p = selectedFeature.properties;
        const nearby = findNearbyInfra(Number(p.lon), Number(p.lat));
        const el = document.getElementById('detail-nearby');
        if (el) el.innerHTML = nearbyMarkup(nearby);
    }
}

// OGIM PMTiles minzoom is 6. Below that the toggle has no effect, so disable
// it with a tooltip explaining why; auto-uncheck if the user zooms out while
// it's on, so the legend stays honest.
function updateOgimToggleEnabled() {
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

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

function setupInteractions() {
    const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'plume-popup',
        offset: 10
    });

    const plumeLayers = ['plumes-cm', 'plumes-imeo', 'plumes-sron'];

    // Hover
    for (const layer of plumeLayers) {
        map.on('mouseenter', layer, e => {
            map.getCanvas().style.cursor = 'pointer';
            const f = e.features[0];
            const p = f.properties;
            const rateThr = (Number(p.rate) / 1000).toFixed(1);
            const date = p.dt || '';
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${rateThr} t/hr</strong><br>${SRC_LABELS[p.src] || p.src}${date ? ' · ' + date : ''}`)
                .addTo(map);
        });

        map.on('mousemove', layer, e => {
            popup.setLngLat(e.lngLat);
        });

        map.on('mouseleave', layer, () => {
            map.getCanvas().style.cursor = '';
            popup.remove();
        });
    }

    // Click
    map.on('click', e => {
        const tolerance = 10;
        const bbox = [
            [e.point.x - tolerance, e.point.y - tolerance],
            [e.point.x + tolerance, e.point.y + tolerance]
        ];
        const activeLayers = plumeLayers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
        const features = map.queryRenderedFeatures(bbox, { layers: activeLayers });

        if (features.length === 0) {
            closeDetail();
            return;
        }

        // Sort by distance to click, stash all for overlap navigation
        features.sort((a, b) => {
            const [aLng, aLat] = a.geometry.coordinates;
            const [bLng, bLat] = b.geometry.coordinates;
            return Math.hypot(aLng - e.lngLat.lng, aLat - e.lngLat.lat)
                 - Math.hypot(bLng - e.lngLat.lng, bLat - e.lngLat.lat);
        });
        overlappingFeatures = features;
        overlapIndex = 0;

        showDetail(features[0]);
        const fp = features[0].properties;
        map.flyTo({
            center: [Number(fp.lon), Number(fp.lat)],
            zoom: Math.max(map.getZoom(), 15)
        });
    });

    // OGIM hover — use queryRenderedFeatures for reliable hit detection with overzoomed tiles
    const ogimLayers = ['ogim-facilities', 'ogim-wells', 'ogim-pipelines'];
    let ogimHover = false;
    map.on('mousemove', e => {
        if (!ogimVisible) return;
        const layers = ogimLayers.filter(l => map.getLayer(l));
        if (!layers.length) return;
        const bbox = [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]];
        const features = map.queryRenderedFeatures(bbox, { layers });
        if (features.length > 0) {
            map.getCanvas().style.cursor = 'pointer';
            const f = features[0];
            const p = f.properties;
            const layer = f.layer.id;
            let html;
            if (layer === 'ogim-wells') {
                const type = p.FAC_TYPE || 'Well';
                const detail = [p.OPERATOR, p.COUNTRY, p.OGIM_STATUS].filter(Boolean).join(' \u00b7 ');
                html = `<strong>${type}</strong>${detail ? '<br>' + detail : ''}`;
            } else if (layer === 'ogim-pipelines') {
                const type = p.FAC_TYPE || 'Pipeline';
                const detail = [p.OPERATOR, p.COUNTRY, p.OGIM_STATUS].filter(Boolean).join(' \u00b7 ');
                html = `<strong>${type}</strong>${detail ? '<br>' + detail : ''}`;
            } else {
                const name = p.FAC_NAME || p.OPERATOR || p.CATEGORY || 'Facility';
                const detail = [p.FAC_TYPE, p.COUNTRY, p.OGIM_STATUS].filter(Boolean).join(' \u00b7 ');
                html = `<strong>${name}</strong>${detail ? '<br>' + detail : ''}`;
            }
            popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
            ogimHover = true;
        } else if (ogimHover) {
            map.getCanvas().style.cursor = '';
            popup.remove();
            ogimHover = false;
        }
    });
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function sourceUrl(src, id, link) {
    if (!id || id === '\u2014') return null;
    switch (src) {
        case 'cm': return `https://data.carbonmapper.org/?plume_id=${encodeURIComponent(id)}`;
        case 'sron': return link ? `https://ftp.sron.nl/pub/memo/CSVs/${encodeURIComponent(link)}` : null;
        default: return null;
    }
}

function highlightPlume(lon, lat) {
    const src = map.getSource('plume-highlight');
    if (src) src.setData({ type: 'FeatureCollection', features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }
    ]});
}

function clearHighlight() {
    const src = map.getSource('plume-highlight');
    if (src) src.setData({ type: 'FeatureCollection', features: [] });
}

function showDetail(feature, fromPermalink) {
    selectedFeature = feature;
    const p = feature.properties;
    if (!fromPermalink) setPlumeHash(p.id);
    // Use properties (exact) rather than geometry.coordinates (quantized by tile grid at low zoom)
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    highlightPlume(lon, lat);

    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    const coordStr = `${Math.abs(lat).toFixed(4)}\u00b0${latDir}, ${Math.abs(lon).toFixed(4)}\u00b0${lonDir}`;

    const rateThr = (Number(p.rate) / 1000).toFixed(1);
    const plumeId = p.id || '\u2014';
    const href = sourceUrl(p.src, plumeId, p.link);

    const srcClass = p.src || 'cm';
    const srcLabel = SRC_LABELS[p.src] || p.src;

    // Find nearby infrastructure (best-effort, may be empty if OGIM tiles not yet loaded).
    // Populated below via loadNearbyInfra() after panel is shown.
    const nearby = findNearbyInfra(lon, lat);
    const nearbyHtml = `<div id="detail-nearby">${nearbyMarkup(nearby)}</div>`;

    const n = overlappingFeatures.length;
    const navHtml = n > 1
        ? `<div class="overlap-nav"><button class="overlap-btn" onclick="overlapPrev()">&lsaquo;</button><span class="overlap-count">${overlapIndex + 1} / ${n}</span><button class="overlap-btn" onclick="overlapNext()">&rsaquo;</button></div>`
        : '';

    const panel = document.getElementById('right-panel');
    panel.innerHTML = `
        <div class="detail-header">
            <div class="detail-header-text">
                ${href ? `<a class="detail-id" href="${href}" target="_blank" rel="noopener">${plumeId}</a>` : `<span class="detail-id">${plumeId}</span>`}
                <span class="detail-coords">${coordStr}</span>
            </div>
            ${navHtml}
            <button class="close-btn" onclick="closeDetail()">&times;</button>
        </div>
        <div class="detail-badges">
            <span class="source-badge ${srcClass}">${srcLabel}</span>
            ${p.sec ? `<span class="sector-badge">${sectorLabel(p.sec)}</span>` : ''}
        </div>
        <div class="stats-grid">
            <div class="stat"><div class="stat-big">${rateThr}</div><div class="stat-unit">t/hr</div></div>
            <div class="stat" id="stat-wind"><div class="stat-big stat-wind-big">\u2026</div><div class="stat-unit">wind</div></div>
            <div class="stat"><div class="stat-big">${p.sat || '\u2014'}</div><div class="stat-unit">satellite</div></div>
            <div class="stat"><div class="stat-big">${p.dt || '\u2014'}</div><div class="stat-unit">date</div></div>
        </div>
        ${p.cty ? `<div class="detail-row"><div class="detail-field"><span class="detail-field-label">Country</span><span class="detail-field-value">${p.cty}</span></div></div>` : ''}
        ${nearbyHtml}
        <div class="enrich-section">
            <div class="enrich-section-label">
                <span>Analysis</span>
                <button class="enrich-regenerate" onclick="regenerateAnalysis()" title="Regenerate (skip cache)">↻</button>
            </div>
            <div id="enrich-results" class="enrich-loading">Loading…</div>
        </div>
    `;
    panel.classList.remove('hidden');

    runPlumeAnalysis(feature);
}

function closeDetail() {
    selectedFeature = null;
    overlappingFeatures = [];
    overlapIndex = 0;
    analysisRequestId++;     // invalidate any in-flight LLM stream
    setPlumeHash(null);
    clearHighlight();
    document.getElementById('right-panel').classList.add('hidden');
}

function sectorLabel(sec) {
    const labels = { og: 'Oil & Gas', coal: 'Coal', waste: 'Waste', other: 'Other' };
    return labels[sec] || sec || '\u2014';
}

function flyToInfra(lon, lat) {
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14) });
}

function overlapNext() {
    if (overlappingFeatures.length < 2) return;
    overlapIndex = (overlapIndex + 1) % overlappingFeatures.length;
    showDetail(overlappingFeatures[overlapIndex]);
}

function overlapPrev() {
    if (overlappingFeatures.length < 2) return;
    overlapIndex = (overlapIndex - 1 + overlappingFeatures.length) % overlappingFeatures.length;
    showDetail(overlappingFeatures[overlapIndex]);
}

// Make functions globally accessible for onclick
window.closeDetail = closeDetail;
window.flyToInfra = flyToInfra;
window.overlapNext = overlapNext;
window.overlapPrev = overlapPrev;

// ---------------------------------------------------------------------------
// AI plume analysis — one annotated Esri map (OGIM/OSM pins) → Qwen3-VL via OpenRouter
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

function buildOverpassQuery(south, west, north, east) {
    const bbox = `${south},${west},${north},${east}`;
    return `[out:json][timeout:25];(
        nwr["man_made"="petroleum_well"](${bbox});
        nwr["man_made"="pipeline"](${bbox});
        nwr["man_made"="storage_tank"](${bbox});
        nwr["man_made"="works"](${bbox});
        nwr["man_made"="gasometer"](${bbox});
        nwr["industrial"="oil"](${bbox});
        nwr["industrial"="gas"](${bbox});
        nwr["industrial"="refinery"](${bbox});
        nwr["industrial"="wellsite"](${bbox});
        nwr["industrial"="mine"](${bbox});
        nwr["landuse"="industrial"](${bbox});
        nwr["landuse"="quarry"](${bbox});
        nwr["landuse"="landfill"](${bbox});
        nwr["power"="plant"](${bbox});
        nwr["plant:source"~"gas|oil|coal"](${bbox});
        nwr["amenity"="waste_transfer_station"](${bbox});
        nwr["amenity"="recycling"]["recycling_type"="centre"](${bbox});
        nwr["pipeline"="substation"](${bbox});
        nwr["substance"~"gas|oil|petroleum|natural_gas"](${bbox});
        nwr["aeroway"="aerodrome"](${bbox});
    );out center tags;`;
}

function summariseOsmElements(elements, plumeLat, plumeLon) {
    const items = [];
    const seen = new Set();
    for (const el of elements) {
        if (!el.tags) continue;
        const name = el.tags['name:en'] || el.tags.name || '';
        const lat = el.center ? el.center.lat : el.lat;
        const lon = el.center ? el.center.lon : el.lon;
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
            ? haversineMetres(plumeLat, plumeLon, lat, lon) : null;
        items.push({ osmId: `${el.type}/${el.id}`, name, lat, lon, tags: keep, dist });
    }
    // Sort by distance ascending so the LLM sees the closest entries first.
    items.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
    return items.slice(0, 60);
}

// Great-circle distance in metres. Used to sort OSM features near the plume
// so the LLM sees the closest matches first (mirroring the OGIM list).
function haversineMetres(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Reverse geocode via Nominatim — gives the LLM an authoritative place name
// (town, region, country) so it doesn't have to guess from raw lat/lon.
async function reverseGeocode(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1&accept-language=en`;
    try {
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data || !data.address) return null;
        const a = data.address;
        // Build a short, readable hierarchy: locality, region, country
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

// Compass label for a direction in degrees (0 = N, 90 = E, ...). Wind is by
// meteorological convention "direction the wind is coming FROM".
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function compass(deg) {
    if (deg == null || isNaN(deg)) return '';
    return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// Daily-mean surface wind at the plume coordinate from Open-Meteo's historical
// archive (no API key, CORS-friendly). Returns the daily vector mean so brief
// gusts in random directions don't dominate. Useful for the "upwind" reasoning,
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
        // Vector-mean wind. wind_direction is "FROM", convert to "TO" for
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

async function queryOverpass(south, west, north, east) {
    const query = buildOverpassQuery(south, west, north, east);
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

// ── Per-source spatial-uncertainty model ──
// One artifact, sized to the data. SRON/TROPOMI is the hard case: the ground
// pixel is ~5.5×7 km and the plume drifts before it is imaged, so the true leak
// sits anywhere within several km of the marker (≈2 km for a large isolated
// emitter, 10 km+ in cluttered areas), almost always upwind — hence windBias,
// which shifts the map frame upwind so the search area fills it.
//   ringM    radius of the dashed uncertainty circle drawn on the map (m)
//   viewM    half-width of the map frame (m); span ≈ 2·viewM
//   searchKm radius to gather OGIM/OSM candidates (km)
function plumeUncertainty(p) {
    const sat = String(p.sat || '').toUpperCase();
    if (p.src === 'cm') {
        if (/AVIRIS|GAO|AV3|AV20/.test(sat))
            return { ringM: 30, viewM: 80, searchKm: 1, windBias: false,
                note: 'Airborne hyperspectral sensor with metre-scale pixels: the coordinate is precise to within a few tens of metres — the source is essentially at the ⊕.' };
        if (/TANAGER|ENMAP/.test(sat))
            return { ringM: 45, viewM: 130, searchKm: 1, windBias: false,
                note: 'Satellite sensor with ~30 m pixels: the coordinate is accurate to within ~50 m.' };
        return { ringM: 100, viewM: 320, searchKm: 1.5, windBias: false,
            note: 'Satellite sensor with ~60 m pixels: the coordinate is accurate to within ~100 m.' };
    }
    if (p.src === 'imeo')
        return { ringM: 600, viewM: 1600, searchKm: 2.5, windBias: false,
            note: 'Detecting sensors range from ~25 m pixels to TROPOMI’s ~5.5×7 km. The coordinate is analyst-vetted: within ~500 m for high-resolution sensors, up to a few km when TROPOMI-derived.' };
    if (p.src === 'sron')
        return { ringM: 4000, viewM: 5500, searchKm: 11, windBias: true,
            note: 'This is a TROPOMI detection. Its ground pixel is ~5.5×7 km and the plume drifts before being imaged, so the true source can lie several km from the ⊕ — roughly 2 km for a large isolated emitter, commonly 10 km or more in cluttered areas — and almost always UPWIND. Treat the ⊕ as the centre of a search area (the dashed circle), not the source itself.' };
    return { ringM: 300, viewM: 1200, searchKm: 2, windBias: false, note: '' };
}

// Move distM metres from (lat, lon) along a compass bearing. Used to shift the
// SRON map frame upwind (bearing = wind's "from" direction).
function offsetLatLon(lat, lon, distM, bearingDeg) {
    const br = bearingDeg * Math.PI / 180;
    return {
        lat: lat + (distM * Math.cos(br)) / 111320,
        lon: lon + (distM * Math.sin(br)) / (111320 * Math.cos(lat * Math.PI / 180)),
    };
}

function fmtMetres(m) {
    if (m == null) return '?';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// Pick the most descriptive single type tag for an OSM feature.
const OSM_TYPE_KEYS = ['man_made', 'industrial', 'power', 'plant:source',
                       'substance', 'landuse', 'amenity', 'aeroway', 'pipeline'];
function osmShortType(tags) {
    for (const k of OSM_TYPE_KEYS) if (tags[k]) return String(tags[k]).replace(/_/g, ' ');
    return 'site';
}

// Merge OGIM + OSM into one numbered candidate list shared by the map pins and
// the text KEY, so every number on the image has a matching key entry. Closest
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
        const label = [name, type, f.tags.operator].filter(Boolean).join(' · ');
        cands.push({ id: `OSM:${f.osmId}`, kind, lat: f.lat, lon: f.lon, dist: f.dist ?? null, label, geometry: null });
    }
    const margin = viewM * 1.05;
    return cands
        .filter(c => haversineMetres(centerLat, centerLon, c.lat, c.lon) <= margin)
        .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))
        .slice(0, max)
        .map((c, i) => ({ ...c, n: i + 1 }));
}

function formatCandidateKey(cands) {
    if (!cands.length) return 'No catalogued infrastructure in the frame.';
    return cands.map(c => `${c.n}. ${c.id} — ${c.label || c.kind} · ${fmtMetres(c.dist)}`).join('\n');
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

// One clean artifact: an annotated satellite map plus a text KEY. The model is
// trusted to read the imagery and judge for itself, rather than being walked
// through a rulebook.
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
        ? `Daily-mean surface wind was ${wind.speed.toFixed(1)} m/s from the ${compass(wind.fromDeg)} (the arrow shows the way the plume drifts), so the source should lie upwind, toward the ${compass(wind.fromDeg)}.`
        : '';
    const pipeNote = candidates.some(c => c.kind === 'pipeline') ? ' Yellow lines are pipelines.' : '';

    return `You are a methane source-attribution analyst. You are shown one annotated satellite map and the full record that OpenStreetMap and the OGIM oil-&-gas inventory hold for this spot (the KEY). Use your own judgement.

A ${src} satellite (${sat}) measured a ${rateThr} t/hr methane plume near ${lat}°, ${lon}° in ${placeStr} on ${date}.${sector ? ' ' + sector : ''}

THE MAP
A satellite image about ${spanKm} km across. The pink ⊕ marks the reported detection coordinate. ${unc.note}${windLine ? ' ' + windLine : ''} Numbered pins are nearby infrastructure, listed in the KEY.${pipeNote}

KEY (nearest the ⊕ first — copy an id verbatim into attributed_id)
${formatCandidateKey(candidates)}

Identify the single most likely source. Read the imagery first; the pins only supply names and ids. Rank candidates by typical likelihood: gas/processing plants, compressor stations and flares > wellheads, tanks, separators, dehydrators > buried pipelines and gathering lines, which vent far less — fall back to a pipeline only when nothing else is plausible. A coal mine or landfill in frame usually outranks everything.${wind ? ' Favour candidates upwind of the ⊕.' : ''} If the frame shows no plausible source, say so plainly.

Reply with ONLY this JSON object: {"source_label":…, "source_kind":…, "attributed_id":…, "paragraph":…}
- source_label: ≤8 words, plain English for a journalist (e.g. "Caerus Uinta gas well", "Unlabelled tank battery", "Sanitary landfill", "No obvious source nearby"). Never an id or a field name.
- source_kind: one of well, facility, pipeline, mine, landfill, other, none.
- attributed_id: an OGIM:/OSM: id copied verbatim from the KEY, or null when the visible source isn't listed. Never invent ids.
- paragraph: 1–3 plain sentences naming the source and the visible evidence. No rejected hypotheses, no mention of the pins/overlay, no web claims.`;
}

// ── Esri imagery snapshot (2x2 tile grid) with plume + OGIM overlay ──
function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const x = (lon + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
}

// Pin colours by kind. Each candidate is drawn as a numbered disc keyed to the
// text KEY in the prompt.
const PIN_FILL = { well: '#ffffff', facility: '#ffc861', pipeline: '#ffe664', mine: '#c9a0ff', landfill: '#9be39b', other: '#7ecbff' };

// One annotated satellite map: Esri imagery framed to the plume's spatial
// uncertainty, with a dashed uncertainty ring, a wind arrow, the detection ⊕,
// and numbered pins for the supplied candidates. Returns a JPEG data URL.
async function captureAnnotatedMap({ centerLon, centerLat, plumeLon, plumeLat, viewM, ringM, candidates = [], wind = null }) {
    centerLon = ((centerLon + 180) % 360 + 360) % 360 - 180;

    // Choose zoom + grid so the frame spans ~2·viewM, keeping detail by using a
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
            loads.push(new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { ctx.drawImage(img, dx * TILE, dy * TILE); resolve(); };
                // A missing tile (common at the highest zooms) shouldn't sink the
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

    // Pipelines first, so pins land on top.
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

    // Dashed uncertainty ring around the detection coordinate.
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

    // Wind arrow from the detection coordinate, pointing the way the plume drifts.
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
        ctx.fillText('wind', ex + dx * 8, ey + dy * 8);
    }

    // Numbered candidate pins.
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

    // Detection coordinate — magenta ⊕ on top of everything.
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
    return renderAnalysisStructured(p);
}

function renderAnalysisStructured({ source_label, attributed_id, paragraph }) {
    const labelHtml = sourceLabelHtml(source_label || '', attributed_id);
    return `<div class="enrich-report">
        <div class="enrich-source">${labelHtml}</div>
        ${paragraph ? `<p class="enrich-para">${escapeHtml(paragraph)}</p>` : ''}
    </div>`;
}

// Make an OGIM-attributed source label fly the map to that feature on click.
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

// Find the OGIM feature in the source and fly to it.
function flyToOgim(ogimId) {
    if (!map.getSource('ogim')) return;
    for (const layer of ['facilities', 'wells', 'pipelines']) {
        const features = map.querySourceFeatures('ogim', { sourceLayer: layer });
        for (const f of features) {
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
window.flyToOgim = flyToOgim;

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

function runPlumeAnalysis(feature, { force = false } = {}) {
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

        // Fast path: if the Worker already has a cached analysis for this
        // plume, use it directly and skip Overpass / Nominatim / Open-Meteo
        // / image capture / OpenRouter entirely. This is what makes
        // re-opening a previously-analysed plume effectively free.
        if (!force && FIREDAMP_API) {
            try {
                const peek = await fetch(`${FIREDAMP_API}/api/analysis/${encodeURIComponent(plumeId)}`);
                if (analysisRequestId !== id) return;
                if (peek.ok) {
                    const row = await peek.json();
                    el.innerHTML = renderAnalysisHTML(row.response);
                    if (row.wind_speed != null && row.wind_dir_from != null) {
                        renderWind({
                            speed: row.wind_speed,
                            fromDeg: row.wind_dir_from,
                            toDeg: (row.wind_dir_from + 180) % 360,
                        });
                    } else {
                        renderWind(null);
                    }
                    return;
                }
            } catch (err) {
                // Fall through to full pipeline
                console.warn('peek failed, running full pipeline:', err);
            }
        }

        el.innerHTML = '<div class="enrich-loading">Loading nearby infrastructure and place…</div>';

        // Search radius scales with the source's spatial uncertainty (SRON spans
        // ~11 km). The Overpass box is capped to keep the query from timing out
        // in dense basins; OGIM tiles are local and cheap, so they get the full
        // radius.
        const unc = plumeUncertainty(p);
        const obKm = Math.min(unc.searchKm, 8);
        const dLat = obKm / 111;
        const dLon = obKm / (111 * Math.cos(lat * Math.PI / 180));
        const south = lat - dLat, north = lat + dLat;
        const west = lon - dLon, east = lon + dLon;

        const windPromise = fetchWind(lat, lon, p.dt).then(w => {
            if (analysisRequestId === id) renderWind(w);
            return w;
        });

        const [overpassData, ogimItems, place] = await Promise.all([
            queryOverpass(south, west, north, east),
            loadNearbyInfra(lon, lat, { maxResults: 40, radiusKm: unc.searchKm }),
            reverseGeocode(lat, lon),
        ]);
        if (analysisRequestId !== id) return;

        const osmFeatures = overpassData?.elements ? summariseOsmElements(overpassData.elements, lat, lon) : [];

        // Wind feeds upwind reasoning and, for SRON, biases the map frame, so it
        // is load-bearing here. Open-Meteo is usually already resolved by the
        // time Overpass returns; the slack is a backstop (a touch longer when
        // the frame depends on it). A slow response never permanently blocks.
        const wind = await Promise.race([
            windPromise,
            new Promise(r => setTimeout(() => r(null), unc.windBias ? 2500 : 400)),
        ]);

        // One artifact: frame the map to the uncertainty, shifting it upwind for
        // SRON so the likely-source region fills it. Candidates are numbered for
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

function regenerateAnalysis() {
    if (selectedFeature) runPlumeAnalysis(selectedFeature, { force: true });
}
window.regenerateAnalysis = regenerateAnalysis;

// Render wind into the stats grid. SVG arrow rotates so the head points in the
// direction the wind is blowing TO (i.e. the direction the plume drifts).
function renderWind(wind) {
    const el = document.getElementById('stat-wind');
    if (!el) return;
    if (!wind) {
        el.querySelector('.stat-wind-big').textContent = '—';
        return;
    }
    const speed = wind.speed.toFixed(1);
    const fromLabel = compass(wind.fromDeg);
    el.title = `${speed} m/s from ${fromLabel} (${Math.round(wind.fromDeg)}°)`;
    el.querySelector('.stat-wind-big').innerHTML = `
        <svg class="wind-arrow" viewBox="0 0 24 24" style="transform: rotate(${wind.toDeg}deg)">
            <path d="M12 4 L12 20 M12 4 L7 9 M12 4 L17 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="wind-speed">${speed}</span>`;
}

// ---------------------------------------------------------------------------
// Source toggle buttons
// ---------------------------------------------------------------------------

document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const src = btn.dataset.src;
        btn.classList.toggle('active');
        if (btn.classList.contains('active')) {
            activeSources.add(src);
        } else {
            activeSources.delete(src);
        }
        const layerId = `plumes-${src}`;
        if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility',
                activeSources.has(src) ? 'visible' : 'none');
        }
    });
});

// ---------------------------------------------------------------------------
// Sector filter
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-sec]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-sec]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSector = btn.dataset.sec;
        applyFilters();
    });
});

// ---------------------------------------------------------------------------
// Year filter
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-year]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-year]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeYear = btn.dataset.year;
        applyFilters();
    });
});

// ---------------------------------------------------------------------------
// Rate filter
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-rate]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-rate]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeRate = btn.dataset.rate;
        applyFilters();
    });
});

// ---------------------------------------------------------------------------
// OGIM toggle
// ---------------------------------------------------------------------------

document.getElementById('ogim-toggle').addEventListener('change', e => {
    toggleOGIM(e.target.checked);
});

// ---------------------------------------------------------------------------
// Collapse toggles
// ---------------------------------------------------------------------------

document.getElementById('collapse-toggle').addEventListener('click', () => {
    document.getElementById('left-panel').classList.toggle('collapsed');
});

document.getElementById('legend-collapse').addEventListener('click', () => {
    document.getElementById('legend').classList.toggle('collapsed');
});

// ---------------------------------------------------------------------------
// Map centre display
// ---------------------------------------------------------------------------

function updateMapCentre() {
    const c = map.getCenter();
    document.getElementById('map-centre').textContent =
        `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
}
map.on('move', () => { updateMapCentre(); updateOgimToggleEnabled(); });
map.on('load', () => { updateMapCentre(); updateOgimToggleEnabled(); });

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDetail();
});
