import { describe, expect, it } from 'vitest';
import { claudeAddCommand, expiryToIso, invalidEntries, ipInList, isValidIpOrCidr, MCP_SERVERS, parseList } from './mcpAccessLib';

describe('parseList', () => {
    it('splits on commas, semicolons, spaces and new lines, and drops empties and duplicates', () => {
        expect(parseList('a, b\nc;; a  d\n')).toEqual(['a', 'b', 'c', 'd']);
        expect(parseList('')).toEqual([]);
    });
});

describe('isValidIpOrCidr', () => {
    it.each([
        '10.0.0.1', '10.0.0.0/8', '0.0.0.0/0', '203.0.113.7/32',
        '::1', '2001:db8::/32', 'fe80::1%eth0', '::ffff:10.1.2.3', '2001:db8:0:0:0:0:0:1', '::',
    ])('accepts %s', (s) => expect(isValidIpOrCidr(s)).toBe(true));

    it.each([
        'banana', '10.0.0', '10.0.0.256', '10.0.0.1/33', '10.0.0.1/', '10.0.0.1/-1', '01.2.3.4',
        '2001:db8::/129', '2001:::1', '1:2:3:4:5:6:7:8:9', '12345::1', 'g::1', '1.2.3.4/8/8',
    ])('rejects %s', (s) => expect(isValidIpOrCidr(s)).toBe(false));

    it('names the entries that are neither an address nor a range', () => {
        expect(invalidEntries(['10.0.0.0/8', 'nope', '::1', '1.2.3'])).toEqual(['nope', '1.2.3']);
    });
});

describe('ipInList', () => {
    it('matches an IPv4 address against a range and a single address', () => {
        expect(ipInList('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
        expect(ipInList('203.0.114.9', ['203.0.113.0/24'])).toBe(false);
        expect(ipInList('198.51.100.4', ['10.0.0.0/8', '198.51.100.4'])).toBe(true);
    });

    it('matches IPv6 against an IPv6 range', () => {
        expect(ipInList('2001:db8::42', ['2001:db8::/32'])).toBe(true);
        expect(ipInList('2001:db9::42', ['2001:db8::/32'])).toBe(false);
    });

    it('treats an IPv4-mapped IPv6 address as the IPv4 address it wraps, on either side', () => {
        expect(ipInList('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true);
        expect(ipInList('203.0.113.9', ['::ffff:203.0.113.9'])).toBe(true);
        expect(ipInList('203.0.113.9', ['::ffff:203.0.113.0/120'])).toBe(true);
    });

    it('never matches across families, an empty list, or an entry that cannot be read', () => {
        expect(ipInList('203.0.113.9', ['2001:db8::/32'])).toBe(false);
        expect(ipInList('2001:db8::1', ['0.0.0.0/0'])).toBe(false);
        expect(ipInList('203.0.113.9', [])).toBe(false);
        expect(ipInList('203.0.113.9', ['garbage'])).toBe(false);
        expect(ipInList('garbage', ['0.0.0.0/0'])).toBe(false);
    });

    it('/0 matches every address of its family', () => {
        expect(ipInList('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
        expect(ipInList('2001:db8::1', ['::/0'])).toBe(true);
    });
});

describe('expiryToIso', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    it('is null for "never" and for a date that was not filled in', () => {
        expect(expiryToIso('none', '', now)).toBeNull();
        expect(expiryToIso('date', '', now)).toBeNull();
    });
    it('counts days from now', () => {
        expect(expiryToIso('30', '', now)).toBe('2026-11-09T12:00:00.000Z');
        expect(expiryToIso('365', '', now)).toBe('2027-10-10T12:00:00.000Z');
    });
    it('turns a date into the end of that day', () => {
        const iso = expiryToIso('date', '2027-01-15', now)!;
        expect(new Date(iso).getTime()).toBe(new Date('2027-01-15T23:59:59').getTime());
    });
});

describe('claudeAddCommand', () => {
    it('builds the command per server path and trims a trailing slash on the origin', () => {
        const cms = MCP_SERVERS.find(s => s.id === 'cms')!;
        expect(claudeAddCommand(cms, 'https://bee.example/', 'bfmcp_x'))
            .toBe('claude mcp add --transport http beeflow-cms https://bee.example/mcp/cms --header "Authorization: Bearer bfmcp_x"');
        expect(claudeAddCommand(MCP_SERVERS[0], 'https://bee.example', 't'))
            .toBe('claude mcp add --transport http beeflow https://bee.example/mcp --header "Authorization: Bearer t"');
    });
});
