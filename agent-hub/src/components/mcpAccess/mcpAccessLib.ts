// Pure helpers for the MCP access screens (Settings → MCP tokens and
// Organisation → MCP access): list parsing, IP / CIDR validation, "is this
// address inside the list" for the lockout warning, and the `claude mcp add`
// command per server. No React, no network.

import type { McpServerId } from '../../api/queries/mcpAccess';

export interface McpServerInfo {
    id: McpServerId;
    /** Path of the endpoint on the Bee Flow origin. */
    path: string;
    /** Name handed to `claude mcp add`. */
    clientName: string;
}

export const MCP_SERVERS: readonly McpServerInfo[] = [
    { id: 'integrations', path: '/mcp', clientName: 'beeflow' },
    { id: 'automations', path: '/mcp/automations', clientName: 'beeflow-automations' },
    { id: 'studio', path: '/mcp/studio', clientName: 'beeflow-studio' },
    { id: 'cms', path: '/mcp/cms', clientName: 'beeflow-cms' },
];

/** "a, b\nc" → ['a', 'b', 'c']: trimmed, no empties, no duplicates. */
export function parseList(text: string): string[] {
    const seen = new Set<string>();
    for (const part of String(text || '').split(/[\s,;]+/)) {
        const v = part.trim();
        if (v) seen.add(v);
    }
    return [...seen];
}

/** Tool names may be separated by commas or newlines; a name never contains whitespace. */
export const parseToolList = parseList;

interface ParsedIp { version: 4 | 6; value: bigint }

function parseIpv4(s: string): bigint | null {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    let out = 0n;
    for (let i = 1; i <= 4; i++) {
        const n = Number(m[i]);
        if (n > 255 || (m[i].length > 1 && m[i].startsWith('0'))) return null;
        out = (out << 8n) | BigInt(n);
    }
    return out;
}

function parseIpv6(input: string): bigint | null {
    let s = input;
    const zone = s.indexOf('%');
    if (zone >= 0) s = s.slice(0, zone);
    if (!s.includes(':')) return null;
    // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
    const lastColon = s.lastIndexOf(':');
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
        const v4 = parseIpv4(tail);
        if (v4 === null) return null;
        const hi = ((v4 >> 16n) & 0xffffn).toString(16);
        const lo = (v4 & 0xffffn).toString(16);
        s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const toGroups = (h: string) => (h === '' ? [] : h.split(':'));
    const head = toGroups(halves[0]);
    const rest = halves.length === 2 ? toGroups(halves[1]) : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
    const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...rest];
    let out = 0n;
    for (const g of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        out = (out << 16n) | BigInt(parseInt(g, 16));
    }
    return out;
}

const V4_MAPPED_PREFIX = 0xffffn << 32n;

/** An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is the IPv4 address it wraps. */
function parseIp(input: string): ParsedIp | null {
    const s = input.trim();
    const v4 = parseIpv4(s);
    if (v4 !== null) return { version: 4, value: v4 };
    const v6 = parseIpv6(s);
    if (v6 === null) return null;
    if ((v6 >> 32n) === (V4_MAPPED_PREFIX >> 32n)) return { version: 4, value: v6 & 0xffffffffn };
    return { version: 6, value: v6 };
}

interface ParsedCidr extends ParsedIp { prefix: number }

function parseCidr(input: string): ParsedCidr | null {
    const s = input.trim();
    const slash = s.indexOf('/');
    const addr = slash >= 0 ? s.slice(0, slash) : s;
    const ip = parseIp(addr);
    if (!ip) return null;
    const wasMapped = ip.version === 4 && addr.includes(':');
    const max = ip.version === 4 ? 32 : 128;
    if (slash < 0) return { ...ip, prefix: max };
    const raw = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw)) return null;
    let prefix = Number(raw);
    // ::ffff:1.2.3.0/120 is a /24 of the wrapped IPv4 range.
    if (wasMapped) prefix -= 96;
    if (prefix < 0 || prefix > max) return null;
    return { ...ip, prefix };
}

/** True for a plain IPv4 / IPv6 address or a CIDR range of either. */
export function isValidIpOrCidr(s: string): boolean {
    return parseCidr(s) !== null;
}

/** The entries of `list` that are neither an address nor a range. */
export function invalidEntries(list: readonly string[]): string[] {
    return list.filter(e => !isValidIpOrCidr(e));
}

/** Is `ip` inside any of the ranges / addresses in `list`? Unparseable entries match nothing. */
export function ipInList(ip: string, list: readonly string[]): boolean {
    const addr = parseIp(ip);
    if (!addr) return false;
    const bits = addr.version === 4 ? 32 : 128;
    return list.some((entry) => {
        const c = parseCidr(entry);
        if (!c || c.version !== addr.version) return false;
        const shift = BigInt(bits - c.prefix);
        return (addr.value >> shift) === (c.value >> shift);
    });
}

export type ExpiryChoice = 'none' | '30' | '90' | '365' | 'date';

/** The ISO timestamp a token expiry choice means, or null for "never". `now` is injectable for tests. */
export function expiryToIso(choice: ExpiryChoice, date: string, now: Date = new Date()): string | null {
    if (choice === 'none') return null;
    if (choice === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        // End of that day, in the viewer's own time zone.
        return new Date(`${date}T23:59:59`).toISOString();
    }
    return new Date(now.getTime() + Number(choice) * 86_400_000).toISOString();
}

/** `claude mcp add` for one server. */
export function claudeAddCommand(server: McpServerInfo, origin: string, token: string): string {
    return `claude mcp add --transport http ${server.clientName} ${origin.replace(/\/+$/, '')}${server.path} --header "Authorization: Bearer ${token}"`;
}
