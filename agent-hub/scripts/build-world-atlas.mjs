#!/usr/bin/env node
/**
 * Vendors the two data files the Privacy Shield egress map needs:
 *
 *   activity/egressMap/worldAtlas.json    the world outline, as plain GeoJSON,
 *                                         each country tagged with its ISO
 *                                         alpha-2 code
 *   activity/egressMap/countryPins.json   alpha-2 code → [lon, lat]
 *
 * WHY THIS EXISTS AT ALL: the design prototype pulled d3, topojson and the
 * world atlas from a CDN at runtime, and hardcoded its two pins. In a
 * self-hosted privacy product the CDN part is two defects: an outbound
 * request from an admin's browser on the one screen that promises data does
 * not leave, and a blank map on an air-gapped install. So the atlas is
 * converted ONCE, here, and committed. The runtime needs only `d3-geo` for
 * the projection; `topojson-client` and `world-atlas` stay devDependencies.
 *
 * WHY EVERY COUNTRY GETS A PIN: the server stores an ISO alpha-2
 * `country_code` per egress row (server/stores/serverGeoResolver.js, and the
 * geo database behind it), and a destination without coordinates of its own
 * falls back to its country's pin. A pin table that only covers "the
 * countries we expect" turns every other country into a hole in an audit
 * map. The atlas identifies countries by ISO 3166-1 NUMERIC id, so the join
 * to alpha-2 happens here, and the script FAILS when an atlas country has no
 * code: a missing pin is a build error, not a silent gap.
 *
 * WHY THE LARGEST POLYGON: `geoCentroid` of a whole MultiPolygon averages
 * every part of it. France's includes French Guiana, which dragged the French
 * pin into northern Spain; Norway's includes Svalbard. The pin is the
 * centroid of the country's largest polygon (by spherical area) instead.
 *
 * Rerun after bumping world-atlas:
 *   npm run build:world-atlas
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoArea, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../src/components/admin/security/guardrails/orgShield/activity/egressMap');

// 110m is the coarsest of the three and the right choice for a card at most
// 440px tall: 50m is 5x the bytes for detail the projection cannot show.
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'));
const fc = feature(topo, topo.objects.countries);

/**
 * ISO 3166-1 numeric → alpha-2, for every id the 110m atlas carries.
 * The three atlas features without an id are handled by name below.
 */
const NUMERIC_TO_ALPHA2 = {
    '004': 'AF', '008': 'AL', '010': 'AQ', '012': 'DZ', '024': 'AO', '031': 'AZ', '032': 'AR',
    '036': 'AU', '040': 'AT', '044': 'BS', '050': 'BD', '051': 'AM', '056': 'BE', '064': 'BT',
    '068': 'BO', '070': 'BA', '072': 'BW', '076': 'BR', '084': 'BZ', '090': 'SB', '096': 'BN',
    '100': 'BG', '104': 'MM', '108': 'BI', '112': 'BY', '116': 'KH', '120': 'CM', '124': 'CA',
    '140': 'CF', '144': 'LK', '148': 'TD', '152': 'CL', '156': 'CN', '158': 'TW', '170': 'CO',
    '178': 'CG', '180': 'CD', '188': 'CR', '191': 'HR', '192': 'CU', '196': 'CY', '203': 'CZ',
    '204': 'BJ', '208': 'DK', '214': 'DO', '218': 'EC', '222': 'SV', '226': 'GQ', '231': 'ET',
    '232': 'ER', '233': 'EE', '238': 'FK', '242': 'FJ', '246': 'FI', '250': 'FR', '260': 'TF',
    '262': 'DJ', '266': 'GA', '268': 'GE', '270': 'GM', '275': 'PS', '276': 'DE', '288': 'GH',
    '300': 'GR', '304': 'GL', '320': 'GT', '324': 'GN', '328': 'GY', '332': 'HT', '340': 'HN',
    '348': 'HU', '352': 'IS', '356': 'IN', '360': 'ID', '364': 'IR', '368': 'IQ', '372': 'IE',
    '376': 'IL', '380': 'IT', '384': 'CI', '388': 'JM', '392': 'JP', '398': 'KZ', '400': 'JO',
    '404': 'KE', '408': 'KP', '410': 'KR', '414': 'KW', '417': 'KG', '418': 'LA', '422': 'LB',
    '426': 'LS', '428': 'LV', '430': 'LR', '434': 'LY', '440': 'LT', '442': 'LU', '450': 'MG',
    '454': 'MW', '458': 'MY', '466': 'ML', '478': 'MR', '484': 'MX', '496': 'MN', '498': 'MD',
    '499': 'ME', '504': 'MA', '508': 'MZ', '512': 'OM', '516': 'NA', '524': 'NP', '528': 'NL',
    '540': 'NC', '548': 'VU', '554': 'NZ', '558': 'NI', '562': 'NE', '566': 'NG', '578': 'NO',
    '586': 'PK', '591': 'PA', '598': 'PG', '600': 'PY', '604': 'PE', '608': 'PH', '616': 'PL',
    '620': 'PT', '624': 'GW', '626': 'TL', '630': 'PR', '634': 'QA', '642': 'RO', '643': 'RU',
    '646': 'RW', '682': 'SA', '686': 'SN', '688': 'RS', '694': 'SL', '703': 'SK', '704': 'VN',
    '705': 'SI', '706': 'SO', '710': 'ZA', '716': 'ZW', '724': 'ES', '728': 'SS', '729': 'SD',
    '732': 'EH', '740': 'SR', '748': 'SZ', '752': 'SE', '756': 'CH', '760': 'SY', '762': 'TJ',
    '764': 'TH', '768': 'TG', '780': 'TT', '784': 'AE', '788': 'TN', '792': 'TR', '795': 'TM',
    '800': 'UG', '804': 'UA', '807': 'MK', '818': 'EG', '826': 'GB', '834': 'TZ', '840': 'US',
    '854': 'BF', '858': 'UY', '860': 'UZ', '862': 'VE', '887': 'YE', '894': 'ZM',
};

