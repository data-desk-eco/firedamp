// detail panel, plume permalinks, overlap nav, map interactions

import { map } from './map.js';
import { plumeLayers, SRC_LABELS } from './plumes.js';
import { findNearbyInfra, nearbyMarkup, ogimVisible } from './ogim.js';
import { runPlumeAnalysis, cancelAnalysis } from './analysis.js';

let selectedFeature = null;
let overlappingFeatures = [];
let overlapIndex = 0;

// ── permalink helpers — #plume=<id> (standalone, no map coords needed) ──

function setPlumeHash(id) {
    const target = id ? '#plume=' + encodeURIComponent(id) : '';
    if (location.hash === target) return;
    history.replaceState(null, '', target || location.pathname + location.search);
}

function getPlumeHash() {
    const m = location.hash.match(/plume=([^&]*)/);
    return m ? decodeURIComponent(m[1]) : null;
}

// rendered plume features within 10px of a screen point, nearest first — shared
// by map clicks and permalink restore so both get the same overlap grouping.
function plumesAt(point, lngLat) {
    const t = 10;
    const bbox = [[point.x - t, point.y - t], [point.x + t, point.y + t]];
    const layers = plumeLayers.filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none');
    return map.queryRenderedFeatures(bbox, { layers }).sort((a, b) => {
        const [aLng, aLat] = a.geometry.coordinates;
        const [bLng, bLat] = b.geometry.coordinates;
        return Math.hypot(aLng - lngLat.lng, aLat - lngLat.lat)
             - Math.hypot(bLng - lngLat.lng, bLat - lngLat.lat);
    });
}

// restore plume from a #plume=<id> permalink after data load
export function restorePermalink(plumes) {
    const linkedId = getPlumeHash();
    if (!linkedId) return;
    const match = plumes.find(p => p.id === linkedId);
    if (!match) return;
    showDetail({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [match.lon, match.lat] },
        properties: match
    }, true);
    map.flyTo({ center: [match.lon, match.lat], zoom: Math.max(map.getZoom(), 15) });
    // once the camera settles, regroup overlapping plumes so the prev/next
    // nav appears just as it does for a map click.
    map.once('moveend', () => {
        const features = plumesAt(map.project([match.lon, match.lat]), { lng: match.lon, lat: match.lat });
        const idx = features.findIndex(f => f.properties.id === linkedId);
        if (features.length < 2 || idx < 0) return;
        // anchor the linked plume first so the nav reads "1 / N".
        overlappingFeatures = [features[idx], ...features.filter((_, i) => i !== idx)];
        overlapIndex = 0;
        showDetail(overlappingFeatures[0], true);
    });
}

// ── panel ──

function sourceUrl(src, id, link) {
    if (!id || id === '—') return null;
    switch (src) {
        case 'cm': return `https://data.carbonmapper.org/?plume_id=${encodeURIComponent(id)}`;
        case 'sron': return link ? `https://ftp.sron.nl/pub/memo/CSVs/${encodeURIComponent(link)}` : null;
        default: return null;
    }
}

function sectorLabel(sec) {
    const labels = { og: 'Oil & Gas', coal: 'Coal', waste: 'Waste', other: 'Other' };
    return labels[sec] || sec || '—';
}

function setHighlight(features) {
    map.getSource('plume-highlight')?.setData({ type: 'FeatureCollection', features });
}

export function showDetail(feature, fromPermalink) {
    selectedFeature = feature;
    const p = feature.properties;
    if (!fromPermalink) setPlumeHash(p.id);
    // use properties (exact) rather than geometry.coordinates (quantized by tile grid at low zoom)
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    setHighlight([{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {} }]);

    const coordStr = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, `
                   + `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    const rateThr = (Number(p.rate) / 1000).toFixed(1);
    const plumeId = p.id || '—';
    const href = sourceUrl(p.src, plumeId, p.link);

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
            <span class="source-badge ${p.src || 'cm'}">${SRC_LABELS[p.src] || p.src}</span>
            ${p.sec ? `<span class="sector-badge">${sectorLabel(p.sec)}</span>` : ''}
        </div>
        <div class="stats-grid">
            <div class="stat"><div class="stat-big">${rateThr}</div><div class="stat-unit">t/hr</div></div>
            <div class="stat" id="stat-wind"><div class="stat-big stat-wind-big">…</div><div class="stat-unit">wind</div></div>
            <div class="stat"><div class="stat-big">${p.sat || '—'}</div><div class="stat-unit">satellite</div></div>
            <div class="stat"><div class="stat-big">${p.dt || '—'}</div><div class="stat-unit">date</div></div>
        </div>
        <div id="detail-nearby">${nearbyMarkup(findNearbyInfra(lon, lat))}</div>
        <div class="enrich-section">
            <div class="enrich-section-label">
                <span>Analysis</span>
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
    cancelAnalysis();
    setPlumeHash(null);
    setHighlight([]);
    document.getElementById('right-panel').classList.add('hidden');
}

// refresh the nearby-infrastructure section only (avoids re-running AI
// analysis) — used when the OGIM toggle loads new tiles.
export function refreshNearby() {
    if (!selectedFeature) return;
    const p = selectedFeature.properties;
    const el = document.getElementById('detail-nearby');
    if (el) el.innerHTML = nearbyMarkup(findNearbyInfra(Number(p.lon), Number(p.lat)));
}

function overlapStep(delta) {
    if (overlappingFeatures.length < 2) return;
    overlapIndex = (overlapIndex + delta + overlappingFeatures.length) % overlappingFeatures.length;
    showDetail(overlappingFeatures[overlapIndex]);
}

// window-bound for inline onclick handlers in panel markup
window.closeDetail = closeDetail;
window.overlapNext = () => overlapStep(1);
window.overlapPrev = () => overlapStep(-1);

// ── map interactions ──

export function setupInteractions() {
    const popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'plume-popup',
        offset: 10
    });

    // hover
    for (const layer of plumeLayers) {
        map.on('mouseenter', layer, e => {
            map.getCanvas().style.cursor = 'pointer';
            const p = e.features[0].properties;
            const rateThr = (Number(p.rate) / 1000).toFixed(1);
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${rateThr} t/hr</strong><br>${SRC_LABELS[p.src] || p.src}${p.dt ? ' · ' + p.dt : ''}`)
                .addTo(map);
        });

        map.on('mousemove', layer, e => popup.setLngLat(e.lngLat));

        map.on('mouseleave', layer, () => {
            map.getCanvas().style.cursor = '';
            popup.remove();
        });
    }

    // click
    map.on('click', e => {
        const features = plumesAt(e.point, e.lngLat);
        if (!features.length) {
            closeDetail();
            return;
        }
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
            const facility = f.layer.id === 'ogim-facilities';
            const title = facility
                ? (p.FAC_NAME || p.OPERATOR || p.CATEGORY || 'Facility')
                : (p.FAC_TYPE || (f.layer.id === 'ogim-wells' ? 'Well' : 'Pipeline'));
            const detail = (facility ? [p.FAC_TYPE, p.COUNTRY, p.OGIM_STATUS] : [p.OPERATOR, p.COUNTRY, p.OGIM_STATUS])
                .filter(Boolean).join(' · ');
            popup.setLngLat(e.lngLat)
                .setHTML(`<strong>${title}</strong>${detail ? '<br>' + detail : ''}`)
                .addTo(map);
            ogimHover = true;
        } else if (ogimHover) {
            map.getCanvas().style.cursor = '';
            popup.remove();
            ogimHover = false;
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeDetail();
    });
}
