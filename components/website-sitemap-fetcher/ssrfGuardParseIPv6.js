// @typecheck strict
/**
 * Numeric IP parsing for the SSRF guard (core/http/ssrfGuard.js): inet_aton IPv4 spellings, IPv6 groups
 * with an embedded IPv4 tail, and the IPv4 and IPv6 range tables. Pure functions, no DNS.
 */

'use strict';

/**
 * Parses one dot-separated part in decimal / 0x-hex / 0-octal form.
 * Returns null when the part is not a clean numeric token.
 * @param {string} part
 * @returns {number | null}
 */
function parseIPv4Part(part) {
    if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
    if (/^0[0-7]*$/.test(part)) return parseInt(part, 8);
    if (/^[1-9][0-9]*$/.test(part)) return parseInt(part, 10);
    return null;
}

// inet_aton: 1 part = 32-bit value, 2 parts = a.b24, 3 parts = a.b.c16,
// 4 parts = dotted quad. Returns the address as an unsigned 32-bit int,
// or null when any part is malformed / out of range.
/**
 * @param {string[]} parts
 * @returns {number | null}
 */
function parseIPv4Numeric(parts) {
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > 4) return null;
    /** @type {number[]} */
    const nums = [];
    for (const p of parts) {
        const v = parseIPv4Part(p);
        if (v === null || !Number.isFinite(v)) return null;
        nums.push(v);
    }
    // The final part covers all remaining bytes; the leading parts are octets.
    const last = nums[nums.length - 1];
    if (last < 0 || last >= 2 ** (8 * (4 - (nums.length - 1)))) return null;
    let n = last;
    for (let i = 0; i < nums.length - 1; i++) {
        if (nums[i] < 0 || nums[i] > 255) return null;
        n += nums[i] * 2 ** (8 * (3 - i));
    }
    return n >>> 0;
}

