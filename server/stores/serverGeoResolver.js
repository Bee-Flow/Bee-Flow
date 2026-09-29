// @typecheck
/**
 * Server geo resolver — the platform's one door to IP location.
 *
 * Everything below stores/ and auth/ that needs "where is this address" comes
 * through here, so the layering guard sees a single platform → core edge
 * (the location engine itself lives in core/http/geo/). Two callers:
 *
 *   - the outbound-call ledger (integrationActivityStore and its schema and
 *     overview modules): locateCall / locatePeer, status and attribution;
 *   - signup geo-blocking (auth/signupGuards.js): geoFromIp.
 *
 * All lookups run against the local City + ASN databases (core/http/geo/geoDb.js).
 * Nothing is sent to a third party and nothing is cached: the retired design
 * asked ip-api.com over plain HTTP, which also received the IP of every user
 * who signed up, and kept those IPs in the ip_geo_cache table without ever
 * deleting them (dropped by stores/ipGeoCacheStore.js). The DNS lookup after
 * a call is gone as well: a destination the socket did not report is unknown.
 */

const geo = require('../core/http/geo');

/**
 * Country-level geo for an IP. The signup guard's contract, unchanged:
 * null for a private or unparseable address, otherwise an object whose
 * country_code is null when the database does not know the address.
 *
 * Async because the database loads asynchronously: the first call after boot
 * waits for that load instead of answering "unknown".
 *
 * @param {string} ip
 * @returns {Promise<{ country_code: string|null, country_name: string, region: string|null,
 *                     city: string|null, is_eu: boolean, flag: string } | null>}
 */
async function geoFromIp(ip) {
    if (!ip) return null;
    const cls = geo.classifyIp(ip);
    if (!cls.ip || cls.isPrivate) return null;
    await geo.loadGeoDb();
    const g = geo.lookupIp(cls.ip);
    const cc = (g && g.country_code) || null;
    return {
        country_code: cc,
        country_name: geo.countryName(cc) || 'Unknown',
        region: (g && g.region) || null,
        city: (g && g.city) || null,
        is_eu: geo.isEuEea(cc),
        flag: geo.countryFlag(cc),
    };
}

module.exports = {
    geoFromIp,
    locateCall: geo.locateCall,
    locatePeer: geo.locatePeer,
    loadGeoDb: geo.loadGeoDb,
    geoDbStatus: geo.geoDbStatus,
    geoAttribution: geo.attribution,
    serverOrigin: geo.serverOrigin,
    classifyIp: geo.classifyIp,
    countryFlag: geo.countryFlag,
    countryName: geo.countryName,
    isEuEea: geo.isEuEea,
    EU_EEA_COUNTRIES: geo.EU_EEA_COUNTRIES,
    COUNTRY_NAMES: geo.COUNTRY_NAMES,
};
