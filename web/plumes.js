// plume data: binary parser, map layers, filters

import { map } from './map.js';

export const SRC_COLORS = {
    cm:     '#00ffff',
    imeo:   '#ff00ff',
    sron:   '#ffff00',
    ghgsat: '#ff7a00'
};

export const SRC_LABELS = {
    cm:     'Carbon Mapper',
    imeo:   'IMEO / MARS',
    sron:   'SRON',
    ghgsat: 'GHGSat'
};

// source render/filter order. ghgsat is leaked, local-only data: it only exists
// when a locally-built plumes.bin includes it, and its toggle stays hidden
// otherwise (see the reveal on load), so nothing surfaces on the live map.
export const SRCS = ['cm', 'imeo', 'sron', 'ghgsat'];
export const plumeLayers = SRCS.map(s => `plumes-${s}`);

// ── binary parser (FDP1, 20 bytes/record + satellite table + id block) ──

export function parsePlumes(buffer) {
    const view = new DataView(buffer);

    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'FDP1') throw new Error('Invalid plumes binary');
    const count = view.getUint32(4, true);

    // satellite name table
    let offset = 9;
    const satTable = [];
    const decoder = new TextDecoder();
    for (let i = 0, n = view.getUint8(8); i < n; i++) {
        const len = view.getUint8(offset);
        satTable.push(decoder.decode(new Uint8Array(buffer, offset + 1, len)));
        offset += 1 + len;
    }

    const SEC_NAMES = [null, 'og', 'coal', 'waste', 'other'];
    const EPOCH = Date.UTC(2020, 0, 1);

    const plumes = new Array(count);
    for (let i = 0; i < count; i++) {
        const base = offset + i * 20;
        const srcSec = view.getUint8(base + 18);
        const unc = view.getUint32(base + 14, true);
        const sec = SEC_NAMES[(srcSec >> 2) & 0x07];
        const p = {
            lat: view.getFloat32(base, true),
            lon: view.getFloat32(base + 4, true),
            dt: new Date(EPOCH + view.getUint16(base + 8, true) * 86400000).toISOString().slice(0, 10),
            rate: view.getUint32(base + 10, true),
            src: SRCS[srcSec & 0x03],
            sat: satTable[view.getUint8(base + 19)],
        };
        if (unc) p.unc = unc;
        if (sec) p.sec = sec;
        plumes[i] = p;
    }

    // ids block — SRON ids use "display|link" composite format
    const ids = decoder.decode(new Uint8Array(buffer, offset + count * 20)).split('\n');
    for (let i = 0; i < count; i++) {
        const raw = ids[i];
        const pipe = raw.indexOf('|');
        if (pipe !== -1) {
            plumes[i].id = raw.substring(0, pipe);
            plumes[i].link = raw.substring(pipe + 1);
        } else {
            plumes[i].id = raw;
        }
    }

    return plumes;
}

// ── layers ──

// radius by emission rate (log scale)
const radiusExpr = [
    'interpolate', ['linear'],
    ['ln', ['+', ['get', 'rate'], 1]],
    Math.log(501),   3,
    Math.log(1001),  5,
    Math.log(5001),  8,
    Math.log(10001), 12
];

export function addPlumeLayers(plumes) {
    map.addSource('plumes', {
        type: 'geojson',
        data: {
            type: 'FeatureCollection',
            features: plumes.map(p => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                properties: p
            }))
        }
    });

    // one circle layer per source for independent toggling
    for (const src of SRCS) {
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

    // highlight ring for the selected plume
    map.addSource('plume-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'plume-highlight',
        type: 'circle',
        source: 'plume-highlight',
        paint: {
            'circle-radius': 18,
            'circle-color': 'transparent',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2.5,
            'circle-stroke-opacity': 0.9
        }
    });
}

// ── filters ──

const filters = { sec: 'all', year: 'all', rate: 'all' };

export function setFilter(key, value) {
    filters[key] = value;
    for (const layer of plumeLayers) {
        if (map.getLayer(layer)) map.setFilter(layer, buildFilter(layer.slice('plumes-'.length)));
    }
}

function buildFilter(src) {
    const f = ['all', ['==', ['get', 'src'], src]];
    if (filters.sec !== 'all') {
        f.push(['==', ['get', 'sec'], filters.sec]);
    }
    if (filters.year === '30d') {
        const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
        f.push(['>=', ['slice', ['get', 'dt'], 0, 10], cutoff]);
    } else if (filters.year === 'pre2023') {
        f.push(['<', ['slice', ['get', 'dt'], 0, 4], '2023']);
    } else if (filters.year !== 'all') {
        f.push(['==', ['slice', ['get', 'dt'], 0, 4], filters.year]);
    }
    if (filters.rate !== 'all') {
        f.push(['>=', ['get', 'rate'], Number(filters.rate) * 1000]);
    }
    return f;
}
