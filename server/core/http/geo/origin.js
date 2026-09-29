// @typecheck
/**
 * origin — where this server stands on the map, from BEEFLOW_SERVER_LOCATION.
 *
 * The "Where your data went" map draws a line from this point to every
 * destination. There is no default: a server cannot know its own location
 * without asking a third party, and a wrong origin (say, NL for a German
 * install) would draw every line from the wrong place. Unset means pins
 * without lines, and the map tells the admin how to set it.
 *
 * Accepted values:
 *   NL                     an ISO 3166 alpha-2 code: the capital as reference
 *                          point, the country name as label
 *   52.37,4.90             a point
 *   52.37,4.90,Haarlem DC  a point with a label (the label may contain commas)
 * Anything else logs one warning and counts as unset.
 */

'use strict';

const log = require('../../../telemetry/log');
const { countryName } = require('./countries');

// Reference point per country: the capital. EU/EEA, CH and GB complete (the
// countries this product is mostly hosted in), plus the usual cloud regions.
const CAPITALS = {
    AT: [48.21, 16.37], BE: [50.85, 4.35], BG: [42.7, 23.32], HR: [45.81, 15.98], CY: [35.17, 33.36],
    CZ: [50.08, 14.44], DK: [55.68, 12.57], EE: [59.44, 24.75], FI: [60.17, 24.94], FR: [48.86, 2.35],
    DE: [52.52, 13.4], GR: [37.98, 23.73], HU: [47.5, 19.04], IE: [53.35, -6.26], IT: [41.9, 12.5],
    LV: [56.95, 24.11], LT: [54.69, 25.28], LU: [49.61, 6.13], MT: [35.9, 14.51], NL: [52.37, 4.9],
    PL: [52.23, 21.01], PT: [38.72, -9.14], RO: [44.43, 26.1], SK: [48.15, 17.11], SI: [46.06, 14.51],
    ES: [40.42, -3.7], SE: [59.33, 18.07], IS: [64.15, -21.94], LI: [47.14, 9.52], NO: [59.91, 10.75],
    CH: [46.95, 7.45], GB: [51.51, -0.13],
    US: [38.9, -77.04], CA: [45.42, -75.7], AU: [-35.28, 149.13], NZ: [-41.29, 174.78], JP: [35.68, 139.69],
    SG: [1.35, 103.82], IN: [28.61, 77.21], BR: [-15.79, -47.88], ZA: [-25.75, 28.19], AE: [24.45, 54.38],
    KR: [37.57, 126.98], HK: [22.32, 114.17], TW: [25.03, 121.57], MX: [19.43, -99.13], TR: [39.93, 32.86],
    UA: [50.45, 30.52], RS: [44.79, 20.45],
};

const _warned = new Set();
function _warnOnce(value, why) {
    if (_warned.has(value)) return;
    _warned.add(value);
    log.warn(`[geo] BEEFLOW_SERVER_LOCATION='${value}' ignored: ${why}. Use an ISO country code (NL) or "lat,lon[,label]".`);
}

/**
 * @param {string|undefined|null} value  defaults to process.env.BEEFLOW_SERVER_LOCATION
 * @returns {{ country_code: string|null, country_name: string|null, lat: number, lon: number, label: string|null } | null}
 */
function serverOrigin(value = process.env.BEEFLOW_SERVER_LOCATION) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    if (/^[a-z]{2}$/i.test(raw)) {
        const cc = raw.toUpperCase();
        const point = CAPITALS[cc];
        if (!point) {
            _warnOnce(raw, `no reference point for ${cc}; give the coordinates instead`);
            return null;
        }
        const name = countryName(cc);
        return { country_code: cc, country_name: name, lat: point[0], lon: point[1], label: name };
    }

    const [a, b, ...rest] = raw.split(',');
    const lat = Number(String(a).trim());
    const lon = Number(String(b ?? '').trim());
    if (b === undefined || String(a).trim() === '' || String(b).trim() === ''
        || !Number.isFinite(lat) || !Number.isFinite(lon)
        || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        _warnOnce(raw, 'not a country code and not a valid "lat,lon"');
        return null;
    }
    const label = rest.join(',').trim() || null;
    return { country_code: null, country_name: null, lat, lon, label };
}

module.exports = { serverOrigin, CAPITALS };
