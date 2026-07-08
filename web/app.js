// entry point — data load, layer assembly, UI wiring

import { map } from './map.js';
import { parsePlumes, addPlumeLayers, setFilter } from './plumes.js';
import { addOGIMLayers, toggleOGIM, updateOgimToggleEnabled } from './ogim.js';
import { setupInteractions, restorePermalink, refreshNearby } from './detail.js';
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

    // OGIM layers (hidden by default, rendered below plumes)
    await addOGIMLayers();

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
for (const key of ['sec', 'year', 'rate']) {
    const btns = document.querySelectorAll(`[data-${key}]`);
    btns.forEach(btn => btn.addEventListener('click', () => {
        btns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setFilter(key, btn.dataset[key]);
    }));
}

document.getElementById('ogim-toggle').addEventListener('change', e => {
    toggleOGIM(e.target.checked);
    refreshNearby();
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
map.on('move', () => { updateMapCentre(); updateOgimToggleEnabled(); });
map.on('load', () => { updateMapCentre(); updateOgimToggleEnabled(); });
