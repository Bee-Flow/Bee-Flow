// @typecheck
/**
 * edgeLocation — which edge of a global network answered, from its headers.
 *
 * CDNs stamp the point of presence on every response:
 *   cf-ray          8c1d2f3a4b5c6d7e-AMS          Cloudflare
 *   x-amz-cf-pop    AMS50-P2                      Amazon CloudFront
 *   x-served-by     cache-ams21052-AMS[, …]       Fastly (the last one served us)
 *   x-vercel-id     fra1::iad1::abc-123           Vercel (the first region is the edge)
 *   fly-request-id  01J…-ams                      Fly.io
 *   x-msedge-ref    Ref A: … Ref B: AMS30EDGE…    Microsoft Front Door
 *   x-azure-ref     (opaque)                      Microsoft Front Door, no POP
 * The code is an IATA airport code; iataAirports.json (OurAirports, public
 * domain) turns it into a city and a point.
 *
 * A header is only believed when the ASN of the address matches the network
 * that sets it: any server can send `cf-ray: 0-AMS`, and without this check a
 * US endpoint could present itself as Amsterdam. Vercel serves from Amazon
 * address space (AS16509 in DB-IP), so its header counts only there AND with
 * `server: Vercel`; Fly.io only from its own AS40509.
 */

'use strict';

const AIRPORTS = require('./iataAirports.json');

const AMAZON = [16509, 14618];
const MICROSOFT = [8075, 8068];

/**
 * @typedef {object} EdgeRule
 * @property {string} header
 * @property {string} network
 * @property {number[]} asns
 * @property {(value: string) => string|null} pop  POP code from the header value, or null
 * @property {RegExp} [server]                    required `server` header, when the header alone is too generic
 */

/** @type {EdgeRule[]} */
const RULES = [
    { header: 'cf-ray', network: 'Cloudflare', asns: [13335, 209242], pop: v => _m(v, /^[0-9a-f]+-([a-z]{3})$/i) },
    { header: 'x-amz-cf-pop', network: 'Amazon CloudFront', asns: AMAZON, pop: v => _m(v, /^([a-z]{3})\d*(?:-|$)/i) },
    {
        header: 'x-served-by', network: 'Fastly', asns: [54113],
        pop: v => _m(String(v).split(',').map(s => s.trim()).filter(Boolean).pop() || '', /^cache-[a-z0-9-]*-([a-z]{3})$/i),
    },
    {
        header: 'x-vercel-id', network: 'Vercel', asns: AMAZON, server: /^vercel$/i,
        pop: v => _m(String(v).split('::')[0], /^([a-z]{3})\d+$/i),
    },
    { header: 'fly-request-id', network: 'Fly.io', asns: [40509], pop: v => _m(v, /-([a-z]{3})$/i) },
    { header: 'x-msedge-ref', network: 'Microsoft Front Door', asns: MICROSOFT, pop: v => _m(v, /Ref B:\s*([a-z]{3})/i) },
    { header: 'x-azure-ref', network: 'Microsoft Front Door', asns: MICROSOFT, pop: () => null },
];

function _m(value, re) {
    const hit = String(value || '').trim().match(re);
    return hit ? hit[1].toUpperCase() : null;
}

/** IATA code → { city, country_code, lat, lon } or null. */
function airport(code) {
    const e = code ? AIRPORTS[String(code).toUpperCase()] : null;
    return e ? { city: e[0], country_code: e[1], lat: e[2], lon: e[3] } : null;
}

/**
 * The verified edge for a response, or null.
 * @param {Record<string, string|null|undefined>|null|undefined} edge  lower-cased edge headers (the probe's `peer.edge`)
 * @param {number|null|undefined} asn  ASN of the socket's address
 * @returns {{ network: string, edge_pop: string|null, place: ReturnType<typeof airport> } | null}
 */
function detectEdge(edge, asn) {
    if (!edge || typeof edge !== 'object' || !Number.isInteger(asn)) return null;
    const server = String(edge.server || '').trim();
    // The header plus a matching ASN is enough to name the network; a POP code
    // in it wins over a verified header without one (x-azure-ref).
    let withoutPop = null;
    for (const rule of RULES) {
        const value = edge[rule.header];
        if (!value || !rule.asns.includes(/** @type {number} */ (asn))) continue;
        if (rule.server && !rule.server.test(server)) continue;
        const pop = rule.pop(String(value));
        if (pop) return { network: rule.network, edge_pop: pop, place: airport(pop) };
        withoutPop = withoutPop || { network: rule.network, edge_pop: null, place: null };
    }
    return withoutPop;
}

module.exports = { detectEdge, airport, RULES };
