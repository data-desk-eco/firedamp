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

// dd flare marking, one size for every plume (rate lives in the key filter
// and the data table); grows gently with zoom, the burnoff ramp
const ICON = ['interpolate', ['linear'], ['zoom'], 2, 0.55, 10, 0.8, 14, 1];

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
        for (const p of plumes) if (attribs.has(p.id)) p.attr = 1;
        // overlapping plumes group into clusters until z11, summing rate
        return { plumes: { data: fc(plumes), cluster: true, clusterMaxZoom: 11, clusterRadius: 30,
                           clusterProperties: { rate_sum: ['+', ['get', 'rate']] } } };
    },

    layers: [
        ...SRCS.map(src => ({
            id: `plumes-${src}`, type: 'symbol', source: 'plumes',
            filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'src'], src]],
            hover: p => `<span class="dd-title">${rateT(p)} t/hr</span><br>${LABEL[p.src]}${p.dt ? ' · ' + p.dt : ''}`,
            layout: {
                'icon-image': `flare-${COLOR[src]}`,
                'icon-size': ICON,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
            },
            // attributed plumes read at full strength against the dimmed rest
            paint: { 'icon-opacity': ['case', ['==', ['get', 'attr'], 1], 1, 0.55] },
        })),
        {
            // white default-state flare with total t/hr up-and-right (dd label rule)
            id: 'plumes-clusters', type: 'symbol', source: 'plumes',
            filter: ['has', 'point_count'],
            layout: {
                'icon-image': `flare-${dd.adjusted.white}`,
                'icon-size': ICON,
                'icon-allow-overlap': true, 'icon-ignore-placement': true,
                'text-field': ['concat',
                    ['number-format', ['/', ['get', 'rate_sum'], 1000], { 'max-fraction-digits': 1 }], ' t/hr'],
                'text-font': ['Montserrat Regular'], 'text-size': 10,
                'text-anchor': 'bottom-left', 'text-offset': [0.7, -0.7],
                'text-allow-overlap': true,
            },
            paint: { 'text-color': dd.adjusted.white },
        },
    ],

    filters: [
        {
            key: 'attr', label: 'Attribution', value: 'all',
            options: [{ value: 'all', label: 'All' }, { value: 'yes', label: 'Attributed' }],
            pred: v => v === 'yes' ? p => p.attr === 1 : null,
        },
        {
            key: 'date', label: 'Date', value: 'all',
            options: [{ value: 'all', label: 'All' }, { value: '2025', label: "'25" },
                      { value: '2026', label: "'26" }, { value: '60d', label: '-60d' }],
            pred: v => v === 'all' ? null
                : v === '60d' ? (cut => p => p.dt >= cut)(new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10))
                : p => (p.dt || '').startsWith(v),
        },
    ],

    key: ctx => [
        {
            // toggleable rate ranges: active rows OR into the data filter
            label: 'Rate (t/hr)',
            rows: [['10+', 10], ['5–10', 5, 10], ['1–5', 1, 5], ['< 1', 0, 1]].map(([label, lo, hi]) => ({
                label, pred: p => p.rate >= lo * 1000 && (!hi || p.rate < hi * 1000),
            })),
        },
        {
            // source rows filter the data too, so clusters re-form without them
            label: 'Source',
            rows: SRCS.filter(src => src !== 'ghgsat' || ctx.sources.plumes.features.some(f => f.properties.src === 'ghgsat'))
                .map(src => ({ swatch: { mark: 'flare', color: COLOR[src] }, label: LABEL[src], pred: p => p.src === src })),
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
                return query(`SELECT id, source_label, source_kind, operator, confidence, lat, lon
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

    ready: ({ map }) => {
        addCandidateLayers(map);
        map.on('click', 'plumes-clusters', async e => {
            const f = e.features[0];
            map.flyTo({ center: f.geometry.coordinates,
                zoom: await map.getSource('plumes').getClusterExpansionZoom(f.properties.cluster_id) });
        });
        map.on('mouseenter', 'plumes-clusters', () => map.getCanvas().style.cursor = 'pointer');
        map.on('mouseleave', 'plumes-clusters', () => map.getCanvas().style.cursor = '');
    },
});
