/**
 * Where a Frappe CRM connection may go (integrations/frappeCrmClient.mts).
 *
 * The same decision as the Firebird integration (firebirdHost.mts), for an
 * HTTP API instead of a database socket:
 *
 *   - A self-hosted Bee Flow runs inside the customer's network, so a Frappe
 *     site on a private or LAN address is allowed there. In cloud mode
 *     (DEPLOYMENT_MODE=cloud, the default) a private address is refused unless
 *     the operator sets FRAPPE_CRM_ALLOW_PRIVATE_HOSTS=1 or lists the host in
 *     FRAPPE_CRM_ALLOWED_HOSTS.
 *   - FRAPPE_CRM_ALLOWED_HOSTS (comma list, empty = any) also restricts the
 *     host: when it is set, only the listed hosts are reachable.
 *   - Link-local and cloud-metadata addresses are refused in every mode.
 *   - The API key and secret travel in a header, so a site is reached over
 *     https. Plain http:// only for a private address where private addresses
 *     are allowed (a name is checked against what it resolves to, before each
 *     request).
 *
 * Outside private mode the request goes through the guarded fetch of
 * integrations/shared/apiClient.js, which checks every address at connect
 * time. In private mode (the plain fetch) this module resolves the host before
 * each request and refuses it when any address is link-local or metadata, and
 * the caller turns redirects off, so a redirect cannot lead the credentials
 * somewhere the check did not look.
 *
 * Every check here is plain URL parsing and string comparison.
 */

import { isLinkLocalOrMetadataAddress, resolveHostAddresses } from '../core/http/linkLocalGuard.mts';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';

const nodeRequire = createRequire(import.meta.url);
const { isPrivateTarget } = nodeRequire('../utils/isPrivateTarget.js') as { isPrivateTarget: (url: string) => boolean };
const { isPrivateHostname } = nodeRequire('../utils/ssrfGuard.js') as { isPrivateHostname: (host: string) => boolean };

type LookupAll = (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>;

let hostLookup: LookupAll | null = null;

/** Longest site URL accepted. */
export const MAX_URL_LENGTH = 2048;

/** Hosts the operator allows (FRAPPE_CRM_ALLOWED_HOSTS), lower-cased; empty means any. */
export function allowedHosts(): string[] {
    return (process.env.FRAPPE_CRM_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Private addresses are reachable on a self-hosted server, or when the operator allows them. */
export function allowPrivateHosts(): boolean {
    return process.env.FRAPPE_CRM_ALLOW_PRIVATE_HOSTS === '1' || (process.env.DEPLOYMENT_MODE || 'cloud') !== 'cloud';
}

/** The host part of a parsed URL, lower-cased, without IPv6 brackets. */
function bareHost(url: URL): string {
    const host = url.hostname.toLowerCase();
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export interface SiteTarget {
    /** The site URL without a trailing slash, query or fragment. */
    baseUrl: string;
    /** True when the request may go to a private address (plain fetch, redirects off). */
    allowPrivate: boolean;
}

/**
 * Validate a site URL as typed or stored and decide how it may be reached.
 * Throws an Error whose message is safe to show (it never repeats the URL).
 */
export function checkSiteUrl(raw: unknown): SiteTarget {
    const text = String(raw ?? '').trim();
    if (!text || text.length > MAX_URL_LENGTH) throw new Error('Enter the address of your Frappe CRM site, like https://yourcompany.frappe.cloud.');
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new Error('Enter the address of your Frappe CRM site, like https://yourcompany.frappe.cloud.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The Frappe CRM address must start with https:// or http://.');
    if (url.username || url.password) throw new Error('The Frappe CRM address must not contain a user name or password.');
    if (url.search || url.hash) throw new Error('The Frappe CRM address is the site address only, without ? or #.');
    const host = bareHost(url);
    if (isLinkLocalOrMetadataAddress(host)) throw new Error('This Frappe CRM address is not allowed.');
    const allowed = allowedHosts();
    const listed = allowed.includes(host);
    if (allowed.length && !listed) throw new Error('This Frappe CRM site is not in the list of allowed hosts.');
    const allowPrivate = listed || allowPrivateHosts();
    if (!allowPrivate && isPrivateTarget(url.toString())) throw privateRefusal();
    // http:// only where a private address is allowed, and then never to an address that is public. A name is
    // checked once it is resolved (assertNotLinkLocal).
    if (url.protocol === 'http:' && (!allowPrivate || (isIP(host) !== 0 && !isPrivateHostname(host)))) throw plainHttpRefusal();
    let path = url.pathname;
    while (path.endsWith('/')) path = path.slice(0, -1);
    return { baseUrl: `${url.origin}${path}`, allowPrivate };
}

function plainHttpRefusal(): Error {
    return new Error('The Frappe CRM address must start with https://. Plain http:// is only used for a site on a private network address, where this server allows those.');
}

function privateRefusal(): Error {
    return new Error('This Frappe CRM site is on a private network address, which this server does not connect to. '
        + 'The operator can allow it with FRAPPE_CRM_ALLOW_PRIVATE_HOSTS=1 or by listing the host in FRAPPE_CRM_ALLOWED_HOSTS.');
}

/**
 * Private mode only: resolve the host and refuse it when any address is
 * link-local or metadata, and a plain http:// site when any address is public.
 * Outside private mode the guarded fetch does this (and refuses every private
 * address) at connect time.
 */
export async function assertNotLinkLocal(target: SiteTarget): Promise<void> {
    if (!target.allowPrivate) return;
    const host = bareHost(new URL(target.baseUrl));
    let addresses: string[];
    try {
        addresses = await resolveHostAddresses(host, hostLookup || undefined);
    } catch {
        addresses = [];
    }
    if (addresses.length === 0) throw new Error('The Frappe CRM site name could not be resolved.');
    if (addresses.some((a) => isLinkLocalOrMetadataAddress(a))) throw new Error('This Frappe CRM address is not allowed.');
    if (target.baseUrl.startsWith('http:') && addresses.some((a) => !isPrivateHostname(a))) throw plainHttpRefusal();
}

/** Test seam: the resolver the private-mode check uses (null = dns.lookup). */
export function _setHostLookupForTests(fn: LookupAll | null): void {
    hostLookup = fn;
}
