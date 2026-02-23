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
// State
// ---------------------------------------------------------------------------

let plumesData = null;       // raw plumes array from plumes.json
let activeSources = new Set(['cm', 'imeo', 'sron']);
let activeSector = 'all';
let activeYear = 'all';
let activeRate = 'all';
let ogimVisible = false;
let selectedFeature = null;

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
    hash: true,
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

    // Interactions
    setupInteractions();

    // ----- Temporary: Permian Basin fieldwork sites (?fw=1) -----
    if (new URLSearchParams(location.search).has('fw')) {
    const fieldworkSites = [
        { name: 'BPX Bingo CDP', lat: 31.8464, lon: -103.8811 },
        { name: 'BPX Checkmate CDP', lat: 31.7773, lon: -103.9326 },
        { name: 'BPX Bishop SWD', lat: 31.7783, lon: -103.9292 },
        { name: 'BPX State Ella Mae', lat: 31.8541, lon: -103.9399 },
        { name: 'BPX Scooter', lat: 31.8045, lon: -103.8744 },
        { name: 'BPX Momentum/Chevy Lowe Rider', lat: 31.8495, lon: -103.8751 },
        { name: 'BPX Gretchen Northrup', lat: 31.7814, lon: -103.9113 },
        { name: 'BPX State Barlow', lat: 31.7758, lon: -103.9383 },
        { name: 'Cimarex Logan', lat: 31.6429, lon: -103.8487 },
        { name: 'ET Keystone', lat: 31.9472, lon: -103.0429 },
        { name: 'ET Station 10', lat: 31.3112, lon: -103.1460 },
        { name: 'ET Waha Gas Plant', lat: 31.2699, lon: -103.0876 },
        { name: 'Enterprise Leonidis', lat: 31.8544, lon: -101.8015 },
        { name: 'Enterprise Delaware Basin', lat: 31.2840, lon: -103.1071 },
        { name: 'ETC Red Lake', lat: 32.3256, lon: -101.8233 },
        { name: 'ETC Bear', lat: 31.7734, lon: -103.9018 },
        { name: 'ETC Arrowhead', lat: 31.2921, lon: -103.1505 },
        { name: 'XTO Jim Mims', lat: 32.3122, lon: -101.8214 },
        { name: 'XTO Tank Battery 342 (Poker Lake)', lat: 32.2065, lon: -103.8550 },
        { name: 'XTO Poker Lake past Tiger', lat: 32.1131, lon: -103.9149 },
        { name: 'XTO Cowboy CDP', lat: 32.1597, lon: -103.8421 },
        { name: 'XTO Tiger', lat: 32.1182, lon: -103.9073 },
        { name: 'XTO Highlander', lat: 32.2047, lon: -103.8709 },
        { name: 'XTO Coyote', lat: 31.2532, lon: -103.0831 },
        { name: 'XTO Kriti Site', lat: 31.2558, lon: -103.0693 },
        { name: 'Targa Greenwood', lat: 31.9783, lon: -101.8771 },
        { name: 'Targa Hopson Plant', lat: 31.8515, lon: -101.8017 },
        { name: 'Unknown SWD', lat: 32.3220, lon: -101.8256 },
        { name: 'Unknown production well', lat: 31.8576, lon: -103.8317 },
    ];
    const fieldworkGeoJSON = {
        type: 'FeatureCollection',
        features: fieldworkSites.map(s => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            properties: { name: s.name }
        }))
    };
    map.addSource('fieldwork', { type: 'geojson', data: fieldworkGeoJSON });
    map.addLayer({
        id: 'fieldwork-circles',
        type: 'circle',
        source: 'fieldwork',
        paint: {
            'circle-radius': 14,
            'circle-color': 'transparent',
            'circle-stroke-color': '#00ff00',
            'circle-stroke-width': 3,
            'circle-stroke-opacity': 0.9
        }
    });
    map.addLayer({
        id: 'fieldwork-labels',
        type: 'symbol',
        source: 'fieldwork',
        layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Noto Sans Regular'],
            'text-size': 11,
            'text-offset': [0, -1.8],
            'text-anchor': 'bottom'
        },
        paint: {
            'text-color': '#00ff00',
            'text-halo-color': 'rgba(0,0,0,0.8)',
            'text-halo-width': 1.5
        }
    });
    } // ----- End fieldwork sites -----

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

const SKIP_TYPES = new Set(['N/A', 'DRY HOLE', 'UNKNOWN', '']);
const SKIP_STATUSES = new Set(['ABANDONED', 'INACTIVE']);

