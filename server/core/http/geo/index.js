// @typecheck
/**
 * core/http/geo — local IP location for the outbound-call ledger.
 *
 *   geoDb.js         the MaxMind-format City + ASN files, loaded async, hot-reloaded
 *   edgeLocation.js  CDN edge headers → POP, checked against the address's ASN
 *   networks.js      global-network ASNs and operator labels
 *   locate.js        one peer / one call → local | eu | outside | via_network | unknown
 *   countries.js     the EU/EEA set, names, flags
 *   origin.js        this server's own point on the map (BEEFLOW_SERVER_LOCATION)
 *   geoDbFetch.js    the DB-IP Lite downloader (geo:fetch, opt-in monthly refresh)
 *   ../ipClass.js    private / loopback / CGNAT / wrapped-IPv4 classification
 *
 * The platform side (stores/, auth/) reaches all of this through ONE module,
 * stores/serverGeoResolver.js, so the layering guard sees one edge.
 */

'use strict';

const geoDb = require('./geoDb');
const { classifyIp } = require('../ipClass');
const { locatePeer, locateCall, registrableDomain, hostOf, RANK } = require('./locate');
const { EU_EEA_COUNTRIES, COUNTRY_NAMES, countryName, countryFlag, isEuEea } = require('./countries');
const { serverOrigin } = require('./origin');

/**
 * Attribution for the loaded database. DB-IP Lite is CC BY 4.0 and requires
 * it; a MaxMind file gets MaxMind's line instead.
 */
function attribution(edition = geoDb.status().edition) {
    const e = String(edition || '').toLowerCase();
    if (e.startsWith('geolite2')) {
        return { text: 'This product includes GeoLite2 data created by MaxMind', url: 'https://www.maxmind.com' };
    }
    if (e.startsWith('geoip2')) return { text: 'IP geolocation by MaxMind', url: 'https://www.maxmind.com' };
    return { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' };
}

module.exports = {
    loadGeoDb: geoDb.load,
    classifyIp,
    lookupIp: geoDb.lookupIp,
    geoDbStatus: geoDb.status,
    locatePeer,
    locateCall,
    registrableDomain,
    hostOf,
    RANK,
    attribution,
    serverOrigin,
    EU_EEA_COUNTRIES,
    COUNTRY_NAMES,
    countryName,
    countryFlag,
    isEuEea,
};
