// ---------------------------------------------------------------------------
// Methane plume map — MapLibre GL
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
let sourcesData = null;      // raw sources array from sources.json
let activeSources = new Set(['cm', 'imeo', 'sron']);
let activeSector = 'all';
let activeYear = 'all';
let ogimVisible = false;
let sourcesVisible = true;

// ---------------------------------------------------------------------------
// PMTiles protocol — must be registered before map creation
// ---------------------------------------------------------------------------

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            satellite: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256
            },
            labels: {
                type: 'raster',
                tiles: ['https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png'],
                tileSize: 512,
                attribution: '&copy; <a href="https://carto.com">CARTO</a> &copy; <a href="https://openstreetmap.org">OSM</a>'
            }
        },
        layers: [
        {
            id: 'basemap',
            type: 'raster',
            source: 'satellite',
            paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.85 }
        },
        {
            id: 'place-labels',
            type: 'raster',
            source: 'labels',
            paint: { 'raster-opacity': 0.85 },
            minzoom: 2
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

function sourcesToGeoJSON(sources) {
    return {
        type: 'FeatureCollection',
        features: sources.map(s => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
            properties: s
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
    const [plumesResp, sourcesResp] = await Promise.all([
        fetch('data/plumes.json').then(r => r.json()),
        fetch('data/sources.json').then(r => r.json()).catch(() => [])
    ]);

    plumesData = plumesResp.plumes || [];
    sourcesData = sourcesResp;

    // Update source counts
    const counts = { cm: 0, imeo: 0, sron: 0 };
    for (const p of plumesData) counts[p.src] = (counts[p.src] || 0) + 1;
    document.getElementById('cm-count').textContent = counts.cm.toLocaleString();
    document.getElementById('imeo-count').textContent = counts.imeo.toLocaleString();
    document.getElementById('sron-count').textContent = counts.sron.toLocaleString();

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
                'circle-opacity': 0.7,
                'circle-stroke-color': SRC_COLORS[src],
                'circle-stroke-width': 1,
                'circle-stroke-opacity': 0.9
            }
        });
    }

    // IMEO sources layer
    if (sourcesData && sourcesData.length > 0) {
        map.addSource('imeo-sources', {
            type: 'geojson',
            data: sourcesToGeoJSON(sourcesData)
        });
        map.addLayer({
            id: 'imeo-sources',
            type: 'circle',
            source: 'imeo-sources',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2, 8, 4, 14, 6],
                'circle-color': 'rgba(249, 115, 22, 0.6)',
                'circle-stroke-color': '#f97316',
                'circle-stroke-width': 1,
                'circle-opacity': 0.6
            }
        });
        document.getElementById('legend-sources').classList.remove('hidden');
    }

    // OGIM layers (hidden by default)
    await addOGIMLayers();

    // Interactions
    setupInteractions();

    updateVisibleCount();
    map.on('moveend', updateVisibleCount);
});

// ---------------------------------------------------------------------------
// OGIM infrastructure layers
// ---------------------------------------------------------------------------

async function addOGIMLayers() {
    try {
        const check = await fetch('data/ogim.pmtiles', { method: 'HEAD' });
        if (!check.ok) { console.log('OGIM PMTiles not found'); return; }
        map.addSource('ogim', {
            type: 'vector',
            url: 'pmtiles://data/ogim.pmtiles'
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
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 3],
                'circle-color': 'rgba(255, 255, 255, 0.4)',
                'circle-stroke-width': 0
            }
        });
    } catch (e) {
        console.warn('OGIM layers not available:', e.message);
    }
}

function toggleOGIM(visible) {
    ogimVisible = visible;
    const vis = visible ? 'visible' : 'none';
    for (const id of ['ogim-wells', 'ogim-pipelines', 'ogim-facilities']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    document.getElementById('legend-ogim').classList.toggle('hidden', !visible);
}

function toggleSources(visible) {
    sourcesVisible = visible;
    if (map.getLayer('imeo-sources')) {
        map.setLayoutProperty('imeo-sources', 'visibility', visible ? 'visible' : 'none');
    }
    document.getElementById('legend-sources').classList.toggle('hidden', !visible);
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
            const rate = Number(p.rate).toLocaleString();
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${rate} kg/hr</strong><br>${SRC_LABELS[p.src] || p.src}`)
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

    // IMEO sources hover
    if (map.getLayer('imeo-sources')) {
        map.on('mouseenter', 'imeo-sources', e => {
            map.getCanvas().style.cursor = 'pointer';
            const p = e.features[0].properties;
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>IMEO source</strong><br>${p.n} plumes · ${p.persist}`)
                .addTo(map);
        });
        map.on('mouseleave', 'imeo-sources', () => {
            map.getCanvas().style.cursor = '';
            popup.remove();
        });
    }

    // OGIM facility hover
    for (const layer of ['ogim-facilities', 'ogim-wells']) {
        if (!map.getLayer(layer)) continue;
        map.on('mouseenter', layer, e => {
            map.getCanvas().style.cursor = 'pointer';
            const p = e.features[0].properties;
            const name = p.FAC_NAME || p.OPERATOR || p.CATEGORY || 'Infrastructure';
            const detail = [p.FAC_TYPE, p.COUNTRY, p.OGIM_STATUS].filter(Boolean).join(' · ');
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${name}</strong>${detail ? '<br>' + detail : ''}`)
                .addTo(map);
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
    const coordStr = `${Math.abs(lat).toFixed(2)}\u00b0${latDir}, ${Math.abs(lon).toFixed(2)}\u00b0${lonDir}`;

    const rate = Number(p.rate);
    const unc = p.unc != null && p.unc !== 'null' ? Number(p.unc) : null;
    const idShort = typeof p.id === 'string' && p.id.length > 12 ? p.id.slice(0, 12) + '\u2026' : (p.id || '\u2014');

    const srcClass = p.src || 'cm';
    const srcLabel = SRC_LABELS[p.src] || p.src;

    const panel = document.getElementById('right-panel');
    panel.innerHTML = `
        <div class="detail-header">
            <div class="detail-header-text">
                <span class="detail-id">${idShort}</span>
                <span class="detail-coords">${coordStr}</span>
            </div>
            <button class="close-btn" onclick="closeDetail()">&times;</button>
        </div>
        <div class="stats-grid">
            <div class="stat"><div class="stat-big">${rate.toLocaleString()}</div><div class="stat-unit">kg/hr</div></div>
            <div class="stat"><div class="stat-big">${unc != null ? '\u00b1' + unc.toLocaleString() : '\u2014'}</div><div class="stat-unit">uncertainty</div></div>
            <div class="stat"><div class="stat-big">${p.sat || '\u2014'}</div><div class="stat-unit">satellite</div></div>
            <div class="stat"><div class="stat-big">${p.dt || '\u2014'}</div><div class="stat-unit">date</div></div>
        </div>
        <div class="detail-row">
            <span class="source-badge ${srcClass}">${srcLabel}</span>
        </div>
        ${p.sec ? `<div class="detail-row"><div class="detail-field"><span class="detail-field-label">Sector</span><span class="detail-field-value">${sectorLabel(p.sec)}</span></div></div>` : ''}
        ${p.cty ? `<div class="detail-row"><div class="detail-field"><span class="detail-field-label">Country</span><span class="detail-field-value">${p.cty}</span></div></div>` : ''}
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

// Make closeDetail globally accessible for onclick
window.closeDetail = closeDetail;

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
// IMEO sources toggle
// ---------------------------------------------------------------------------

document.getElementById('sources-toggle').addEventListener('change', e => {
    toggleSources(e.target.checked);
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
