// shared geometry + formatting helpers

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export const haversineM = (lat1, lon1, lat2, lon2) => haversineKm(lat1, lon1, lat2, lon2) * 1000;

// distance in metres from a point to an OSM element: zero inside its bounding
// box, else distance to the nearest bbox corner-clamped point; centre point
// otherwise. keeps large polygons (mines, plants) that contain the plume from
// being measured — and dropped — by their distant centroid.
export function boundsDist(lat, lon, b, cLat, cLon) {
    if (!b) return haversineM(lat, lon, cLat, cLon);
    return haversineM(lat, lon,
        Math.min(Math.max(lat, b.minlat), b.maxlat),
        Math.min(Math.max(lon, b.minlon), b.maxlon));
}

// compass label for a direction in degrees (0 = N, 90 = E, ...). wind is by
// meteorological convention "direction the wind is coming FROM".
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
    if (deg == null || isNaN(deg)) return '';
    return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export function formatDist(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
}

export function fmtMetres(m) {
    if (m == null) return '?';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// move distM metres from (lat, lon) along a compass bearing. used to shift the
// SRON map frame upwind (bearing = wind's "from" direction).
export function offsetLatLon(lat, lon, distM, bearingDeg) {
    const br = bearingDeg * Math.PI / 180;
    return {
        lat: lat + (distM * Math.cos(br)) / 111320,
        lon: lon + (distM * Math.sin(br)) / (111320 * Math.cos(lat * Math.PI / 180)),
    };
}

// ── spatial grid for fast proximity filtering (custom layers) ──

export function buildSpatialGrid(sites, cellDeg) {
    const grid = new Map();
    for (const [lon, lat] of sites) {
        const key = Math.floor(lon / cellDeg) + ',' + Math.floor(lat / cellDeg);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push([lon, lat]);
    }
    return grid;
}

export function isWithinRadius(lon, lat, grid, cellDeg, radiusKm) {
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
