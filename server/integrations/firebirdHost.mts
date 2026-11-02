/**
 * Where a Firebird connection may go (integrations/firebirdTools.js).
 *
 * A self-hosted server runs inside the customer's network next to the
 * database, so private and LAN addresses are allowed there. In cloud mode
 * (DEPLOYMENT_MODE=cloud, the default) a host that resolves to a private
 * address is refused unless the operator sets FIREBIRD_ALLOW_PRIVATE_HOSTS=1
 * or lists the host in FIREBIRD_ALLOWED_HOSTS. Link-local and metadata
 * addresses are refused in every mode. The caller dials the address returned
 * here, so the connection goes where the check looked.
 */

import { createRequire } from 'node:module';
import { isLinkLocalOrMetadataAddress, resolveHostAddresses } from '../core/http/linkLocalGuard.mts';

const nodeRequire = createRequire(import.meta.url);
const { isForbiddenAddress } = nodeRequire('../core/http/ssrfGuard.js') as { isForbiddenAddress: (ip: unknown) => boolean };

type LookupAll = (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>;

let hostLookup: LookupAll | null = null;

/** Hosts the operator allows (FIREBIRD_ALLOWED_HOSTS), lower-cased; empty means any. */
export function allowedHosts(): string[] {
    return (process.env.FIREBIRD_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Private addresses are reachable on a self-hosted server, or when the operator allows them. */
function allowPrivateHosts(): boolean {
    return process.env.FIREBIRD_ALLOW_PRIVATE_HOSTS === '1' || (process.env.DEPLOYMENT_MODE || 'cloud') !== 'cloud';
}

/** Resolve the host, check every address it stands for, and return the one to dial. */
export async function assertReachableHost(host: string): Promise<string> {
    let addresses: string[];
    try {
        addresses = await resolveHostAddresses(host, hostLookup || undefined);
    } catch {
        addresses = [];
    }
    if (addresses.length === 0) throw new Error('The Firebird server name could not be resolved.');
    if (addresses.some((a) => isLinkLocalOrMetadataAddress(a))) throw new Error('This Firebird server address is not allowed.');
    const listed = allowedHosts().includes(host.toLowerCase());
    if (!listed && !allowPrivateHosts() && addresses.some((a) => isForbiddenAddress(a))) {
        throw new Error('This Firebird server is on a private network address, which this server does not connect to. '
            + 'The operator can allow it with FIREBIRD_ALLOW_PRIVATE_HOSTS=1 or by listing the host in FIREBIRD_ALLOWED_HOSTS.');
    }
    return addresses[0];
}

/** Test seam: the resolver the host check uses (null = dns.lookup). */
export function _setHostLookupForTests(fn: LookupAll | null): void {
    hostLookup = fn;
}
