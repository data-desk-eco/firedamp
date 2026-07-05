// map instance + basemap style. the pmtiles protocol must be registered
// before map creation.

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const labelLayer = (id, classFilter, minzoom, sizes, color, haloWidth, extra = {}) => ({
    id,
    type: 'symbol',
    source: 'labels',
    'source-layer': 'place',
    filter: Array.isArray(classFilter)
        ? ['in', ['get', 'class'], ['literal', classFilter]]
        : ['==', ['get', 'class'], classFilter],
    minzoom,
    layout: {
        'symbol-sort-key': ['get', 'rank'],
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], ...sizes],
        'text-max-width': 8,
        ...extra,
    },
    paint: {
        'text-color': color,
        'text-halo-color': `rgba(0, 0, 0, ${haloWidth >= 1.5 ? 0.6 : 0.5})`,
        'text-halo-width': haloWidth,
    },
});

export const map = new maplibregl.Map({
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
            labelLayer('country-labels', 'country', 2, [2, 10, 6, 14], 'rgba(255, 255, 255, 0.85)', 1.5,
                { 'text-transform': 'uppercase', 'text-letter-spacing': 0.15 }),
            labelLayer('state-labels', 'state', 4, [4, 9, 8, 12], 'rgba(255, 255, 255, 0.6)', 1,
                { 'text-letter-spacing': 0.1 }),
            labelLayer('city-labels', ['city', 'town'], 4, [4, 10, 10, 14, 14, 18], 'rgba(255, 255, 255, 0.9)', 1.5),
            labelLayer('village-labels', ['village', 'suburb', 'neighbourhood'], 10, [10, 10, 14, 14], 'rgba(255, 255, 255, 0.7)', 1),
        ]
    },
    hash: 'map',
    center: [-98, 39],
    zoom: 4,
    minZoom: 1.5,
    maxZoom: 18
});

map.on('style.load', () => map.setProjection({ type: 'globe' }));
