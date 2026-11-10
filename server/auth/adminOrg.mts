/**
 * The organisation the admin dashboard acts on for the caller.
 *
 *   - platform admin (isSuperAdmin: the session flag or users.role 'admin'):
 *     the organisation named by `?orgId`, else null, which means "all
 *     organisations". A route that cannot serve all organisations decides for
 *     itself what null means there. A named organisation that does not exist
 *     is a 404. Only the request names the organisation: no session key does
 *     (`session.adminSelectedOrgId` is the Access panel's entitlement
 *     context, not a choice of what the dashboard shows).
 *   - anyone else: their HOME organisation (users.organizationId, read from the
 *     user row, not the session), and only when the strict organisation-admin
 *     check holds for it (permissionsOrgGates._evalOrgAdmin: an admin orgRole
 *     in that organisation, or a group IN it that carries admin rights). No
 *     admin right there, no home organisation, or a `?orgId` naming any other
 *     organisation is a 403. The union of organisations from orgScope is never
 *     consulted: admin rights in a second organisation reached through a group
 *     do not make that organisation administrable here.
 *
 * `requireAdminOrg` resolves this once per request and stores the answer on
 * `req.adminOrgId` (string, or null for "all organisations"). It answers 401
 * without an authenticated session. Errors go to `next(err)` as HttpError, so
 * the terminal error handler writes the response.
 *
 * Built by the auth/permissions.js barrel with the real collaborators; a test
 * builds it with fakes. Requires nothing from the server's import cycle.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

// Structural request/response types instead of 'express', as in
// auth/connector/rotateKey.mts: no server node_modules are needed to check it.
export type AdminOrgRequest = {
    session?: {
        isAuthenticated?: boolean;
        isAdmin?: boolean;
        user?: { id?: string; role?: string; [key: string]: unknown };
        [key: string]: unknown;
    };
    query?: Record<string, unknown>;
    adminOrgId?: string | null;
};

/** The user row fields the decision reads (stores/userStore getUser). */
export type AdminOrgUser = {
    id?: string;
    organizationId?: string | null;
    orgRole?: string | null;
    groups?: unknown;
    [key: string]: unknown;
};

export type AdminOrgDeps = {
    /** auth/permissionsOrgGates.js isSuperAdmin. */
    isSuperAdmin: (req: AdminOrgRequest) => boolean;
    /** auth/permissionsOrgGates.js _evalOrgAdmin (the strict org-admin check). */
    evalOrgAdmin: (user: AdminOrgUser, allGroups: unknown[], orgId: string) => boolean;
    getUser: (userId: string) => Promise<AdminOrgUser | null | undefined>;
    getAllGroups: () => Promise<unknown[] | null | undefined>;
    getOrganization: (orgId: string) => Promise<unknown>;
};

type HttpErrorCtor = new (status: number, code: string, message?: string) => Error & { status: number; code: string };
type GateMeta = { tagGate: <T extends (...args: never[]) => unknown>(fn: T, meta: Record<string, unknown>) => T };

const { HttpError } = nodeRequire('../shared/httpErrors.js') as { HttpError: HttpErrorCtor };
const { tagGate } = nodeRequire('./gateMeta.js') as GateMeta;

/** The gate tag the route walk reads (auth/routeContract.js classifies axis 'scope' as `scope`). */
export const ADMIN_ORG_GATE = Object.freeze({ axis: 'scope', kind: 'adminOrg' });

/**
 * `?orgId` as one non-empty string, or null when absent or empty. A repeated
 * parameter (an array) or any other shape is a 400, never a guess.
 */
function queryOrgId(req: AdminOrgRequest): string | null {
    const raw = req.query ? req.query.orgId : undefined;
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') throw new HttpError(400, 'invalid_org_id', 'orgId must be a single value');
    return raw;
}

function hasSession(req: AdminOrgRequest): boolean {
    const s = req.session;
    return !!(s && s.isAuthenticated && s.user && typeof s.user.id === 'string' && s.user.id !== '');
}

export function createAdminOrgGate(deps: AdminOrgDeps) {
    const { isSuperAdmin, evalOrgAdmin, getUser, getAllGroups, getOrganization } = deps;

    async function existingOrg(orgId: string): Promise<string> {
        const org = await getOrganization(orgId);
        if (!org) throw new HttpError(404, 'organization_not_found', 'Organization not found');
        return orgId;
    }

    async function forPlatformAdmin(req: AdminOrgRequest): Promise<string | null> {
        const named = queryOrgId(req);
        return named ? existingOrg(named) : null;
    }

    async function forOrgAdmin(req: AdminOrgRequest, userId: string): Promise<string> {
        const named = queryOrgId(req);
        const user = await getUser(userId);
        const homeOrgId = user && typeof user.organizationId === 'string' && user.organizationId !== '' ? user.organizationId : null;
        if (!user || !homeOrgId) throw new HttpError(403, 'org_admin_required', 'Organization admin access required');
        if (named && named !== homeOrgId) throw new HttpError(403, 'org_admin_required', 'Organization admin access required');
        const groups = (await getAllGroups()) || [];
        if (!evalOrgAdmin(user, groups, homeOrgId)) throw new HttpError(403, 'org_admin_required', 'Organization admin access required');
        return homeOrgId;
    }

    /**
     * The organisation the admin dashboard acts on for this caller: an id, or
     * null ("all organisations", platform admins only). Throws HttpError 401,
     * 400, 403 or 404.
     */
    async function resolveAdminOrgId(req: AdminOrgRequest): Promise<string | null> {
        if (!hasSession(req)) throw new HttpError(401, 'unauthorized', 'Not authenticated');
        if (isSuperAdmin(req)) return forPlatformAdmin(req);
        return forOrgAdmin(req, String(req.session?.user?.id));
    }

    /** Middleware: resolves once and stores the answer on `req.adminOrgId`. */
    const requireAdminOrg = tagGate(async (req: AdminOrgRequest, _res: unknown, next: (err?: unknown) => void): Promise<void> => {
        let orgId: string | null;
        try {
            orgId = await resolveAdminOrgId(req);
        } catch (err) {
            next(err);
            return;
        }
        req.adminOrgId = orgId;
        next();
    }, ADMIN_ORG_GATE);

    return { resolveAdminOrgId, requireAdminOrg };
}
