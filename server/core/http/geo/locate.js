// @typecheck strict
/**
 * locate — where did the bytes of one outbound call go?
 *
 * Input is what the egress capture saw on the socket (core/http/egressCapture.js):
 * one peer per host+address the call connected to, with the response's edge
 * headers. Nothing is looked up over the network and nothing is resolved
 * again after the call: an address the socket did not report is "unknown".
 *
 * Per peer (locatePeer), first rule that applies:
 *   proxy / child_process basis   → unknown (the real peer is not visible)
 *   no address                    → unknown, basis 'none'
 *   private address (ipClass)     → local
 *   no location database          → unknown, basis 'no_geo_db'
 *   verified edge header, or an
 *   ASN that is a global network  → via_network (at the edge city when known)
 *   country in EU_EEA_COUNTRIES   → eu
 *   any other country             → outside
 *   otherwise                     → unknown
 *
 * Per call (locateCall): the call is as bad as the worst peer that received
 * data: outside > via_network > unknown > eu > local. Peers that only received
 * a GET count only when no peer carried a body. The "primary" peer, which fills
 * the legacy peer_ip / tls_servername columns, is the one on the integration's
 * own registrable domain (auth hosts such as oauth2.googleapis.com skipped).
 */

'use strict';

const geoDb = require('./geoDb');
const { classifyIp } = require('../ipClass');
const { detectEdge } = require('./edgeLocation');
const { globalNetworkForAsn, operatorFor } = require('./networks');
const { isEuEea, countryName } = require('./countries');

/** Worse is higher. */
const RANK = { local: 0, eu: 1, unknown: 2, via_network: 3, outside: 4 };

const AUTH_HOSTS = new Set([
    'oauth2.googleapis.com', 'accounts.google.com',
    'login.microsoftonline.com', 'login.live.com',
]);

// Second-level suffixes under which the registrable domain has three labels.
const MULTI_LABEL_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
    'co.jp', 'com.br', 'com.cn', 'co.in', 'co.za', 'com.mx', 'com.tr', 'co.kr',
    'com.sg', 'com.hk', 'co.il',
]);

/**
 * @typedef {{ state: 'local'|'eu'|'outside'|'via_network'|'unknown', basis: string, ip: string|null,
 *   host: string|null, country_code: string|null, country_name: string|null, region: string|null,
 *   city: string|null, lat: number|null, lon: number|null, asn: number|null, as_org: string|null,
 *   operator: string|null, network: string|null, edge_pop: string|null }} PeerLocation
 */

/**
 * One peer of the probe snapshot.
 * @typedef {{ host?: string|null, ip?: string|null, edge?: Record<string, string|null|undefined>|null,
 *   basis?: string, sentBody?: boolean }} Peer
 */

/** @typedef {{ lookupIp: (ip: string) => ReturnType<typeof geoDb.lookupIp>, status: () => { available: boolean } }} GeoSource */

/**
 * @param {PeerLocation['state']} state
 * @param {string} basis
 * @param {string | null} [ip]
 * @param {string | null} [host]
 * @returns {PeerLocation}
 */
function _blank(state, basis, ip = null, host = null) {
    return {
        state, basis, ip, host,
        country_code: null, country_name: null, region: null, city: null, lat: null, lon: null,
        asn: null, as_org: null, operator: null, network: null, edge_pop: null,
    };
}

/**
 * 'https://api.x.com:443/v1 (Label)' → 'api.x.com'.
 * @param {string | null | undefined} endpoint
 */
function hostOf(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return null;
    const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\s*\(.*\)\s*$/, '')
        .split('/')[0].replace(/:\d+$/, '').trim().toLowerCase();
    return host || null;
}

/**
 * 'api.eu.fireflies.ai' → 'fireflies.ai'; 'a.b.co.uk' → 'b.co.uk'; an IP stays itself.
 * @param {string | null | undefined} host
 */
function registrableDomain(host) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!h || classifyIp(h).ip) return h || null;
    const labels = h.split('.');
    if (labels.length <= 2) return h;
    return MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? labels.slice(-3).join('.') : labels.slice(-2).join('.');
}

/**
 * Locate one peer.
 * @param {Peer} peer  { host, ip, edge, basis, sentBody, … } from the probe snapshot
 * @param {{ geo?: GeoSource }} [opts]
 * @returns {PeerLocation}
 */