/** @param {number} n @returns {string} */
function formatIPv4(n) {
    return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

// True when the label could plausibly be a numeric IPv4 part — even an
// invalid one like "08" or "0x". Hosts made entirely of such labels are
// treated as (possibly malformed) IPs, never as DNS names.
/** @param {string} label @returns {boolean} */
function looksNumericLabel(label) {
    return /^0x[0-9a-f]*$/i.test(label) || /^[0-9]+$/.test(label);
}

// Returns a 16-entry byte array, or null when malformed. Accepts an
// embedded IPv4 tail ("::ffff:127.0.0.1") and strips %zone identifiers.
/**
 * @param {string} input
 * @returns {number[] | null}
 */
function parseIPv6(input) {
    let s = String(input);
    const zone = s.indexOf('%');
    if (zone !== -1) s = s.slice(0, zone);
    if (!s) return null;

    let head = s;
    /** @type {string | null} */
    let tail = null;
    const dc = s.indexOf('::');
    if (dc !== -1) {
        if (s.indexOf('::', dc + 1) !== -1) return null;
        head = s.slice(0, dc);
        tail = s.slice(dc + 2);
    }

    /**
     * @param {string} part
     * @param {boolean} v4TailAllowed
     * @returns {number[] | null}
     */
    const parseGroups = (part, v4TailAllowed) => {
        if (part === '') return [];
        const segs = part.split(':');
        /** @type {number[]} */
        const out = [];
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            if (v4TailAllowed && i === segs.length - 1 && seg.includes('.')) {
                const v4 = parseIPv4Numeric(seg.split('.'));
                if (v4 === null) return null;
                out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
            out.push(parseInt(seg, 16));
        }
        return out;
    };

    const headGroups = parseGroups(head, tail === null);
    if (headGroups === null) return null;
    /** @type {number[]} */
    let groups;
    if (tail === null) {
        if (headGroups.length !== 8) return null;
        groups = headGroups;
    } else {
        const tailGroups = parseGroups(tail, true);
        if (tailGroups === null) return null;
        if (headGroups.length + tailGroups.length > 7) return null;
        const fill = new Array(8 - headGroups.length - tailGroups.length).fill(0);
        groups = [...headGroups, ...fill, ...tailGroups];
    }
    /** @type {number[]} */
    const bytes = [];
    for (const g of groups) {
        bytes.push((g >> 8) & 0xff, g & 0xff);
    }
    return bytes;
}

/** @param {number} n @returns {boolean} */
function isForbiddenIPv4Int(n) {
    const top = n >>> 24;
    if (top === 0) return true;                                   // 0.0.0.0/8
    if (top === 10) return true;                                  // 10.0.0.0/8
    if (top === 127) return true;                                 // 127.0.0.0/8
    if (((n & 0xffc00000) >>> 0) === 0x64400000) return true;     // 100.64.0.0/10 (CGNAT)
    if ((n >>> 16) === 0xa9fe) return true;                       // 169.254.0.0/16
    if (((n & 0xfff00000) >>> 0) === 0xac100000) return true;     // 172.16.0.0/12
    if ((n >>> 16) === 0xc0a8) return true;                       // 192.168.0.0/16
    if ((n >>> 8) === 0xc00000) return true;                      // 192.0.0.0/24 (IETF protocol assignments)
    if (((n & 0xfffe0000) >>> 0) === 0xc6120000) return true;     // 198.18.0.0/15 (benchmarking)
    if (top >= 224) return true;                                  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
    return false;
}

/** The 32-bit IPv4 address at byte offset `i`. @param {number[]} bytes @param {number} i */
function ipv4At(bytes, i) {
    return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}

/**
 * The IPv4 address an IPv6 prefix carries, or null when it carries none.
 * Mapped (::ffff:a.b.c.d), deprecated compat (::a.b.c.d), the well-known
 * NAT64 prefix (64:ff9b::/96) and 6to4 (2002::/16): the host the bytes
 * reach is that address, so it is the one screened against the IPv4 table.
 * @param {number[]} bytes @param {number} leadingZeroBytes @returns {number | null}
 */
function embeddedIPv4(bytes, leadingZeroBytes) {
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return ipv4At(bytes, 2);                       // 2002::/16
    const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b;
    if (nat64 && bytes.slice(4, 12).every(b => b === 0)) return ipv4At(bytes, 12);             // 64:ff9b::/96
    if (leadingZeroBytes >= 10 && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4At(bytes, 12); // ::ffff:a.b.c.d
    if (leadingZeroBytes >= 12) return ipv4At(bytes, 12);                                       // ::a.b.c.d compat
    return null;
}

// IPv6 prefixes that never name a public host, as [mask, value] on the first
// two bytes: link-local fe80::/10, deprecated site-local fec0::/10, unique
// local fc00::/7, multicast ff00::/8, and the local-use NAT64 block
// 64:ff9b:1::/48 (checked on its first six bytes).
const FORBIDDEN_V6_PREFIXES = [
    [[0xff, 0xfe], [0xc0, 0x80]],
    [[0xff, 0xfe], [0xc0, 0xc0]],
    [[0xfe, 0xfc], [0x00, 0x00]],
    [[0xff, 0xff], [0x00, 0x00]],
];
const LOCAL_USE_NAT64 = [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01];

/** @param {number[]} bytes @returns {boolean} */
function hasForbiddenIPv6Prefix(bytes) {
    if (LOCAL_USE_NAT64.every((b, i) => bytes[i] === b)) return true;
    return FORBIDDEN_V6_PREFIXES.some(([[m0, v0], [m1, v1]]) => (bytes[0] & m0) === v0 && (bytes[1] & m1) === v1);
}

/** @param {number[]} bytes @returns {boolean} */
function isForbiddenIPv6Bytes(bytes) {
    let leadingZeroBytes = 0;
    while (leadingZeroBytes < 16 && bytes[leadingZeroBytes] === 0) leadingZeroBytes++;
    if (leadingZeroBytes === 16) return true;                     // :: unspecified
    if (leadingZeroBytes === 15 && bytes[15] === 1) return true;  // ::1 loopback
    if (hasForbiddenIPv6Prefix(bytes)) return true;
    const v4 = embeddedIPv4(bytes, leadingZeroBytes);
    return v4 !== null && isForbiddenIPv4Int(v4);
}

module.exports = { parseIPv4Numeric, formatIPv4, looksNumericLabel, parseIPv6, isForbiddenIPv4Int, isForbiddenIPv6Bytes };
