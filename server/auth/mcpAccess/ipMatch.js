// @typecheck
/**
 * CIDR allow-lists for MCP access (org policy and per-token).
 *
 * Built on Node's net.BlockList, which handles IPv4 and IPv6 subnets natively,
 * so no dependency is added. Two details are handled here rather than left to
 * the caller:
 *
 *   - `req.ip` behind a dual-stack listener arrives as `::ffff:203.0.113.7`.
 *     It is compared as the IPv4 address it is, so a `203.0.113.0/24` entry
 *     matches it.
 *   - A list entry written as an IPv4-mapped IPv6 range (`::ffff:203.0.113.0/120`)
 *     is stored as the IPv4 range it means, for the same reason.
 *
 * An empty list means "no extra restriction". A non-empty list with an
 * unparseable client address denies: fail closed.
 */

'use strict';

const net = require('node:net');
const { badRequest } = require('../../shared/httpErrors');

const MAX_ENTRIES = 100;
const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Drop an IPv6 zone id and unwrap IPv4-mapped IPv6 to plain IPv4. */
function normalizeAddress(raw) {
    if (typeof raw !== 'string') return null;
    let ip = raw.trim();
    const zone = ip.indexOf('%');
    if (zone !== -1) ip = ip.slice(0, zone);
    const mapped = MAPPED_V4.exec(ip);
    if (mapped) ip = mapped[1];
    return net.isIP(ip) ? ip : null;
}

/**
 * One list entry → `{ address, prefix, family }` or null when it is not a valid
 * address or CIDR. A bare address is a single-host range (/32 or /128).
 */
function parseEntry(entry) {
    if (typeof entry !== 'string') return null;
    const text = entry.trim();
    const slash = text.indexOf('/');
    const addrPart = slash === -1 ? text : text.slice(0, slash);
    const prefixPart = slash === -1 ? null : text.slice(slash + 1);
    if (prefixPart !== null && !/^\d{1,3}$/.test(prefixPart)) return null;

    let address = normalizeAddress(addrPart);
    if (!address) return null;
    const wasMapped = MAPPED_V4.test(addrPart.trim());
    let family = net.isIPv4(address) ? 4 : 6;
    let prefix = prefixPart === null ? (family === 4 ? 32 : 128) : Number(prefixPart);
    if (wasMapped) {
        // ::ffff:a.b.c.d/N is the IPv4 range a.b.c.d/(N-96); a prefix shorter
        // than 96 would cover far more than IPv4 and is not expressible here.
        if (prefixPart !== null) {
            if (prefix < 96 || prefix > 128) return null;
            prefix -= 96;
        } else {
            prefix = 32;
        }
        family = 4;
    }
    if (prefix < 0 || prefix > (family === 4 ? 32 : 128)) return null;
    return { address, prefix, family };
}

/**
 * Validate and canonicalise a CIDR list. Returns a de-duplicated array of
 * strings ("203.0.113.0/24", a bare host stays a bare host).
 *
 * @param {unknown} list
 * @returns {string[]}
 * @throws {import('../../shared/httpErrors').HttpError} 400 on a bad list
 */
function parseCidrList(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw badRequest('invalid_ip_allowlist', 'The IP allow-list must be a list of addresses or CIDR ranges.');
    if (list.length > MAX_ENTRIES) throw badRequest('invalid_ip_allowlist', `The IP allow-list can hold at most ${MAX_ENTRIES} entries.`);
    const out = [];
    for (const entry of list) {
        const parsed = parseEntry(entry);
        if (!parsed) {
            const shown = typeof entry === 'string' ? entry.trim().slice(0, 64) : String(entry).slice(0, 64);
            throw badRequest('invalid_ip_allowlist', `"${shown}" is not a valid IP address or CIDR range.`);
        }
        const bare = typeof entry === 'string' && !entry.includes('/');
        const text = bare ? parsed.address : `${parsed.address}/${parsed.prefix}`;
        if (!out.includes(text)) out.push(text);
    }
    return out;
}

const compiled = new Map();

function compile(list) {
    const key = list.join('\n');
    let blockList = compiled.get(key);
    if (blockList) return blockList;
    blockList = new net.BlockList();
    for (const entry of list) {
        const parsed = parseEntry(entry);
        if (!parsed) continue; // a stored entry that no longer parses matches nothing
        blockList.addSubnet(parsed.address, parsed.prefix, parsed.family === 4 ? 'ipv4' : 'ipv6');
    }
    if (compiled.size >= 200) compiled.clear();
    compiled.set(key, blockList);
    return blockList;
}

/**
 * May a client at `ip` pass `list`? Empty list = yes. A non-empty list with a
 * missing or unparseable `ip` = no.
 *
 * @param {string|undefined|null} ip
 * @param {string[]|null|undefined} list
 * @returns {boolean}
 */
function ipAllowed(ip, list) {
    if (!Array.isArray(list) || list.length === 0) return true;
    const address = normalizeAddress(ip);
    if (!address) return false;
    return compile(list).check(address, net.isIPv4(address) ? 'ipv4' : 'ipv6');
}

module.exports = { parseCidrList, ipAllowed, normalizeAddress, MAX_ENTRIES };
