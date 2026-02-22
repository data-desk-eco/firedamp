// ---------------------------------------------------------------------------
// Firedamp plume map — MapLibre GL
// ---------------------------------------------------------------------------

const SRC_COLORS = {
    cm:   '#22d3ee',
    imeo: '#f97316',
    sron: '#a855f7'
};

const SRC_LABELS = {
    cm:   'Carbon Mapper',
    imeo: 'IMEO / MARS',
    sron: 'SRON TROPOMI'
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let plumesData = null;       // raw plumes array from plumes.json
let activeSources = new Set(['cm', 'imeo', 'sron']);
let activeSector = 'all';
let activeYear = 'all';
let ogimVisible = false;

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
    center: [0, 20],
    zoom: 2.5,
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
    updateVisibleCount();
}

// ---------------------------------------------------------------------------
// Count visible plumes
// ---------------------------------------------------------------------------

function updateVisibleCount() {
    let total = 0;
    for (const src of ['cm', 'imeo', 'sron']) {
        if (!activeSources.has(src)) continue;
        const layerId = `plumes-${src}`;
        if (!map.getLayer(layerId)) continue;
        const features = map.queryRenderedFeatures({ layers: [layerId] });
        total += features.length;
    }
    document.getElementById('visible-count').textContent = total.toLocaleString();
}

// ---------------------------------------------------------------------------
// Data loading & layer setup
// ---------------------------------------------------------------------------

map.on('load', async () => {
    // Load data
    const plumesResp = await fetch('data/plumes.json').then(r => r.json());
    plumesData = plumesResp.plumes || [];

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

    updateVisibleCount();
    let moveRaf = null;
    map.on('move', () => {
        if (!moveRaf) moveRaf = requestAnimationFrame(() => {
            updateVisibleCount();
            moveRaf = null;
        });
    });
});

// ---------------------------------------------------------------------------
// OGIM infrastructure layers
// ---------------------------------------------------------------------------

async function addOGIMLayers() {
    try {
        map.addSource('ogim', {
            type: 'vector',
            url: `pmtiles://${ogimUrl}`
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
            type: 'circle',
            source: 'ogim',
            'source-layer': 'facilities',
            minzoom: 6,
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2, 14, 5],
                'circle-color': 'rgba(255, 200, 100, 0.5)',
                'circle-stroke-color': 'rgba(255, 200, 100, 0.8)',
                'circle-stroke-width': 1
            }
        });

        map.addLayer({
            id: 'ogim-wells',
            type: 'circle',
            source: 'ogim',
            'source-layer': 'wells',
            minzoom: 8,
            layout: { visibility: 'none' },
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 12, 4, 16, 6],
                'circle-color': 'rgba(255, 255, 255, 0.2)',
                'circle-stroke-color': 'rgba(255, 255, 255, 0.4)',
                'circle-stroke-width': 1,
                'circle-opacity': ['case',
                    ['==', ['get', 'OGIM_STATUS'], 'ABANDONED'], 0.3, 1],
                'circle-stroke-opacity': ['case',
                    ['==', ['get', 'OGIM_STATUS'], 'ABANDONED'], 0.3, 1]
            }
        });
        // Invisible preload layer — keeps tiles loaded for proximity queries
        map.addLayer({
            id: 'ogim-preload',
            type: 'circle',
            source: 'ogim',
            'source-layer': 'facilities',
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

    // OGIM hover (facilities, wells, pipelines)
    for (const layer of ['ogim-facilities', 'ogim-wells', 'ogim-pipelines']) {
        if (!map.getLayer(layer)) continue;
        map.on('mouseenter', layer, e => {
            map.getCanvas().style.cursor = 'pointer';
            const p = e.features[0].properties;
            let html;
            if (layer === 'ogim-wells') {
                const type = p.FAC_TYPE || 'Well';
                const detail = [p.OPERATOR, p.COUNTRY, p.OGIM_STATUS].filter(Boolean).join(' · ');
                html = `<strong>${type}</strong>${detail ? '<br>' + detail : ''}`;
            } else if (layer === 'ogim-pipelines') {
                const type = p.FAC_TYPE || 'Pipeline';
                const detail = [p.OPERATOR, p.COUNTRY, p.OGIM_STATUS].filter(Boolean).join(' · ');
                html = `<strong>${type}</strong>${detail ? '<br>' + detail : ''}`;
            } else {
                const name = p.FAC_NAME || p.OPERATOR || p.CATEGORY || 'Facility';
                const detail = [p.FAC_TYPE, p.COUNTRY, p.OGIM_STATUS].filter(Boolean).join(' · ');
                html = `<strong>${name}</strong>${detail ? '<br>' + detail : ''}`;
            }
            popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
        });
        map.on('mousemove', layer, e => {
            popup.setLngLat(e.lngLat);
        });
        map.on('mouseleave', layer, () => {
            map.getCanvas().style.cursor = '';
            popup.remove();
        });
    }
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function showDetail(feature) {
    const p = feature.properties;
    const [lon, lat] = feature.geometry.coordinates;

    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    const coordStr = `${Math.abs(lat).toFixed(4)}\u00b0${latDir}, ${Math.abs(lon).toFixed(4)}\u00b0${lonDir}`;

    const rateThr = (Number(p.rate) / 1000).toFixed(1);
    const uncThr = p.unc != null && p.unc !== 'null' ? (Number(p.unc) / 1000).toFixed(1) : null;
    const plumeId = p.id || '\u2014';

    const srcClass = p.src || 'cm';
    const srcLabel = SRC_LABELS[p.src] || p.src;

    // Find nearby infrastructure
    const nearby = findNearbyInfra(lon, lat);
    let nearbyHtml = '';
    if (nearby.length > 0) {
        nearbyHtml = `
        <div class="detail-row">
            <div class="detail-field-label" style="margin-bottom:8px">Nearby infrastructure</div>
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
                <span class="detail-id">${plumeId}</span>
                <span class="detail-coords">${coordStr}</span>
            </div>
            <span class="source-badge ${srcClass}">${srcLabel}</span>
            <button class="close-btn" onclick="closeDetail()">&times;</button>
        </div>
        <div class="stats-grid">
            <div class="stat"><div class="stat-big">${rateThr}</div><div class="stat-unit">t/hr</div></div>
            <div class="stat"><div class="stat-big">${uncThr != null ? '\u00b1' + uncThr : '\u2014'}</div><div class="stat-unit">uncertainty</div></div>
            <div class="stat"><div class="stat-big">${p.sat || '\u2014'}</div><div class="stat-unit">satellite</div></div>
            <div class="stat"><div class="stat-big">${p.dt || '\u2014'}</div><div class="stat-unit">date</div></div>
        </div>
        ${p.sec ? `<div class="detail-row"><div class="detail-field"><span class="detail-field-label">Sector</span><span class="detail-field-value">${sectorLabel(p.sec)}</span></div></div>` : ''}
        ${p.cty ? `<div class="detail-row"><div class="detail-field"><span class="detail-field-label">Country</span><span class="detail-field-value">${p.cty}</span></div></div>` : ''}
        ${nearbyHtml}
    `;
    panel.classList.remove('hidden');
}

function closeDetail() {
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
        updateVisibleCount();
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
// OGIM toggle
// ---------------------------------------------------------------------------

document.getElementById('ogim-toggle').addEventListener('change', e => {
    toggleOGIM(e.target.checked);
});

// ---------------------------------------------------------------------------
// Collapse toggle
// ---------------------------------------------------------------------------

document.getElementById('collapse-toggle').addEventListener('click', () => {
    document.getElementById('left-panel').classList.toggle('collapsed');
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDetail();
});