function findNearbyInfra(lon, lat, maxResults = 10) {
    if (!map.getSource('ogim')) return [];
    const results = [];
    const seen = new Set();
    for (const sourceLayer of ['facilities', 'wells']) {
        const features = map.querySourceFeatures('ogim', { sourceLayer });
        for (const f of features) {
            const id = f.properties.OGIM_ID;
            if (seen.has(id)) continue;
            seen.add(id);
            const type = (f.properties.FAC_TYPE || '').trim();
            const status = (f.properties.OGIM_STATUS || '').trim();
            if (SKIP_TYPES.has(type) || SKIP_STATUSES.has(status)) continue;
            const [flon, flat] = f.geometry.coordinates;
            const dist = haversineKm(lat, lon, flat, flon);
            if (dist > 2) continue;
            results.push({
                name: f.properties.FAC_NAME || type || (sourceLayer === 'facilities' ? 'Facility' : 'Well'),
                operator: f.properties.OPERATOR || '',
                ogimId: id,
                lon: flon,
                lat: flat,
                dist
            });
        }
    }
    results.sort((a, b) => a.dist - b.dist);
    return results.slice(0, maxResults);
}

function formatDist(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
}

function toggleOGIM(visible) {
    ogimVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['ogim-wells', 'ogim-pipelines', 'ogim-facilities']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    document.getElementById('legend-infra').style.display = visible ? 'block' : 'none';
    if (selectedFeature) showDetail(selectedFeature);
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

        // Closest feature
        let closest = features[0], minDist = Infinity;
        for (const f of features) {
            const [lng, lat] = f.geometry.coordinates;
            const d = Math.hypot(lng - e.lngLat.lng, lat - e.lngLat.lat);
            if (d < minDist) { minDist = d; closest = f; }
        }

        showDetail(closest);
        map.flyTo({
            center: closest.geometry.coordinates,
            zoom: Math.max(map.getZoom(), 8)
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

function showDetail(feature) {
    selectedFeature = feature;
    const p = feature.properties;
    const [lon, lat] = feature.geometry.coordinates;

    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    const coordStr = `${Math.abs(lat).toFixed(4)}\u00b0${latDir}, ${Math.abs(lon).toFixed(4)}\u00b0${lonDir}`;

    const rateThr = (Number(p.rate) / 1000).toFixed(1);
    const uncThr = p.unc != null && p.unc !== 'null' ? (Number(p.unc) / 1000).toFixed(1) : null;
    const plumeId = p.id || '\u2014';
    const href = sourceUrl(p.src, plumeId, p.link);

    const srcClass = p.src || 'cm';
    const srcLabel = SRC_LABELS[p.src] || p.src;

    // Find nearby infrastructure
    const nearby = ogimVisible ? findNearbyInfra(lon, lat) : [];
    let nearbyHtml = '';
    if (nearby.length > 0) {
        nearbyHtml = `
        <div class="detail-row">
            <div class="detail-field-label" style="margin:4px 0 8px;font-size:var(--font-xs)">Nearby infrastructure</div>
            ${nearby.map(f => `<div class="nearby-item" onclick="flyToInfra(${f.lon},${f.lat})">
                <div class="nearby-name">${f.name}</div>
                <div class="nearby-meta">${[f.operator, formatDist(f.dist)].filter(Boolean).join(' \u00b7 ')}</div>
                <div class="nearby-id">OGIM ${f.ogimId}</div>
            </div>`).join('')}
        </div>`;
    }

    const panel = document.getElementById('right-panel');
    panel.innerHTML = `
        <div class="detail-header">
            <div class="detail-header-text">
                ${href ? `<a class="detail-id" href="${href}" target="_blank" rel="noopener">${plumeId}</a>` : `<span class="detail-id">${plumeId}</span>`}
                <span class="detail-coords">${coordStr}</span>
            </div>
            <button class="close-btn" onclick="closeDetail()">&times;</button>
        </div>
        <div class="detail-badges">
            <span class="source-badge ${srcClass}">${srcLabel}</span>
            ${p.sec ? `<span class="sector-badge">${sectorLabel(p.sec)}</span>` : ''}
        </div>
        <div class="stats-grid">
            <div class="stat"><div class="stat-big">${rateThr}</div><div class="stat-unit">t/hr</div></div>
            <div class="stat"><div class="stat-big">${uncThr != null ? '\u00b1' + uncThr : '\u2014'}</div><div class="stat-unit">uncertainty</div></div>
            <div class="stat"><div class="stat-big">${p.sat || '\u2014'}</div><div class="stat-unit">satellite</div></div>
            <div class="stat"><div class="stat-big">${p.dt || '\u2014'}</div><div class="stat-unit">date</div></div>
        </div>
        ${p.cty ? `<div class="detail-row"><div class="detail-field"><span class="detail-field-label">Country</span><span class="detail-field-value">${p.cty}</span></div></div>` : ''}
        ${nearbyHtml}
    `;
    panel.classList.remove('hidden');
}

function closeDetail() {
    selectedFeature = null;
    document.getElementById('right-panel').classList.add('hidden');
}

function sectorLabel(sec) {
    const labels = { og: 'Oil & Gas', coal: 'Coal', waste: 'Waste', other: 'Other' };
    return labels[sec] || sec || '\u2014';
}

function flyToInfra(lon, lat) {
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14) });
}

// Make functions globally accessible for onclick
window.closeDetail = closeDetail;
window.flyToInfra = flyToInfra;

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
map.on('move', updateMapCentre);
map.on('load', updateMapCentre);

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDetail();
});
