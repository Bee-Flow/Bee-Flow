// @typecheck
/**
 * ipClass — is an address one of ours, and which address does it really name?
 *
 * One answer for every caller that has to decide "did this call leave the
 * building" from a raw socket address: the location step
 * (core/http/geo/locate.js), the geo lookup and anything else that meets one.
 *
 * Covered, because each one has been seen on a real socket:
 *   IPv4  0/8 (this network), 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16,
 *         100.64/10 (carrier-grade NAT, also the pod range on Kapsule)
 *   IPv6  ::, ::1, fc00::/7 (unique local), fe80::/10 (link local)
 *   Wrapped IPv4: `::ffff:a.b.c.d` (and its hex form) and NAT64 64:ff9b::/96
 *   are classified by the IPv4 inside them, because that is the host the bytes
 *   reach. A zone id (`fe80::1%eth0`) and brackets are stripped first.
 *
 * Pure, synchronous, no dependencies beyond node:net.
 */

'use strict';

const net = require('node:net');

/** @typedef {'public'|'private'|'loopback'|'link_local'|'cgnat'|'unspecified'|'ula'|'invalid'} IpKind */

/**
 * @typedef {object} IpClass
 * @property {string|null} ip      the address to geolocate: lower-case, no zone id, embedded IPv4 unwrapped
 * @property {4|6|null} family     family of `ip`
 * @property {IpKind} kind
 * @property {boolean} isPrivate   true for every kind except 'public' and 'invalid'
 */

function _v4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const o = Number(p);
        if (o > 255) return null;
        n = n * 256 + o;
    }
    return n;
}

// [base, prefix bits, kind] — checked in order, first match wins.
const V4_RANGES = [
    ['0.0.0.0', 8, 'unspecified'],
    ['10.0.0.0', 8, 'private'],
    ['100.64.0.0', 10, 'cgnat'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link_local'],
    ['172.16.0.0', 12, 'private'],
    ['192.168.0.0', 16, 'private'],
].map(([base, bits, kind]) => {
    const start = /** @type {number} */ (_v4ToInt(String(base)));
    return { start, end: start + 2 ** (32 - Number(bits)) - 1, kind: /** @type {IpKind} */ (kind) };
});

/** @returns {IpKind} */
function _kindV4(ip) {
    const n = _v4ToInt(ip);
    if (n === null) return 'invalid';
    for (const r of V4_RANGES) if (n >= r.start && n <= r.end) return r.kind;
    return 'public';
}

/**
 * Expand an IPv6 address (already validated by net.isIPv6) to eight 16-bit
 * groups. A trailing dotted IPv4 counts as two groups.
 * @returns {number[]|null}
 */
function _v6Groups(ip) {
    let s = ip;
    let tail = [];
    const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) {
        const n = _v4ToInt(dotted[2]);
        if (n === null) return null;
        tail = [Math.floor(n / 65536), n % 65536];
        s = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const parse = (part) => (part ? part.split(':').map(h => parseInt(h, 16)) : []);
    const head = parse(halves[0]);
    const rest = halves.length === 2 ? parse(halves[1]) : [];
    const fill = 8 - head.length - rest.length - tail.length;
    if (halves.length === 1 && fill !== 0) return null;
    if (fill < 0) return null;
    const groups = [...head, ...new Array(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
    if (groups.length !== 8 || groups.some(g => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
    return groups;
}

function _groupsToV4(hi, lo) {
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/** Strip brackets, a zone id and whitespace; lower-case. */
function _clean(raw) {
    let s = String(raw || '').trim();
    if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    return s.toLowerCase();
}

/**
 * Classify an address.
 * @param {unknown} raw
 * @returns {IpClass}
 */
function classifyIp(raw) {
    const s = _clean(raw);
    if (!s) return { ip: null, family: null, kind: 'invalid', isPrivate: false };
    if (net.isIPv4(s)) {
        const kind = _kindV4(s);
        return { ip: s, family: 4, kind, isPrivate: kind !== 'public' && kind !== 'invalid' };
    }
    if (!net.isIPv6(s)) return { ip: null, family: null, kind: 'invalid', isPrivate: false };
    const g = _v6Groups(s);
    if (!g) return { ip: null, family: null, kind: 'invalid', isPrivate: false };

    const zeroTo = (n) => g.slice(0, n).every(x => x === 0);
    // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64 well-known prefix):
    // the IPv4 inside is the real destination.
    const mapped = zeroTo(5) && g[5] === 0xffff;
    const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0);
    if (mapped || nat64) {
        const v4 = _groupsToV4(g[6], g[7]);
        const kind = _kindV4(v4);
        return { ip: v4, family: 4, kind, isPrivate: kind !== 'public' && kind !== 'invalid' };
    }

    /** @type {IpKind} */
    let kind = 'public';
    if (zeroTo(8)) kind = 'unspecified';
    else if (zeroTo(7) && g[7] === 1) kind = 'loopback';
    else if ((g[0] & 0xfe00) === 0xfc00) kind = 'ula';
    else if ((g[0] & 0xffc0) === 0xfe80) kind = 'link_local';
    return { ip: s, family: 6, kind, isPrivate: kind !== 'public' };
}

/** True when the address never leaves the local network (see the ranges above). */
function isPrivateIp(raw) {
    return classifyIp(raw).isPrivate;
}

/**
 * The address a lookup should use: zone id stripped, wrapped IPv4 unwrapped.
 * null when the input is not an IP address.
 */
function canonicalIp(raw) {
    return classifyIp(raw).ip;
}

module.exports = { classifyIp, isPrivateIp, canonicalIp };
