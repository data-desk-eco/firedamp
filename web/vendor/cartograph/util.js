// shared helpers: formatting, geometry, and the pure logic behind filters and
// permalinks (kept dom-free so node can test them)

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export const haversineM = (...a) => haversineKm(...a) * 1000;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg) {
    if (deg == null || isNaN(deg)) return '';
    return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export function fmtMetres(m) {
    if (m == null) return '?';
    return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function fmtCoords(lat, lon) {
    return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, `
         + `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
}

// compose a maplibre layer filter from a base filter + active filter exprs
export function composeFilter(base, exprs) {
    const active = exprs.filter(Boolean);
    if (!active.length) return base ?? null;
    return ['all', ...(base ? [base] : []), ...active];
}

// #<key>=<id> permalinks, coexisting with maplibre's #map= hash
export function getHashParam(hash, key) {
    const m = hash.match(new RegExp(`${key}=([^&]*)`));
    return m ? decodeURIComponent(m[1]) : null;
}

export function setHashParam(hash, key, id) {
    const rest = hash.replace(/^#/, '').split('&').filter(p => p && !p.startsWith(`${key}=`));
    if (id != null) rest.push(`${key}=${encodeURIComponent(id)}`);
    return rest.length ? '#' + rest.join('&') : '';
}
