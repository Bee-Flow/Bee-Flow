/**
 * Link-local and cloud-metadata addresses, for outbound paths that may reach
 * private networks on purpose (a self-hosted Nextcloud on the LAN, a Firebird
 * server next to Bee Flow) but never the link-local range: 169.254.0.0/16,
 * fe80::/10, the IPv6 metadata address fd00:ec2::254, and the same addresses
 * spelled as IPv4-mapped IPv6.
 *
 * `isLinkLocalOrMetadataAddress` is the literal check; `resolveHostAddresses`
 * returns every address a host name resolves to (a literal is returned as is).
 */

import dns from 'node:dns';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type HostClass = { kind: 'ip4' | 'ip6' | 'name'; canonical: string | null };
const { normalizeHostname } = nodeRequire('./ssrfGuard.js') as { normalizeHostname: (host: unknown) => HostClass };
const { parseIPv6 } = nodeRequire('./ssrfGuardParseIPv6.js') as { parseIPv6: (text: string) => number[] | null };

// Names that only mean "the cloud metadata service".
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data', 'metadata']);

function v4LinkLocal(a: number, b: number): boolean {
    return a === 169 && b === 254;
}

/** True for a literal link-local or metadata address in any spelling, or a metadata host name. */
export function isLinkLocalOrMetadataAddress(host: unknown): boolean {
    const raw = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (METADATA_NAMES.has(raw)) return true;
    const { kind, canonical } = normalizeHostname(raw);
    if (kind === 'name') return false;
    // A literal that does not parse is refused rather than guessed at.
    if (canonical === null) return true;
    if (kind === 'ip4') {
        const [a, b] = canonical.split('.').map(Number);
        return v4LinkLocal(a, b) || canonical === '100.100.100.200';
    }
    const bytes = parseIPv6(canonical);
    if (bytes === null) return true;
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10
    if (canonical === 'fd00:ec2::254') return true;
    const mapped = bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    return mapped && v4LinkLocal(bytes[12], bytes[13]);
}

type LookupAll = (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>;

/** Every address `host` stands for: the literal itself, or all DNS answers. */
export async function resolveHostAddresses(host: string, lookup: LookupAll = (h, o) => dns.promises.lookup(h, o)): Promise<string[]> {
    const { kind, canonical } = normalizeHostname(host);
    if (kind !== 'name') return canonical === null ? [] : [canonical];
    const answers = await lookup(canonical ?? host, { all: true });
    return answers.map((a) => a.address);
}
