/**
 * A change of an organisation's contact e-mail (PUT /auth/organizations/:id, ./orgRoutes.js).
 *
 * The contact address names a domain, and a confirmed domain places new single-sign-on
 * accounts in the organisation (../orgDomainMatch.mts). So when the address moves to another
 * domain:
 *   - a domain another organisation already uses is refused (accountProvisioning
 *     assertDomainAvailable, the signup check), with a message that names nobody;
 *   - a platform admin's change confirms the new domain (`contactDomainVerified`); an
 *     organisation admin's change does not, and the domain counts only once an administrator
 *     of the organisation has a verified sign-in address on it. A free-mail domain is never
 *     confirmed (nobody owns it) and never places anyone.
 */

import { createRequire } from 'node:module';
import { domainOf } from '../orgDomainMatch.mts';

const nodeRequire = createRequire(import.meta.url);

export interface ContactRequest { session?: { isAdmin?: boolean; user?: { role?: string } | null } | null }

export type ContactDomainResult =
    | { refusal: { error: string; code: string } }
    | { contactDomainVerified?: string };

export interface ContactDomainDeps {
    assertDomainAvailable: (email: string, exceptOrgId: string) => Promise<void>;
    isFreeDomain: (domain: string) => Promise<boolean>;
}

function realDeps(): ContactDomainDeps {
    const free = nodeRequire('../../utils/freeEmailDomains');
    return {
        assertDomainAvailable: (email, exceptOrgId) => nodeRequire('../accountProvisioning').assertDomainAvailable(email, exceptOrgId),
        isFreeDomain: async (domain) => free.isFreeEmailDomain(domain, await free.getEffectiveFreeEmailDomains()),
    };
}

export const DOMAIN_UNAVAILABLE = 'This e-mail address cannot be the organisation\'s contact address. Use another address.';

/**
 * What a new contact address does: a refusal, or the columns to write with it.
 * @param req the request (a platform admin confirms the domain)
 * @param orgId the organisation being edited
 * @param existing its row before the change
 * @param email the new address from the body (undefined: not changed)
 */
export async function contactDomainUpdate(req: ContactRequest, orgId: string, existing: { email?: unknown } | null | undefined, email: unknown, deps: ContactDomainDeps = realDeps()): Promise<ContactDomainResult> {
    if (typeof email !== 'string') return {};
    const domain = domainOf(email);
    if (!domain || domain === domainOf(existing?.email)) return {};
    try {
        await deps.assertDomainAvailable(email.trim(), orgId);
    } catch (e) {
        if ((e as { code?: string })?.code === 'ORG_DOMAIN_TAKEN') return { refusal: { error: DOMAIN_UNAVAILABLE, code: 'org_domain_unavailable' } };
        throw e;
    }
    const platformAdmin = !!(req.session?.isAdmin || req.session?.user?.role === 'admin');
    if (platformAdmin && !(await deps.isFreeDomain(domain))) return { contactDomainVerified: domain };
    return {};
}
