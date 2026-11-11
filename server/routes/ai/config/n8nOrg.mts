/**
 * Which organisation an /ai/n8n/* route works on (routes/ai/config/integrations.js).
 *
 * The org id is a STORAGE KEY: `n8n_url_org_<id>`, the api key secret beside it
 * and the workflow list are the organisation's, so the n8n settings are per
 * organisation, not per user.
 *
 *   - getN8nOrgId (the read routes): the caller's org (auth/orgScope.js, the
 *     account's own org, else the first one a group grants); a super admin
 *     without one falls back to '__system__'.
 *   - requireOrgAdminForN8n (the admin routes): a super admin on their org or
 *     '__system__'; anyone else must hold an admin orgRole and works on their
 *     HOME org, never the one a group grants (an org-admin role belongs to the
 *     account's own org). Stores the org on `req.orgId`.
 *
 * Both take `?orgId`, the organisation a platform admin chose in the admin
 * dashboard (auth/adminOrg.mts resolveChosenOrgId): a platform admin may name
 * any existing organisation (404 when unknown), anyone else only the one above
 * (403). A repeated `?orgId` is a 400.
 *
 * `strict`, because a read that merely failed would look like "no org" and
 * quietly send a tenant's connection into the shared '__system__' scope.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** The request fields read here (structural, as in auth/adminOrg.mts). */
export type N8nOrgRequest = {
    session: { user?: { id?: string; [key: string]: unknown }; [key: string]: unknown };
    query?: Record<string, unknown>;
    orgId?: string | null;
};
type JsonResponse = { status: (code: number) => { json: (body: unknown) => unknown } };
type Scope = { orgId: string | null; homeOrgId: string | null; isSuperAdmin: boolean };
type OrgScopeFn = (req: N8nOrgRequest, opts: { strict: true }) => Promise<Scope>;
type ChooseOrg = (req: N8nOrgRequest, ownOrgId: string | null) => Promise<string | null>;

// Required at call time, by the same strings the rest of this router uses, so
// a test that stands in for a store by its require string reaches here too.
const orgScope = (): OrgScopeFn => (nodeRequire('../../../auth/orgScope') as { orgScope: OrgScopeFn }).orgScope;
const chooseOrg = (): ChooseOrg => (nodeRequire('../../../auth/permissions') as { resolveChosenOrgId: ChooseOrg }).resolveChosenOrgId;
const getUser = (id: string): Promise<{ orgRole?: string | null } | null> =>
    (nodeRequire('../../../stores/userStore') as { getUser: (id: string) => Promise<{ orgRole?: string | null } | null> }).getUser(id);

/** The org a read route works on, or null (no org). Throws HttpError 400, 403 or 404 for `?orgId`. */
export async function getN8nOrgId(req: N8nOrgRequest): Promise<string | null> {
    const { orgId, isSuperAdmin } = await orgScope()(req, { strict: true });
    const own = !orgId && isSuperAdmin ? '__system__' : orgId;
    return chooseOrg()(req, own);
}

/** Express middleware for the admin routes: sets `req.orgId`, or answers 401/403. */
export async function requireOrgAdminForN8n(req: N8nOrgRequest, res: JsonResponse, next: (err?: unknown) => void): Promise<unknown> {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { orgId, homeOrgId, isSuperAdmin } = await orgScope()(req, { strict: true });
    if (isSuperAdmin) {
        req.orgId = await chooseOrg()(req, orgId || '__system__');
        return next();
    }
    if (!homeOrgId) return res.status(403).json({ error: 'No organization' });
    const user = await getUser(userId);
    if (user?.orgRole !== 'admin' && user?.orgRole !== 'org_admin') return res.status(403).json({ error: 'Org admin required' });
    req.orgId = await chooseOrg()(req, homeOrgId);
    return next();
}
