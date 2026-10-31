/**
 * The address table's less common rows: IPv6 prefixes that carry an IPv4
 * address (NAT64, 6to4) are judged by that address; site-local and multicast
 * are refused; the IPv4 special-purpose blocks are refused; their neighbours
 * stay public.
 *
 * Run: cd server && node --test core/http/ssrfGuardParseIPv6.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isForbiddenAddress } = require('./ssrfGuard');

test('IPv6 prefixes carrying an IPv4 address are judged by that address', () => {
    const forbidden = [
        '64:ff9b::7f00:1',          // NAT64 → 127.0.0.1
        '64:ff9b::127.0.0.1',       // same, dotted tail
        '64:ff9b::a9fe:a9fe',       // NAT64 → 169.254.169.254
        '64:ff9b:1::1',             // local-use NAT64 block, always private
        '2002:7f00:1::',            // 6to4 → 127.0.0.1
        '2002:a00:1::1',            // 6to4 → 10.0.1.0
        '2002:a9fe:a9fe::',         // 6to4 → 169.254.169.254
    ];
    for (const ip of forbidden) assert.equal(isForbiddenAddress(ip), true, `must forbid ${ip}`);
    const allowed = [
        '64:ff9b::808:808',         // NAT64 → 8.8.8.8
        '64:ff9b::93.184.216.34',
        '2002:808:808::',           // 6to4 → 8.8.8.8
    ];
    for (const ip of allowed) assert.equal(isForbiddenAddress(ip), false, `must allow ${ip}`);
});

test('site-local and multicast IPv6 are refused; ordinary global unicast is not', () => {
    for (const ip of ['fec0::1', 'feff::1', 'ff02::1', 'ff0e::1']) {
        assert.equal(isForbiddenAddress(ip), true, `must forbid ${ip}`);
    }
    for (const ip of ['fe00::1', 'fe7f::1', '2606:4700:4700::1111', '2a00:1450:400e::1']) {
        assert.equal(isForbiddenAddress(ip), false, `must allow ${ip}`);
    }
});

test('IPv4 special-purpose blocks are refused; their neighbours stay public', () => {
    const forbidden = [
        '192.0.0.1', '192.0.0.255',             // 192.0.0.0/24
        '198.18.0.1', '198.19.255.255',         // 198.18.0.0/15
        '224.0.0.1', '239.255.255.255',         // multicast
        '240.0.0.1', '255.255.255.254',         // reserved
        '255.255.255.255',                      // broadcast
    ];
    for (const ip of forbidden) assert.equal(isForbiddenAddress(ip), true, `must forbid ${ip}`);
    const allowed = [
        '192.0.1.1', '191.255.255.255',         // around 192.0.0.0/24
        '198.17.255.255', '198.20.0.1',         // around 198.18.0.0/15
        '223.255.255.255',                      // last unicast before multicast
        '192.0.2.1',                            // documentation block: routable in theory, not in the table
    ];
    for (const ip of allowed) assert.equal(isForbiddenAddress(ip), false, `must allow ${ip}`);
});
