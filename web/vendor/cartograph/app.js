// mount(config): assemble the whole app — dom, map, data, layers, filters,
// key, detail, search — from a declarative config. see README for the schema;
// firedamp is the reference implementation.

import { createMap, addSatellite, wireWorldmap, wireCollapse, hoverPopup } from './shell.js';
import { initData, need, query, fc } from './data.js';
import { buildShell, buildKey } from './ui.js';
import { initDetail, closeDetail, showDetail } from './detail.js';
import { initTable } from './table.js';

// location search: "lat, lon" zooms directly, anything else geocodes via nominatim
function wireSearch(map) {
    const box = document.getElementById('search');
    box.addEventListener('input', () => box.classList.remove('miss'));
    box.addEventListener('keydown', async e => {
        if (e.key !== 'Enter' || !box.value.trim()) return;
        const q = box.value.trim();
        const m = q.match(/^(-?\d+(?:\.\d+)?)[,\s]\s*(-?\d+(?:\.\d+)?)$/);
        if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180)
            return map.flyTo({ center: [+m[2], +m[1]], zoom: 12 });
        const hit = (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`)
            .then(r => r.json()).catch(() => []))[0];
        if (!hit) return box.classList.add('miss');
        const [s, n, w, east] = hit.boundingbox.map(Number);
        map.fitBounds([[w, s], [east, n]], { padding: 40, maxZoom: 14 });
    });
}

// filter button groups: each config.filters entry contributes pred(value) —
// a feature-properties predicate, or null for no-op; `extra` supplies more
// (the key's multi-select rows). active preds AND together and every geojson
// source is re-set to the matching subset, so clustered sources re-cluster
// to exactly the visible features. returns apply for re-runs.
function wireFilters(map, config, sources, extra = () => []) {
    const state = Object.fromEntries((config.filters || []).map(f => [f.key, f.value ?? 'all']));
    const apply = () => {
        const preds = [...(config.filters || []).map(f => f.pred(state[f.key])), ...extra()].filter(Boolean);
        for (const [id, fc] of Object.entries(sources))
            map.getSource(id)?.setData(preds.length
                ? { ...fc, features: fc.features.filter(f => preds.every(p => p(f.properties))) } : fc);
    };
    for (const group of document.querySelectorAll('.cg-filter')) {
        group.addEventListener('click', e => {
            const btn = e.target.closest('.cg-opt');
            if (!btn) return;
            group.querySelectorAll('.cg-opt').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state[group.dataset.key] = btn.dataset.value;
            apply();
        });
    }
    apply();
    return apply;
}

export async function mount(config) {
    buildShell(config);
    const map = createMap({ hash: 'map', ...config.map });
    wireWorldmap(map, document.getElementById('worldmap'));
    wireCollapse([[['main-collapse', 'main-title'], 'main-panel']]);
    if (config.search) wireSearch(map);
    if (config.data) initData(config.data);

    const ctx = { map, config, query, need, fc, sources: {} };
    await new Promise(r => (map.loaded() ? r() : map.on('load', r)));
    if (config.map?.satellite !== false) addSatellite(map);

    // a sources entry is a FeatureCollection or {data, ...geojson source
    // opts} (cluster etc.); consumers always see the plain fc
    ctx.sources = await config.sources(ctx);
    for (const [id, s] of Object.entries(ctx.sources)) {
        map.addSource(id, { type: 'geojson', ...(s.type ? { data: s } : s) });
        ctx.sources[id] = s.data ?? s;
    }
    for (const { hover, ...spec } of config.layers) {
        map.addLayer(spec);
        if (hover) hoverPopup(map, spec.id, hover, { click: !config.detail?.layers.includes(spec.id) });
    }
    let keyPreds = () => [];
    const applyFilters = wireFilters(map, config, ctx.sources, () => keyPreds());
    if (config.key) keyPreds = await buildKey(map, config.key(ctx), undefined, applyFilters);

    initDetail(map, config, () =>
        Object.values(ctx.sources).flatMap(s => s.features));
    if (config.table) initTable(ctx);

    await config.ready?.(ctx);
    window.cartograph = ctx;   // console + test handle
    return ctx;
}

export { closeDetail, showDetail };
