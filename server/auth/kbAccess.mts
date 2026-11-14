/**
 * Knowledge-base access: "may this person do X to this base", decided in one place.
 *
 * Two questions, each one function, built from the rules the knowledge-base
 * routes share (the pure policy sits in stores/kb/access.js and is not
 * repeated here):
 *   read    the base and its content (GET /kb/:id, its documents, sources,
 *           threads, usage, a question to it, a copy of it, a favourite):
 *           the owner (`tenant_id`), a system base, the super admin, an
 *           organisation admin of the base's own organisation, or a member of
 *           that organisation once the base is published (in one of its
 *           shared groups when it names any): stores/kb/access canUserAccessKB.
 *   manage  the base's settings and content (PATCH, DELETE, publish, ingest,
 *           reindex, sources, the query log): the owner, the super admin, or
 *           manage_knowledge held IN the base's organisation by one of its
 *           members; a project's files base is managed from its project only:
 *           stores/kb/access canUserManageKB.
 * `read` and `manage` are a ladder (`gradeOf`): whoever may manage may read
 * (PATCH already answers them the row). `canReadKb` alone is the content
 * question the other routers ask (attaching a base to a notebook, a favourite
 * list), where a management right is not a reason to read.
 *
 * One gate puts the answer in a route's chain, tagged so the route contract
 * (auth/routeContract.js) records the route as `scoped`:
 *   requireKbGrade(minGrade)  404 when the caller holds no grade at all (the
 *                             existence of another organisation's base is not
 *                             probeable; an unknown id answers the same), 403
 *                             `kb_not_manageable` when the grade is too low
 *                             (the caller may read it, so it may know it
 *                             exists). `belowGrade: 404` hides the refusal
 *                             too, for the query log (routes/knowledgeBases/
 *                             queryLog.js: a reader is not told a log exists).
 *                             Sets `req.kbAccess`.
 * System and project-files bases are read-only on the generic routes whoever
 * the caller is; that is routes/knowledgeBases/shared.js blockIfSystemKB,
 * asked by the handler after the gate.
 *
 * Pure: every dependency comes in through `deps`; support/kbAccess.js wires
 * the real stores and auth (`defaultKbAccess`) for every router. The
 * per-request lookups (organisations, groups, administered organisations,
 * permissions) are memoised on the request, so a loop over many bases pays
 * for them once.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type GateMeta = { tagGate: <T extends (...args: never[]) => unknown>(fn: T, meta: Record<string, unknown>) => T };
const { tagGate } = nodeRequire('./gateMeta.js') as GateMeta;

/**
 * The knowledge-base row (stores/knowledgeBases getKB): the columns the rules read, typed; the rest as
 * the handlers behind the gate have always read them off the store's row (name, usage_contexts, the
 * query-log settings, ...), so the gate adds no casts to them.
 */
export type KbRow = {
    id: string; tenant_id: string; organization_id?: string | null;
    is_published?: boolean | number | null; shared_groups?: unknown; source_kind?: string | null;
    [key: string]: any;
};

export type KbGrade = 'read' | 'manage';

/** Structural request type, as in auth/agentAccess.mts: no express types needed. */
export type KbSession = { isAdmin?: boolean; user?: { id?: string; role?: string; [key: string]: unknown } | null; [key: string]: unknown };
// No index signature: express's Request has none, and the gate sits in its chains.
export type KbRequest = {
    session?: KbSession | null;
    params?: Record<string, string | string[] | undefined>;
    kbAccess?: KbAccess;
};
/** The shape express sees: typed loosely on purpose, so a route's handler keeps express's own Request type. */
export type GateMiddleware = (req: any, res: any, next: any) => Promise<unknown>;
type GateResponse = { status: (code: number) => { json: (body: unknown) => unknown } };
type Next = (err?: unknown) => void;

/** What the gate leaves on the request for the handler. */
export type KbAccess = { kb: KbRow; grade: KbGrade; userId: string };

export type OrgPermissions = { holds: (permission: string, orgId: string | null | undefined) => boolean };