function locatePeer(peer, { geo = geoDb } = {}) {
    const host = peer && peer.host ? String(peer.host).toLowerCase() : null;
    const peerBasis = (peer && peer.basis) || 'socket';
    const cls = classifyIp(peer && peer.ip);
    if (peerBasis === 'proxy' || peerBasis === 'child_process') return _blank('unknown', peerBasis, cls.ip, host);
    if (!cls.ip) return _blank('unknown', 'none', null, host);
    if (cls.isPrivate) return _blank('local', peerBasis, cls.ip, host);

    const g = geo.lookupIp(cls.ip);
    const asn = g && Number.isInteger(g.asn) ? g.asn : null;
    const out = _blank('unknown', peerBasis, cls.ip, host);
    out.asn = asn;
    out.as_org = (g && g.as_org) || null;
    out.operator = operatorFor(cls.ip, asn);
    if (!geo.status().available) {
        out.basis = 'no_geo_db';
        return out;
    }

    const edge = detectEdge(peer.edge, asn);
    const network = edge ? edge.network : globalNetworkForAsn(asn);
    if (network) {
        // An anycast prefix has no meaningful registered country (DB-IP puts
        // all of Cloudflare in Toronto): only a verified edge gives a place.
        const place = edge && edge.place;
        return {
            ...out,
            state: 'via_network',
            basis: edge && edge.edge_pop ? 'edge_header' : peerBasis,
            network,
            edge_pop: edge ? edge.edge_pop : null,
            country_code: place ? place.country_code : null,
            country_name: place ? countryName(place.country_code) : null,
            city: place ? place.city : null,
            lat: place ? place.lat : null,
            lon: place ? place.lon : null,
        };
    }

    const cc = g && g.country_code;
    if (!cc) return out;
    return {
        ...out,
        state: isEuEea(cc) ? 'eu' : 'outside',
        country_code: cc,
        country_name: countryName(cc),
        region: g.region || null,
        city: g.city || null,
        lat: g.lat ?? null,
        lon: g.lon ?? null,
    };
}

/**
 * Index of the primary peer (see the header).
 * @param {Array<{ host: string | null, sentBody: boolean }>} peers
 * @param {string | null | undefined} serverEndpoint
 */
function _primaryIndex(peers, serverEndpoint) {
    const target = hostOf(serverEndpoint);
    const domain = target ? registrableDomain(target) : null;
    if (target) {
        const exact = peers.findLastIndex(p => p.host === target);
        if (exact !== -1) return exact;
    }
    if (domain) {
        const same = (/** @type {{ host: string | null }} */ p) => p.host && !AUTH_HOSTS.has(p.host) && registrableDomain(p.host) === domain;
        const withBody = peers.findLastIndex(p => same(p) && p.sentBody);
        if (withBody !== -1) return withBody;
        const any = peers.findLastIndex(same);
        if (any !== -1) return any;
    }
    const lastBody = peers.findLastIndex(p => p.sentBody);
    return lastBody !== -1 ? lastBody : peers.length - 1;
}

/**
 * Locate a whole call.
 * @param {{ peers?: Peer[], isLocalHint?: boolean, serverEndpoint?: string|null,
 *           geo?: GeoSource }} input

 * @returns {{ row: PeerLocation, primary: PeerLocation|null, peers: PeerLocation[] }}
 */
function locateCall({ peers, isLocalHint = false, serverEndpoint = null, geo = geoDb } = {}) {
    const list = (Array.isArray(peers) ? peers : []).filter(p => p && typeof p === 'object');
    if (!list.length) {
        return { row: _blank(isLocalHint ? 'local' : 'unknown', 'none'), primary: null, peers: [] };
    }
    const located = list.map(p => locatePeer(p, { geo }));
    const withBody = list.map((p, i) => (p.sentBody ? i : -1)).filter(i => i !== -1);
    const pool = withBody.length ? withBody : located.map((_, i) => i);
    let worst = pool[0];
    for (const i of pool) if (RANK[located[i].state] > RANK[located[worst].state]) worst = i;

    const p = _primaryIndex(list.map(x => ({ host: x.host ? String(x.host).toLowerCase() : null, sentBody: !!x.sentBody })), serverEndpoint);
    const primary = located[p];
    // The row carries the location that decided its state: the primary's when
    // it is that bad, otherwise the worst peer's (operator included, so an
    // Art-44 signal names whoever actually received the data).
    const source = primary.state === located[worst].state ? primary : located[worst];
    return { row: { ...source }, primary, peers: located };
}

module.exports = { locatePeer, locateCall, registrableDomain, hostOf, RANK };
