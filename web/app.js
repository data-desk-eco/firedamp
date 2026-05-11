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
const OPENROUTER_MODEL_LABEL = 'Gemma 4';

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
// AI plume analysis — Overpass + OGIM + Esri imagery → Qwen3-VL via OpenRouter
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

function buildOverpassQuery(south, west, north, east) {
    const bbox = `${south},${west},${north},${east}`;
    return `[out:json][timeout:10];(
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

function formatOsmFeatures(features) {
    if (!features.length) return '(none)';
    return features.map(f => {
        const tagPairs = Object.entries(f.tags).map(([k, v]) => `${k}=${v}`).join(', ');
        const name = f.name || '(unnamed)';
        const dist = f.dist != null ? `(${formatDist(f.dist)} away)` : '';
        return `- OSM:${f.osmId}  ${dist}  — ${name} — ${tagPairs}`;
    }).join('\n');
}

// LLM-facing OGIM list: `OGIM:<id>` matches the required attributed_id format
// exactly, and distance is shown prominently so the model doesn't have to
// scan past the type/operator to find it.
function formatOgimInfra(items) {
    if (!items.length) return '(none)';
    return items.map(it => {
        // Name + (type or category) + operator. Status is mostly noise unless
        // it differs from PRODUCING/N/A — keep it short.
        const typeOrCategory = it.type && it.type !== 'N/A' ? it.type : it.category;
        const attrs = [it.name, typeOrCategory, it.operator, (it.status && it.status !== 'N/A') ? it.status : null]
            .filter(Boolean).join(' · ');
        const dist = formatDist(it.dist) || '?';
        return `- OGIM:${it.ogimId}  (${dist} away)  — ${attrs}`;
    }).join('\n');
}

function spatialUncertaintyNote(p) {
    const src = p.src;
    const sat = String(p.sat || '').toUpperCase();
    if (src === 'cm') {
        if (/AVIRIS|GAO|AV3|AV20/.test(sat)) return 'Coordinate is precise to within a few tens of metres.';
        if (/TANAGER/.test(sat)) return 'Coordinate is precise to within ~50 m.';
        if (/EMIT/.test(sat))   return 'Coordinate is precise to within ~100 m.';
        if (/ENMAP/.test(sat))  return 'Coordinate is precise to within ~50 m.';
        return 'Coordinate is precise to within ~100 m.';
    }
    if (src === 'imeo') {
        return 'Coordinate is analyst-vetted; uncertainty is <500 m for high-resolution sensors, several km when TROPOMI-derived.';
    }
    if (src === 'sron') {
        return ('TROPOMI pixel footprint is ~5.5×7 km; the true source can sit several kilometres from the marker, '
              + 'often upwind. Do not require infrastructure directly under the marker — look around the wider scene '
              + 'for a gas plant, compressor station, coal mine vent, or landfill, and suggest checking upwind if relevant.');
    }
    return '';
}

function sectorHintPhrase(sec) {
    switch (sec) {
        case 'og':    return 'The catalogue tags this plume as oil & gas (a well pad, tank battery, compressor, gas plant, or refinery is most likely).';
        case 'coal':  return 'The catalogue tags this plume as coal (a coal mine, vent shaft, or coal processing facility is most likely).';
        case 'waste': return 'The catalogue tags this plume as waste (a landfill, recycling/transfer station, or wastewater plant is most likely).';
        case 'other': return "The catalogue tags this plume as 'other' — sector is unclear.";
        default:      return 'The catalogue does not classify this plume\'s sector.';
    }
}

function buildPlumePrompt(p, osmFeatures, ogimItems, place) {
    const lat = Number(p.lat).toFixed(4);
    const lon = Number(p.lon).toFixed(4);
    const rateThr = (Number(p.rate) / 1000).toFixed(2);
    const date = p.dt || 'unknown';
    const sat = p.sat || 'unknown sensor';
    const src = SRC_LABELS[p.src] || p.src;
    const placeStr = place?.display || 'an unknown location';

    const ogimList = formatOgimInfra(ogimItems);
    const osmList = formatOsmFeatures(osmFeatures);
    const hasOgim = ogimList && ogimList !== '(none)';
    const hasOsm = osmList && osmList !== '(none)';
    const nearbyBlocks = [];
    if (hasOgim) nearbyBlocks.push(`OGIM oil & gas infrastructure within 2 km (coverage is patchy — many real wells/tanks/pipelines are missing):\n${ogimList}`);
    if (hasOsm)  nearbyBlocks.push(`OpenStreetMap features within 2 km:\n${osmList}`);
    const nearby = nearbyBlocks.length ? nearbyBlocks.join('\n\n') : 'No OGIM or OSM entries within 2 km.';

    return `Identify the most likely source of this methane plume.

A ${src} satellite detected a ${rateThr} t/hr methane plume at ${lat}°, ${lon}° in ${placeStr} on ${date} (${sat}). ${sectorHintPhrase(p.sec)}
${spatialUncertaintyNote(p)}

IMAGE
An Esri satellite snapshot ~1 km wide, centred on the plume coordinate. A ring with crosshair marks the coordinate. Overlay symbols on the image: × = OGIM well, ◇ = OGIM facility (named alongside), thin line = OGIM pipeline.

NEARBY DATA (closest entries first):
${nearby}

HOW TO DECIDE
- The image is the primary evidence. Identify what is physically at the centre ring.
- For a well, only attribute to an OGIM/OSM id when its listed distance is small (≲50 m) AND the matching wellhead is visible at the ring.
- For a named facility (gas plant, tank battery, compressor station, refinery, landfill), attribute to it whenever the plume ring sits inside the same fenced or cleared site as the facility — even if the listed point is 100–400 m away, because OGIM stores one coordinate for what is often a sprawling compound.
- When the visible structure has no matching list entry, label it descriptively without borrowing a distant operator name (e.g. "Unlabelled well pad", "Tank battery", "Compressor station").
- If the ring sits over empty land (vegetation, desert, water, farmland) with no plausible source, set source_kind to "none" and source_label to "No obvious source within 2 km".

OUTPUT GUIDANCE
- source_label is a short human-readable name for a journalist. Good shapes: "Caerus Uinta gas well", "Unlabelled tank battery", "Sanitary landfill", "Coal mine vent shaft", "No obvious source within 2 km". Never write a field name like "Sector Waste" or an ID like "OGIM:1234".
- attributed_id is either "OGIM:<id>" or "OSM:<type>/<id>" copied verbatim from the lists above, or null. Never invent IDs. Never use a different separator than the colon.
- paragraph is 1–3 plain sentences naming the source and the visible evidence. Skip rejected hypotheses. Skip the overlay markers/colours. Skip boilerplate closers. No web-derived claims (you have no internet).
`;
}

// ── Esri imagery snapshot (2x2 tile grid) with plume + OGIM overlay ──
function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const x = (lon + 180) / 360 * n;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
}

async function captureEsriSnapshot(lon, lat, zoom = 16, ogimItems = []) {
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const t = lonLatToTile(lon, lat, zoom);
    const baseX = Math.floor(t.x - 0.5);
    const baseY = Math.floor(t.y - 0.5);
    const maxTile = 2 ** zoom;

    const TILE = 256;
    const W = TILE * 2, H = TILE * 2;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const loads = [];
    for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 2; dy++) {
            const x = ((baseX + dx) % maxTile + maxTile) % maxTile;
            const y = Math.max(0, Math.min(maxTile - 1, baseY + dy));
            const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`;
            loads.push(new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { ctx.drawImage(img, dx * TILE, dy * TILE); resolve(); };
                img.onerror = () => reject(new Error(`tile ${zoom}/${x}/${y} failed`));
                img.src = url;
            }));
        }
    }
    await Promise.all(loads);

    // Project (lon, lat) to canvas pixel — used for plume + OGIM markers.
    const project = (plon, plat) => {
        const pt = lonLatToTile(plon, plat, zoom);
        return { x: (pt.x - baseX) * TILE, y: (pt.y - baseY) * TILE };
    };

    // OGIM markers (drawn first so plume ring sits on top).
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';

    // Draw pipelines first so points sit on top of them
    for (const it of ogimItems) {
        if (it.kind !== 'pipeline' || !it.geometry) continue;
        const segs = it.geometry.type === 'LineString'
            ? [it.geometry.coordinates]
            : it.geometry.coordinates;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 4;
        for (const seg of segs) {
            ctx.beginPath();
            seg.forEach(([plon, plat], i) => {
                const p = project(plon, plat);
                if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255, 230, 100, 0.95)';
        ctx.lineWidth = 1.5;
        for (const seg of segs) {
            ctx.beginPath();
            seg.forEach(([plon, plat], i) => {
                const p = project(plon, plat);
                if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
        }
    }

    for (const it of ogimItems) {
        if (it.kind === 'pipeline') continue;
        const { x, y } = project(it.lon, it.lat);
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
        if (it.kind === 'well') {
            // White × with halo
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6);
            ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6);
            ctx.stroke();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
        } else {
            // Amber diamond for facilities
            ctx.beginPath();
            ctx.moveTo(x, y - 8);
            ctx.lineTo(x + 8, y);
            ctx.lineTo(x, y + 8);
            ctx.lineTo(x - 8, y);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255, 200, 100, 0.85)';
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.lineWidth = 1.5;
            ctx.fill();
            ctx.stroke();
        }
        // Label (facility name or operator) when present
        const label = it.name || it.operator;
        if (label) {
            ctx.font = '11px system-ui, sans-serif';
            ctx.fillStyle = '#000';
            ctx.fillText(label, x + 11, y + 4);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, x + 10, y + 3);
        }
    }

    // Plume ring at centre — magenta ring with crosshair.
    const c = project(lon, lat);
    ctx.strokeStyle = '#ff2dd1';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x - 30, c.y); ctx.lineTo(c.x - 12, c.y);
    ctx.moveTo(c.x + 12, c.y); ctx.lineTo(c.x + 30, c.y);
    ctx.moveTo(c.x, c.y - 30); ctx.lineTo(c.x, c.y - 12);
    ctx.moveTo(c.x, c.y + 12); ctx.lineTo(c.x, c.y + 30);
    ctx.stroke();
    ctx.fillStyle = '#ff2dd1';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('plume', c.x + 26, c.y - 18);

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

