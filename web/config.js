// firedamp on cartograph — everything firedamp-specific is this config plus
// two hook modules: attribution.js (static attribution + wind) and
// candidates.js (ch4id feature catalogue from features.fgb).

import { mount } from './vendor/cartograph/app.js';
import { map as dd } from './vendor/dd/palette.js';
import { escapeHtml } from './vendor/cartograph/util.js';
import { loadAttributions, enrich } from './attribution.js';
import { addCandidateLayers, clearSelection } from './candidates.js';

const SRCS = ['cm', 'imeo', 'sron', 'ghgsat'];
const COLOR = { cm: dd.adjusted.cyan, imeo: dd.adjusted.magenta, sron: dd.adjusted.yellow, ghgsat: dd.adjusted.orange };
const LABEL = { cm: 'Carbon Mapper', imeo: 'IMEO / MARS', sron: 'SRON', ghgsat: 'GHGSat' };
const SECTOR = { og: 'Oil & Gas', coal: 'Coal', waste: 'Waste', other: 'Other' };

// radius by emission rate (log scale)
const radius = [
    'interpolate', ['linear'], ['ln', ['+', ['get', 'rate'], 1]],
    Math.log(501), 3, Math.log(1001), 5, Math.log(5001), 8, Math.log(10001), 12
];

const rateT = p => (Number(p.rate) / 1000).toFixed(1);

function sourceUrl(p) {
    if (!p.id) return null;
    if (p.src === 'cm') return `https://data.carbonmapper.org/?plume_id=${encodeURIComponent(p.id)}`;
    if (p.src === 'sron' && p.link) return `https://ftp.sron.nl/pub/memo/CSVs/${encodeURIComponent(p.link)}`;
    return null;
}

