// entry point — data load, layer assembly, UI wiring

import { map } from './map.js';
import { parsePlumes, addPlumeLayers, setFilter } from './plumes.js';
import { addSourceLayers } from './sources.js';
import { setupInteractions, restorePermalink } from './detail.js';
import { loadAttributions } from './analysis.js';

map.on('load', async () => {
    const [buf, attribs] = await Promise.all([
        fetch('data/plumes.bin').then(r => r.arrayBuffer()),
        loadAttributions(),
    ]);
    const plumes = parsePlumes(buf);
    const attributed = new Set(Object.keys(attribs));

    // reveal the ghgsat toggle/legend only when local-only ghgsat data is present
    if (plumes.some(p => p.src === 'ghgsat'))
        document.querySelectorAll('[data-ghgsat]').forEach(el => { el.hidden = false; });

    // candidate-source layers, loaded per viewport past MIN_ZOOM and per
    // selected plume (rendered below plumes)
    addSourceLayers();

    addPlumeLayers(plumes, attributed);
    setupInteractions();
    restorePermalink(plumes);
});

// ── UI wiring ──

// per-source visibility toggles
document.querySelectorAll('.source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const on = btn.classList.toggle('active');
        const layerId = `plumes-${btn.dataset.src}`;
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
    });
});

// sector / year / rate filter button groups
for (const key of ['attr', 'year', 'rate']) {
    const btns = document.querySelectorAll(`[data-${key}]`);
    btns.forEach(btn => btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setFilter(key, btn.dataset[key]);
    }));
}

// location search: "lat, lon" zooms directly, anything else geocodes via nominatim
const searchBox = document.getElementById('search-box');
searchBox.addEventListener('input', () => searchBox.classList.remove('miss'));
searchBox.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !searchBox.value.trim()) return;
    const q = searchBox.value.trim();
    const m = q.match(/^(-?\d+(?:\.\d+)?)[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180)
        return map.flyTo({ center: [+m[2], +m[1]], zoom: 12 });
    const hit = (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`)
        .then(r => r.json()).catch(() => []))[0];
    if (!hit) return searchBox.classList.add('miss');
    const [s, n, w, east] = hit.boundingbox.map(Number);
    map.fitBounds([[w, s], [east, n]], { padding: 40, maxZoom: 14 });
});

document.getElementById('collapse-toggle').addEventListener('click', () => {
    document.getElementById('left-panel').classList.toggle('collapsed');
});

document.getElementById('legend-collapse').addEventListener('click', () => {
    document.getElementById('legend').classList.toggle('collapsed');
});

function updateMapCentre() {
    const c = map.getCenter();
    document.getElementById('map-centre').textContent = `${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`;
}
map.on('move', updateMapCentre);
map.on('load', updateMapCentre);
