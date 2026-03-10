// ---------------------------------------------------------------------------
// Custom overlay layers — loaded via ?layer=<slug>
//
// Each key is a URL slug. Value: { color, sites, filterRadius, ... }
// - sites: [{ name, lat, lon }, ...] — static site markers with labels
// - sitesUrl: 'path.json' — load [[lon, lat], ...] for proximity filtering
// - ogimOperators: [...] — highlight matching OGIM wells/facilities
// - filterRadius: km — only show plumes within this radius of any site
//
// Usage: https://research.datadesk.eco/firedamp/?layer=permian-fieldwork
// ---------------------------------------------------------------------------

const CUSTOM_LAYERS = {

    'permian-fieldwork': {
        color: '#00ff00',
        filterRadius: 10,
        sites: [
            { name: 'BPX Bingo CDP', lat: 31.8464, lon: -103.8811 },
            { name: 'BPX Checkmate CDP', lat: 31.7773, lon: -103.9326 },
            { name: 'BPX Bishop SWD', lat: 31.7783, lon: -103.9292 },
            { name: 'BPX State Ella Mae', lat: 31.8541, lon: -103.9399 },
            { name: 'BPX Scooter', lat: 31.8045, lon: -103.8744 },
            { name: 'BPX Momentum/Chevy Lowe Rider', lat: 31.8495, lon: -103.8751 },
            { name: 'BPX Gretchen Northrup', lat: 31.7814, lon: -103.9113 },
            { name: 'BPX State Barlow', lat: 31.7758, lon: -103.9383 },
            { name: 'Cimarex Logan', lat: 31.6429, lon: -103.8487 },
            { name: 'ET Keystone', lat: 31.9472, lon: -103.0429 },
            { name: 'ET Station 10', lat: 31.3112, lon: -103.1460 },
            { name: 'ET Waha Gas Plant', lat: 31.2699, lon: -103.0876 },
            { name: 'Enterprise Leonidis', lat: 31.8544, lon: -101.8015 },
            { name: 'Enterprise Delaware Basin', lat: 31.2840, lon: -103.1071 },
            { name: 'ETC Red Lake', lat: 32.3256, lon: -101.8233 },
            { name: 'ETC Bear', lat: 31.7734, lon: -103.9018 },
            { name: 'ETC Arrowhead', lat: 31.2921, lon: -103.1505 },
            { name: 'XTO Jim Mims', lat: 32.3122, lon: -101.8214 },
            { name: 'XTO Tank Battery 342 (Poker Lake)', lat: 32.2065, lon: -103.8550 },
            { name: 'XTO Poker Lake past Tiger', lat: 32.1131, lon: -103.9149 },
            { name: 'XTO Cowboy CDP', lat: 32.1597, lon: -103.8421 },
            { name: 'XTO Tiger', lat: 32.1182, lon: -103.9073 },
            { name: 'XTO Highlander', lat: 32.2047, lon: -103.8709 },
            { name: 'XTO Coyote', lat: 31.2532, lon: -103.0831 },
            { name: 'XTO Kriti Site', lat: 31.2558, lon: -103.0693 },
            { name: 'Targa Greenwood', lat: 31.9783, lon: -101.8771 },
            { name: 'Targa Hopson Plant', lat: 31.8515, lon: -101.8017 },
            { name: 'Unknown SWD', lat: 32.3220, lon: -101.8256 },
            { name: 'Unknown production well', lat: 31.8576, lon: -103.8317 },
        ]
    },

    'diamondback': {
        color: '#00ff66',
        filterRadius: 0.5,
        sitesUrl: 'data/diamondback-sites.json',
        ogimOperators: [
            'DIAMONDBACK E&P LLC',
            'DIAMONDBACK EYP LLC',
            'DIAMONDBACK OPERATING, LP',
            'ENDEAVOR ENERGY RESOURCES L.P.',
            'ENDEAVOR ENERGY RESOURCES LP',
            'ENDEAVOR ENERGY RESOURCES, LP',
            'ENDEAVOR NATURAL GAS, LP',
            'ENDEAVOR NATURAL GAS LLC',
            'ENDEAVOR NATURAL GAS, LLC',
        ]
    },

};
