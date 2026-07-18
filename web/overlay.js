// Selected Data Desk MARS-S2L probability surface, georeferenced over the
// satellite basemap. The PNG carries viridis RGBA; the canonical analysis
// footprint supplies its four image-source corners.

const SOURCE = 'dd-plume-probability';
const LAYER = 'dd-plume-probability';
let map;

export function initProbabilityOverlay(value) {
    map = value;
}

export function clearProbabilityOverlay() {
    if (!map) return;
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

function imageCorners(bounds) {
    const ring = JSON.parse(bounds)?.coordinates?.[0];
    if (!ring || ring.length < 4) return null;
    // Canonical chip ring: lower-left, lower-right, upper-right, upper-left.
    return [ring[3], ring[2], ring[1], ring[0]];
}

export function showProbabilityOverlay(properties, url) {
    clearProbabilityOverlay();
    if (!map || properties.src !== 'dd' || !url || !properties.bounds) return;
    try {
        const coordinates = imageCorners(properties.bounds);
        if (!coordinates) return;
        map.addSource(SOURCE, { type: 'image', url, coordinates });
        map.addLayer({
            id: LAYER,
            type: 'raster',
            source: SOURCE,
            paint: {
                'raster-opacity': 0.85,
                'raster-fade-duration': 0,
                'raster-resampling': 'linear',
            },
        }, map.getLayer('plumes-dd') ? 'plumes-dd' : undefined);
    } catch (error) {
        clearProbabilityOverlay();
        console.warn('probability overlay unavailable:', error);
    }
}