mount({
    title: 'Firedamp',
    subtitle: 'Methane plume aggregator',
    link: 'https://github.com/data-desk-eco/firedamp',
    about: `<p>Firedamp aggregates satellite methane plume detections from
        <a href="https://carbonmapper.org" target="_blank" rel="noopener">Carbon Mapper</a>,
        UNEP's <a href="https://methanedata.unep.org" target="_blank" rel="noopener">International Methane Emissions Observatory</a>
        and <a href="https://earth.sron.nl/methane-emissions/" target="_blank" rel="noopener">SRON</a>,
        hosted by <a href="https://datadesk.eco" target="_blank" rel="noopener">Data Desk</a>.</p>
        <p>Each plume carries an AI-researched source attribution where one has been established,
        with candidate infrastructure from a 12-million-feature catalogue (OGIM, OpenStreetMap,
        MapStand, Global Energy Monitor) drawn on the map past zoom 13.</p>`,
    search: true,
    map: { center: [-98, 39], zoom: 4, minZoom: 1.5, maxZoom: 18 },
    data: {
        files: { plumes: 'data/plumes.parquet', attributions: 'data/attributions.parquet' },
        prefetch: ['plumes'],
    },

    sources: async ({ query, need, fc }) => {
        await need('plumes');
        const [plumes, attribs] = await Promise.all([
            query(`SELECT * FROM 'plumes.parquet'`),
            loadAttributions(),
        ]);
        // attributed plumes read as filled discs against the hollow rings of the rest
        for (const p of plumes) if (attribs.has(p.id)) p.attr = 1;
        return { plumes: fc(plumes) };
    },

    layers: SRCS.map(src => ({
        id: `plumes-${src}`, type: 'circle', source: 'plumes',
        filter: ['==', ['get', 'src'], src], filtered: true,
        hover: p => `<span class="dd-title">${rateT(p)} t/hr</span><br>${LABEL[p.src]}${p.dt ? ' · ' + p.dt : ''}`,
        paint: {
            'circle-radius': radius,
            'circle-color': COLOR[src],
            'circle-opacity': ['case', ['==', ['get', 'attr'], 1], 0.3, 0],
            'circle-stroke-color': COLOR[src],
            'circle-stroke-width': 1.5,
            'circle-stroke-opacity': 0.75,
        },
    })),

    filters: [
        {
            key: 'attr', label: 'Attribution', value: 'all',
            options: [{ value: 'all', label: 'All' }, { value: 'yes', label: 'Attributed' }],
            expr: v => v === 'yes' ? ['==', ['get', 'attr'], 1] : null,
        },
        {
            key: 'date', label: 'Date', value: 'all',
            options: [{ value: 'all', label: 'All' }, { value: '2025', label: "'25" },
                      { value: '2026', label: "'26" }, { value: '60d', label: '-60d' }],
            expr: v => v === 'all' ? null
                : v === '60d' ? ['>=', ['get', 'dt'], new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10)]
                : ['==', ['slice', ['get', 'dt'], 0, 4], v],
        },
        {
            key: 'rate', label: 'Rate (t/hr)', value: 'all',
            options: [{ value: 'all', label: 'All' }, { value: '1', label: '>1' }, { value: '5', label: '>5' },
                      { value: '10', label: '>10' }, { value: '20', label: '>20' }],
            expr: v => v === 'all' ? null : ['>=', ['get', 'rate'], Number(v) * 1000],
        },
    ],

    key: ctx => [
        {
            label: 'Rate (t/hr)',
            rows: [[16, '10+'], [11, '5'], [7, '1'], [4, '< 0.5']].map(([size, label]) =>
                ({ swatch: { ring: dd.adjusted.white, size }, label })),
        },
        {
            label: 'Source',
            rows: SRCS.filter(src => src !== 'ghgsat' || ctx.sources.plumes.features.some(f => f.properties.src === 'ghgsat'))
                .map(src => ({ swatch: { ring: COLOR[src] }, label: LABEL[src], toggle: `plumes-${src}` })),
        },
        {
            label: 'Infrastructure',
            rows: [{ swatch: { mark: 'waypoint', color: dd.adjusted.white }, label: 'Candidate sources' }],
        },
    ],

    table: [
        {
            label: 'Detections',
            rows: ({ sources }) => sources.plumes.features.map(f => f.properties),
            cols: ['id', 'src', 'dt', 'rate', 'sat', 'sec', 'lat', 'lon'],
        },
        {
            label: 'Attributions',
            rows: async ({ query, need }) => {
                await need('attributions');
                return query(`SELECT id, source_label, source_kind, operator, confidence, verified, lat, lon
                              FROM 'attributions.parquet' ORDER BY source_label`);
            },
        },
    ],

    detail: {
        layers: SRCS.map(src => `plumes-${src}`),
        hashKey: 'plume', flyZoom: 15,
        title: p => ({ text: p.id || '—', href: sourceUrl(p) }),
        html: p => `
            <div class="fd-badges">
                <span style="color:${COLOR[p.src]}">${LABEL[p.src] || escapeHtml(p.src)}</span>
                ${p.sec ? `<span class="dd-secondary">${SECTOR[p.sec] || escapeHtml(p.sec)}</span>` : ''}
            </div>
            <div class="fd-stats">
                <div><div class="fd-stat-big">${rateT(p)}</div><div class="dd-secondary">t/hr</div></div>
                <div id="stat-wind"><div class="fd-stat-big">…</div><div class="dd-secondary">wind</div></div>
                <div><div class="fd-stat-big">${escapeHtml(p.sat || '—')}</div><div class="dd-secondary">satellite</div></div>
                <div><div class="fd-stat-big">${escapeHtml(p.dt || '—')}</div><div class="dd-secondary">date</div></div>
            </div>
            <div class="fd-analysis">
                <div class="dd-secondary">Analysis</div>
                <div id="analysis" class="dd-secondary">Loading…</div>
            </div>`,
        onShow: enrich,
        onClose: clearSelection,
    },

    ready: ({ map }) => addCandidateLayers(map),
});