export type KbRulesDeps = {
    /** The session user's id, or null for nobody. */
    getUserId: (req: KbRequest) => string | null | undefined;
    /** auth/permissions resolveUserOrgIds: the caller's organisations; null for the super admin. */
    resolveUserOrgIds: (req: KbRequest) => Promise<Set<string> | null>;
    /** auth/audience resolveUserGroups: the caller's group ids, fresh from the database. */
    resolveUserGroups: (userId: string) => Promise<string[]>;
    /** auth/permissions resolveAdminOrgIds: the organisations the caller administers. */
    resolveAdminOrgIds: (req: KbRequest) => Promise<Set<string> | null | undefined>;
    resolvePermissionsByOrg: (userId: string, session?: unknown) => Promise<OrgPermissions>;
    /** stores/kb/access canUserAccessKB. */
    canUserAccessKB: (kb: KbRow, userId: string, orgIds: Set<string> | null, userGroups: string[], opts: { adminOrgIds: Set<string> }) => boolean;
    /** stores/kb/access canUserManageKB; `holds` is manage_knowledge in the base's organisation. */
    canUserManageKB: (kb: KbRow, userId: string, orgIds: Set<string> | null, holds: boolean) => boolean;
    /** utils/bestEffort fallback: a failed read is logged and grants nothing. Absent, the read fails silently. */
    fallback?: <T>(where: string, err: unknown, value: T) => T;
};

export type KbGateDeps = {
    getKB: (id: string) => Promise<KbRow | null | undefined>;
    getUserId: KbRulesDeps['getUserId'];
};

export type KbAccessDeps = KbRulesDeps & KbGateDeps;

const RANK: Readonly<Record<KbGrade, number>> = Object.freeze({ read: 1, manage: 2 });

const HOLDS_NOWHERE: OrgPermissions = Object.freeze({ holds: () => false });

const NOT_FOUND = Object.freeze({ error: 'KB not found', code: 'kb_not_found' });
/** The 403 of a reader on a management route: they may know the base exists. */
const NOT_MANAGEABLE = Object.freeze({ error: 'Access denied', code: 'kb_not_manageable' });

/** True for the grades at or above `min`. */
export function kbGradeAtLeast(grade: KbGrade | null | undefined, min: KbGrade): boolean {
    return !!grade && RANK[grade] >= RANK[min];
}

/** The path parameter as a string; an array (a repeated segment) names no base. */
function paramOf(req: KbRequest, param: string): string {
    const raw = req.params?.[param];
    return typeof raw === 'string' ? raw : '';
}

/** The caller's organisations, groups and administered organisations, read once per request. */
type ReadContext = { orgIds: Set<string> | null; userGroups: string[]; adminOrgIds: Set<string> };

