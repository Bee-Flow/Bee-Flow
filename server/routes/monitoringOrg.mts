/**
 * The organisation an org-scoped monitoring view reads, and the sentence a
 * response carries about what it covers.
 *
 * Used by the guardrail / egress dashboards (routes/usageMonitoringAuth.js)
 * and the `/org` variants of Feedback and Terminations (routes/feedback.js,
 * routes/terminations.js). The decision itself is auth/adminOrg.mts
 * (resolveAdminOrgId):
 *
 *   - an organisation admin reads their HOME organisation, and only when the
 *     strict organisation-admin check holds there; anything else is the
 *     helper's 403. Admin rights in a second organisation through a group do
 *     not open that organisation here;
 *   - a platform admin reads the organisation named by `?orgId`. Without
 *     one, an org-scoped view falls back to the organisation on the admin's
 *     own user record, and without that it is a 403 `no_organisation`: these
 *     views read one organisation, never all of them.
 *
 * Each route builds this with its own collaborators, so its tests keep their
 * own doubles.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type HttpErrorCtor = new (status: number, code: string, message?: string) => Error & { status: number; code: string };
const { HttpError } = nodeRequire('../shared/httpErrors.js') as { HttpError: HttpErrorCtor };

/** The request fields read here (structural, so no express types are needed). */
export type MonitoringOrgRequest = {
    session?: { user?: { id?: string; [key: string]: unknown }; [key: string]: unknown } | null;
    query?: Record<string, unknown>;
};

export type MonitoringOrgDeps<R extends MonitoringOrgRequest> = {
    /** auth/permissions resolveAdminOrgId: an organisation id, or null (all organisations, platform admins only). Throws HttpError. */
    resolveAdminOrgId: (req: R) => Promise<string | null>;
    /** stores/userStore getUser. */
    getUser: (userId: string) => Promise<{ organizationId?: unknown } | null | undefined>;
};

/** What a monitoring response covers: one organisation, or (platform admins only) all of them. */
export type CoveredScope = {
    organizationId: string | null;
    organizationName: string | null;
    allOrganizations: boolean;
};

export function createMonitoringOrg<R extends MonitoringOrgRequest>(deps: MonitoringOrgDeps<R>) {
    /**
     * The one organisation an org-scoped monitoring view reads for this
     * caller. Throws HttpError 400, 401, 403 or 404.
     */
    async function monitoringOrgId(req: R): Promise<string> {
        const chosen = await deps.resolveAdminOrgId(req);
        if (chosen) return chosen;
        // Only a platform admin with nothing chosen gets here.
        const userId = req.session?.user?.id;
        const own = typeof userId === 'string' && userId !== '' ? await deps.getUser(userId) : null;
        const home = own && typeof own.organizationId === 'string' && own.organizationId !== '' ? own.organizationId : null;
        if (home) return home;
        throw new HttpError(403, 'no_organisation', 'No organisation context');
    }
    return { monitoringOrgId };
}

/**
 * The `scope` block of a monitoring response. `orgId` null means all
 * organisations when `allOrganizations` is set (a platform admin without a
 * choice), and the caller's own rows otherwise (an account without an
 * organisation). The name is best effort: a lookup that fails leaves it null
 * rather than failing the figures.
 */
export async function coveredScope(
    orgId: string | null | undefined,
    allOrganizations: boolean,
    getOrganization: (orgId: string) => Promise<unknown>,
): Promise<CoveredScope> {
    if (!orgId) return { organizationId: null, organizationName: null, allOrganizations };
    const org = await Promise.resolve().then(() => getOrganization(orgId)).catch(() => null);
    const name = org && typeof org === 'object' ? (org as { name?: unknown }).name : null;
    return { organizationId: orgId, organizationName: typeof name === 'string' && name !== '' ? name : null, allOrganizations: false };
}