async function streamPlumeLLM(container, prompt, plume, lon, lat, ogimItems, { force = false, place = null, wind = null } = {}) {
    if (!FIREDAMP_API) {
        container.innerHTML = '<span class="enrich-empty">Analysis API not configured. Set <code>meta[name=&quot;firedamp-api&quot;]</code> in index.html.</span>';
        return;
    }

    container.innerHTML = `<div class="enrich-status">Capturing imagery…</div>`;
    const statusEl = container.querySelector('.enrich-status');

    let imageDataUrl = null;
    try {
        imageDataUrl = await captureEsriSnapshot(lon, lat, 16, ogimItems);
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

        // Bounding box ~2 km around plume for Overpass
        const dLat = 2 / 111;
        const dLon = 2 / (111 * Math.cos(lat * Math.PI / 180));
        const south = lat - dLat, north = lat + dLat;
        const west = lon - dLon, east = lon + dLon;

        // Wind is decorative metadata, not load-bearing for the prompt — fire
        // it in parallel and let it render whenever it lands instead of
        // gating the AI call on Open-Meteo's response time.
        const windPromise = fetchWind(lat, lon, p.dt).then(w => {
            if (analysisRequestId === id) renderWind(w);
            return w;
        });

        const [overpassData, ogimItems, place] = await Promise.all([
            queryOverpass(south, west, north, east),
            loadNearbyInfra(lon, lat, { maxResults: 20, radiusKm: 2 }),
            reverseGeocode(lat, lon),
        ]);
        if (analysisRequestId !== id) return;

        const osmFeatures = overpassData?.elements ? summariseOsmElements(overpassData.elements, lat, lon) : [];
        const prompt = buildPlumePrompt(p, osmFeatures, ogimItems, place);

        // Give wind a very short slack — if Open-Meteo answers fast we store
        // it in D1, but a slow response never blocks shipping the prompt.
        // The UI updates whenever the wind promise eventually resolves.
        const wind = await Promise.race([
            windPromise,
            new Promise(r => setTimeout(() => r(null), 400)),
        ]);

        const el2 = targetEl();
        if (!el2) return;
        await streamPlumeLLM(el2, prompt, p, lon, lat, ogimItems, { force, place, wind });
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