export function makeKbRules(deps: KbRulesDeps) {
    const swallow = deps.fallback ?? ((_where: string, _err: unknown, value) => value);
    const readContexts = new WeakMap<object, Promise<ReadContext>>();
    const permissionMemo = new WeakMap<object, Map<string, Promise<OrgPermissions>>>();

    /**
     * The read inputs, once per request. A failed read of the organisations or
     * groups grants nothing (an empty set, never the super admin's null); a
     * failed read of the administered organisations is none of them.
     */
    function readContextOf(req: KbRequest, userId: string): Promise<ReadContext> {
        const build = async (): Promise<ReadContext> => {
            const [orgIds, userGroups, adminOrgIds] = await Promise.all([
                Promise.resolve().then(() => deps.resolveUserOrgIds(req))
                    .catch((e: unknown) => swallow('auth/kbAccess:readContext#orgIds', e, new Set<string>())),
                Promise.resolve().then(() => deps.resolveUserGroups(userId))
                    .catch((e: unknown) => swallow('auth/kbAccess:readContext#groups', e, [] as string[])),
                Promise.resolve().then(() => deps.resolveAdminOrgIds(req))
                    .then((set) => (set instanceof Set ? set : new Set<string>()))
                    .catch((e: unknown) => swallow('auth/kbAccess:readContext#adminOrgs', e, new Set<string>())),
            ]);
            return { orgIds: orgIds === null ? null : (orgIds instanceof Set ? orgIds : new Set<string>()), userGroups, adminOrgIds };
        };
        if (!req || typeof req !== 'object') return build();
        let p = readContexts.get(req);
        if (!p) { p = build(); readContexts.set(req, p); }
        return p;
    }

    /** resolvePermissionsByOrg, once per request and user; a failed read holds nowhere. */
    function permissionsOf(req: KbRequest, userId: string): Promise<OrgPermissions> {
        const read = () => Promise.resolve().then(() => deps.resolvePermissionsByOrg(userId, req?.session))
            .then((p) => p || HOLDS_NOWHERE)
            .catch((e: unknown) => swallow('auth/kbAccess:permissions', e, HOLDS_NOWHERE));
        if (!req || typeof req !== 'object') return read();
        let perUser = permissionMemo.get(req);
        if (!perUser) { perUser = new Map(); permissionMemo.set(req, perUser); }
        let p = perUser.get(userId);
        if (!p) { p = read(); perUser.set(userId, p); }
        return p;
    }

    /** read: the owner before any lookup, then the store's read policy over the caller's context. */
    async function canReadKb(req: KbRequest, kb: KbRow | null | undefined): Promise<boolean> {
        if (!kb) return false;
        const userId = deps.getUserId(req) || '';
        if (userId && kb.tenant_id === userId) return true;
        const { orgIds, userGroups, adminOrgIds } = await readContextOf(req, userId);
        return deps.canUserAccessKB(kb, userId, orgIds, userGroups, { adminOrgIds });
    }

    /** manage: the owner before any lookup, then the store's manage policy with manage_knowledge held IN the base's organisation. */
    async function canManageKb(req: KbRequest, kb: KbRow | null | undefined): Promise<boolean> {
        if (!kb) return false;
        const userId = deps.getUserId(req) || '';
        if (userId && kb.tenant_id === userId) return true;
        const { orgIds } = await readContextOf(req, userId);
        // A right held in another organisation of the caller does not count.
        const holds = !!kb.organization_id && (await permissionsOf(req, userId)).holds('manage_knowledge', kb.organization_id);
        return deps.canUserManageKB(kb, userId, orgIds, holds);
    }

    /**
     * The caller's grade on the base, or null for none. Never looks beyond
     * `upTo`: under `upTo: 'read'` a 'read' answer means "at least read", and
     * the permission lookup is spent only when the read rule alone refused.
     */
    async function gradeOf(req: KbRequest, kb: KbRow, upTo: KbGrade = 'manage'): Promise<KbGrade | null> {
        const read = await canReadKb(req, kb);
        if (read && upTo === 'read') return 'read';
        if (await canManageKb(req, kb)) return 'manage';
        return read ? 'read' : null;
    }

    return { canReadKb, canManageKb, gradeOf };
}

/** What the gate needs to know about a caller: the rules, or a test's stand-in for them. */
export type KbRules = { gradeOf: (req: KbRequest, kb: KbRow, upTo?: KbGrade) => Promise<KbGrade | null> };

export type KbGateOptions = { param?: string; belowGrade?: 403 | 404 };

/** The gate over `rules` (the real ones from makeKbRules, or a test's). */
export function makeKbGates(deps: KbGateDeps, rules: KbRules) {
    /**
     * Load the base behind `req.params[param]`, refuse below `minGrade`, leave
     * `req.kbAccess` for the handler. Reads nothing of the body or query, so a
     * stranger gets the 404 whatever they send.
     */
    function requireKbGrade(minGrade: KbGrade, { param = 'id', belowGrade = 403 }: KbGateOptions = {}): GateMiddleware {
        const gate = async (req: KbRequest, res: GateResponse, next: Next) => {
            const kb = (await deps.getKB(paramOf(req, param))) ?? null;
            if (!kb) return res.status(404).json(NOT_FOUND);
            const grade = await rules.gradeOf(req, kb, minGrade);
            if (!grade) return res.status(404).json(NOT_FOUND);
            if (!kbGradeAtLeast(grade, minGrade)) {
                return belowGrade === 404 ? res.status(404).json(NOT_FOUND) : res.status(403).json(NOT_MANAGEABLE);
            }
            req.kbAccess = { kb, grade, userId: deps.getUserId(req) || '' };
            return next();
        };
        return tagGate(gate as GateMiddleware, { axis: 'scoped', minGrade, param });
    }

    return { requireKbGrade };
}

/** The rules and the gate over them, from one set of deps. */
export function makeKbAccess(deps: KbAccessDeps) {
    const rules = makeKbRules(deps);
    return { ...rules, ...makeKbGates(deps, rules) };
}

export type KbAccessInstance = ReturnType<typeof makeKbAccess>;

/** What the gate left on the request. Throws when a handler runs without its gate. */
export function kbAccessOf(req: KbRequest): KbAccess {
    if (!req.kbAccess) throw new Error('knowledge-base gate missing: the route runs without requireKbGrade');
    return req.kbAccess;
}