/**
 * Atlas features that have no ISO numeric id. Kosovo has the user-assigned
 * code the geo databases use; the other two are not ISO countries at all, so
 * they get no code (and therefore no pin, and never a tint).
 */
const NAME_TO_ALPHA2 = { Kosovo: 'XK', 'N. Cyprus': null, Somaliland: null };

/**
 * Places a server can live in that the 110m atlas has no polygon for, so
 * there is nothing to take a centroid of. Coordinates are the capital.
 */
const MANUAL_PINS = {
    AD: [1.52, 42.51],    // Andorra la Vella
    AW: [-70.03, 12.52],  // Oranjestad
    AX: [19.94, 60.1],    // Mariehamn
    BB: [-59.62, 13.1],   // Bridgetown
    BH: [50.59, 26.23],   // Manama
    BM: [-64.78, 32.29],  // Hamilton
    CW: [-68.93, 12.12],  // Willemstad
    FO: [-6.77, 62.01],   // Torshavn
    GG: [-2.54, 49.46],   // St Peter Port
    GI: [-5.35, 36.14],   // Gibraltar
    HK: [114.17, 22.32],  // Hong Kong
    IM: [-4.48, 54.15],   // Douglas
    JE: [-2.11, 49.19],   // St Helier
    KY: [-81.38, 19.29],  // George Town
    LI: [9.52, 47.14],    // Vaduz
    MC: [7.42, 43.74],    // Monaco
    MO: [113.54, 22.2],   // Macau
    MT: [14.51, 35.9],    // Valletta
    MU: [57.5, -20.16],   // Port Louis
    MV: [73.51, 4.18],    // Male
    SC: [55.45, -4.62],   // Victoria
    SG: [103.82, 1.35],   // Singapore
    SM: [12.45, 43.94],   // San Marino
    VA: [12.45, 41.9],    // Vatican City
};

const codeOf = (f) => {
    if (f.id !== undefined && f.id !== null) return NUMERIC_TO_ALPHA2[String(f.id).padStart(3, '0')];
    const name = f.properties?.name || '';
    return Object.hasOwn(NAME_TO_ALPHA2, name) ? NAME_TO_ALPHA2[name] : undefined;
};

/* ── 1. The outline ──────────────────────────────────────────────────── */

// One decimal place. At this map's scale a tenth of a degree is well under a
// pixel (even at the 8x zoom ceiling), and it roughly halves the file.
const round = (c) => (Array.isArray(c[0]) ? c.map(round) : [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10]);

const missing = [];
const features = fc.features.map((f) => {
    const code = codeOf(f);
    if (code === undefined) missing.push(`atlas id ${f.id ?? '(none)'} "${f.properties?.name}" has no alpha-2 code`);
    return {
        type: 'Feature',
        // `code` tints the countries that received data, `name` is kept for
        // readability of the file. Everything else is dropped.
        properties: { name: f.properties?.name || '', code: code || null },
        geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
    };
});

/* ── 2. The pins ─────────────────────────────────────────────────────── */

/** The largest polygon of a (Multi)Polygon, as its own geometry. */
function largestPart(geometry) {
    if (geometry.type !== 'MultiPolygon') return geometry;
    let best = null;
    let bestArea = -1;
    for (const coordinates of geometry.coordinates) {
        const part = { type: 'Polygon', coordinates };
        const area = geoArea(part);
        if (area > bestArea) { best = part; bestArea = area; }
    }
    return best;
}

const pins = {};
for (const f of fc.features) {
    const code = codeOf(f);
    if (!code || code === 'AQ') continue; // nobody hosts a server in Antarctica
    const [lon, lat] = geoCentroid(largestPart(f.geometry));
    pins[code] = [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100];
}
for (const [code, lonLat] of Object.entries(MANUAL_PINS)) {
    if (pins[code]) missing.push(`${code} has both a polygon and a manual pin; drop the manual one`);
    pins[code] = lonLat;
}

if (missing.length) {
    console.error('The map cannot place these countries:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nFix NUMERIC_TO_ALPHA2 / NAME_TO_ALPHA2 / MANUAL_PINS in this script. A country');
    console.error('without a pin is a hole in an audit map, so this is a build failure, not a warning.');
    process.exit(1);
}

const sortedPins = Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b)));

writeFileSync(resolve(OUT_DIR, 'worldAtlas.json'), JSON.stringify({ type: 'FeatureCollection', features }));
writeFileSync(resolve(OUT_DIR, 'countryPins.json'), `${JSON.stringify(sortedPins)}\n`);

const kb = (p) => (readFileSync(resolve(OUT_DIR, p)).byteLength / 1024).toFixed(0);
console.log(`worldAtlas.json   ${features.length} features, ${kb('worldAtlas.json')} KB`);
console.log(`countryPins.json  ${Object.keys(sortedPins).length} countries, ${kb('countryPins.json')} KB`);
