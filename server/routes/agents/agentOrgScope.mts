/**
 * Which organisation the agent lists of the admin dashboard cover, and the
 * organisation each row belongs to (GET /agents/all in ./published.js and
 * GET /agents/categories in ./crud.js).
 *
 * `?orgId` is the dashboard's choice of organisation. It is decided by
 * auth/adminOrg.mts resolveAdminOrgId, and only when the request names one:
 *
 *   - a platform admin: the named organisation (404 when it does not exist);
 *     without one, all organisations, as before;
 *   - anyone else: nothing named means exactly the list they had before. A
 *     named organisation must be their home organisation, administered by
 *     the strict organisation-admin check; anything else is the helper's 403.
 *     Their list itself stays the one their organisations give them.
 *
 * Every row also carries `organizationId` and `organizationName` (null for a
 * row without an organisation), so a platform admin who sees every
 * organisation can tell them apart. The names are looked up for the distinct
 * organisations of the rows only, never one per row: one read per organisation
 * while there are few (a member's list spans one or two), one read of all
 * organisations above that (a platform admin's list of every organisation).
 * The lookup is best effort: when it fails the names are null and the list is
 * still served.
 */

/** The request fields read here (structural, so no express types are needed). */
export type AgentOrgRequest = {
    query?: Record<string, unknown>;
};

/** What every listed row gains. */
export type OrgNamed = {
    organizationId: string | null;
    organizationName: string | null;
};

/** True when the request names an organisation (`?orgId` present and not empty). */
function namesOrg(req: AgentOrgRequest): boolean {
    const raw = req.query ? req.query.orgId : undefined;
    return raw !== undefined && raw !== null && raw !== '';
}

/**
 * The organisation `?orgId` names for this caller, decided by
 * `resolveAdminOrgId`; null when the request names none (and then nothing is
 * resolved, so a caller without admin rights sees no new refusal). Throws
 * what `resolveAdminOrgId` throws (HttpError 400, 401, 403, 404).
 */
export async function namedAdminOrg<R extends AgentOrgRequest>(
    req: R,
    resolveAdminOrgId: (req: R) => Promise<string | null>,
): Promise<string | null> {
    if (!namesOrg(req)) return null;
    return resolveAdminOrgId(req);
}

/**
 * The organisation whose categories GET /agents/categories lists.
 * `orgIds` is resolveUserOrgIds (null for a platform admin): a platform
 * admin gets the named organisation, or null (every category) without one;
 * anyone else the first of their organisations, as before, after a named
 * organisation has passed `resolveAdminOrgId`.
 */
export async function categoryListOrgId<R extends AgentOrgRequest>(
    req: R,
    orgIds: Set<string> | null,
    resolveAdminOrgId: (req: R) => Promise<string | null>,
): Promise<string | null> {
    const named = await namedAdminOrg(req, resolveAdminOrgId);
    if (orgIds === null) return named;
    return orgIds.size > 0 ? Array.from(orgIds)[0] : null;
}

/** The organisation id of a store row (`organization_id`), or null. */
function orgIdOf(row: { organization_id?: unknown }): string | null {
    const id = row.organization_id;
    return typeof id === 'string' && id !== '' ? id : null;
}

/** Up to this many distinct organisations, each is read by id; above it, all organisations are read once. */
export const MAX_ORG_POINT_LOOKUPS = 10;

/** The two reads the names can come from (stores/userStore). */
export type OrgNameLookups = {
    getOrganization: (id: string) => Promise<unknown>;
    listOrganizations: () => Promise<unknown[] | null | undefined>;
};

/** The organisations for `ids`: read one by one while few, else all at once. */
async function organizationsFor(ids: string[], lookups: OrgNameLookups): Promise<unknown[]> {
    if (ids.length === 0) return [];
    if (ids.length > MAX_ORG_POINT_LOOKUPS) return (await lookups.listOrganizations()) || [];
    return Promise.all(ids.map((id) => lookups.getOrganization(id)));
}

/**
 * `rows` with `organizationId` and `organizationName` on each, looked up for
 * the rows' distinct organisations only (none when no row has one).
 * `onError` hears a failed lookup; the names are null then.
 */
export async function withOrganizationNames<T extends { organization_id?: unknown }>(
    rows: T[],
    lookups: OrgNameLookups,
    onError: (err: unknown) => void = () => {},
): Promise<Array<T & OrgNamed>> {
    const names = new Map<string, string>();
    const ids = [...new Set(rows.map(orgIdOf).filter((id): id is string => id !== null))];
    try {
        for (const org of await organizationsFor(ids, lookups)) {
            if (!org || typeof org !== 'object') continue;
            const { id, name } = org as { id?: unknown; name?: unknown };
            if (typeof id === 'string' && typeof name === 'string' && name !== '') names.set(id, name);
        }
    } catch (err) {
        onError(err);
    }
    return rows.map((row) => {
        const organizationId = orgIdOf(row);
        return { ...row, organizationId, organizationName: organizationId ? names.get(organizationId) ?? null : null };
    });
}
