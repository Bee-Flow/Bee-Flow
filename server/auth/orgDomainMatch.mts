/**
 * Which organisation a NEW single-sign-on account is placed in by its e-mail
 * domain. Only on creation: a later sign-in of an account without an
 * organisation is never placed by domain (auth/oauth/ssoSessionSetup.js).
 *
 *   - an organisation's `allowedDomains` (self-hosted, set by its operator) match as listed;
 *   - an organisation's contact e-mail matches only when its domain is confirmed for that
 *     organisation: an administrator of it has a verified sign-in address on the domain
 *     (stores/user/verifiedAdminDomains.mts), or a platform admin set the contact address
 *     (`contact_domain_verified`, auth/admin/orgContactDomain.mts). The contact branch also
 *     needs an address the sign-in provider verified;
 *   - a domain more than one organisation matches places nobody (auth/ssoUserResolver.js
 *     resolveOrgByEmailDomain), and a free-mail domain never matches.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface OrgRow { id: string; email?: string | null; allowedDomains?: unknown; contact_domain_verified?: string | null; [key: string]: unknown }

export interface DomainMatchDeps {
    getAllOrganizations: () => Promise<OrgRow[]>;
    freeDomains: () => Promise<Set<string>>;
    orgIdsWithVerifiedAdminAtDomain: (domain: string) => Promise<string[]>;
}

function realDeps(): DomainMatchDeps {
    const userStore = nodeRequire('../stores/userStore');
    const free = nodeRequire('../utils/freeEmailDomains');
    return {
        getAllOrganizations: () => userStore.getAllOrganizations(),
        freeDomains: () => free.getEffectiveFreeEmailDomains(),
        orgIdsWithVerifiedAdminAtDomain: (domain) => userStore.orgIdsWithVerifiedAdminAtDomain(domain),
    };
}

/** The lower-cased domain of an address, or '' for something that is not one. */
export function domainOf(email: unknown): string {
    const s = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const at = s.lastIndexOf('@');
    return at > 0 && at < s.length - 1 ? s.slice(at + 1) : '';
}

/** The organisations whose contact e-mail domain is confirmed as `domain`. */
export async function confirmedContactOrgIds(domain: string, orgs: OrgRow[], deps: DomainMatchDeps): Promise<Set<string>> {
    const ids = new Set<string>();
    if (!domain) return ids;
    for (const org of orgs) {
        if (domainOf(org.email) === domain && String(org.contact_domain_verified || '').toLowerCase() === domain) ids.add(org.id);
    }
    for (const id of await deps.orgIdsWithVerifiedAdminAtDomain(domain)) ids.add(id);
    return ids;
}

/**
 * The organisation a new account with this address joins, or null.
 * `emailVerified`: the sign-in provider vouches for the address.
 */
export async function orgForNewAccount(email: string, emailVerified: boolean, deps: DomainMatchDeps = realDeps()): Promise<OrgRow | null> {
    const domain = domainOf(email);
    if (!domain) return null;
    const { resolveOrgByEmailDomain } = nodeRequire('./ssoUserResolver') as {
        resolveOrgByEmailDomain: (e: string, o: OrgRow[], f?: Set<string>, c?: ReadonlySet<string>) => OrgRow | null;
    };
    const orgs = await deps.getAllOrganizations();
    const confirmed = emailVerified ? await confirmedContactOrgIds(domain, orgs, deps) : new Set<string>();
    return resolveOrgByEmailDomain(email, orgs, await deps.freeDomains(), confirmed);
}
