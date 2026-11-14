/**
 * Agent access: "may this person do X to this agent", decided in one place.
 *
 * Four questions, each one function, built from the rules the agent routes
 * share (the owner, the super admin, the organisation, the shared groups):
 *   read    the agent's configuration (GET /agents/:id, its tools, its
 *           conversations): the owner, a system or swarm agent, the super
 *           admin, or the published audience (`canSeePublished`: a member of
 *           the agent's organisation, in one of its shared groups when it
 *           names any). Whoever may edit may read: PUT /agents/:id already
 *           answers them the row, and GET /agents/all lists it to them.
 *   edit    the agent (PUT, DELETE, publish, tool params, tests, versions):
 *           the owner, the super admin, or manage_agents held IN the agent's
 *           organisation by one of its members; an agent editor not on
 *           somebody else's unpublished draft; an agent without an
 *           organisation is its owner's.
 *   manage  the agent's ownership (transfer): edit, and the owner, the super
 *           admin or an organisation admin whose home organisation is the
 *           agent's.
 *   chat    a turn with the agent, which is a different audience than read:
 *           a published agent only, its owner always, otherwise a member of
 *           the agent's organisation (in a shared group when it names any);
 *           someone in no organisation, a visitor with a `guest_…` id
 *           included, reaches a published agent that is in none. The super
 *           admin is a member here, not a bypass: a draft is its owner's
 *           alone (routes/ai/voice.js draws the same line).
 * `read`, `edit` and `manage` are a ladder (`gradeOf`); `chat` stands next to
 * it. Two gates put the answer in a route's chain, tagged so the route
 * contract (auth/routeContract.js) records the route as `scoped`:
 *   requireAgentGrade(minGrade)  404 when the caller holds no grade at all (the
 *                                existence of a colleague's agent is not
 *                                probeable; an unknown id answers the same),
 *                                403 `agent_not_editable` when the grade is
 *                                too low (the caller may read it, so it may
 *                                know it exists). Sets `req.agentAccess`.
 *   requireAgentChat()           the turn routes' answers, unchanged: 404 for
 *                                an unknown agent, 401 for a visitor on a
 *                                draft or on a published agent without a
 *                                public page (so the two cannot be told
 *                                apart), 403 for a signed-in person outside
 *                                the audience.
 * Pure: every dependency comes in through `deps`; core/agentRuntime/agentAccess.js wires
 * the real stores and auth lazily (`defaultAgentAccess`), and
 * routes/agents/crud.js builds the router's instance from its own, mockable
 * imports. The per-request lookups (organisations, groups, permissions) are
 * memoised on the request, so a list endpoint asking about many agents pays
 * for them once.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type GateMeta = { tagGate: <T extends (...args: never[]) => unknown>(fn: T, meta: Record<string, unknown>) => T };
const { tagGate } = nodeRequire('./gateMeta.js') as GateMeta;

/** The agent columns the rules read (stores/agentStore getAgent, `shared_groups` already an array there). */
export type AgentRow = {
    id: string; owner_id?: string | null; organization_id?: string | null; is_published?: boolean | null;
    shared_groups?: unknown; embed_enabled?: boolean | number | null; [key: string]: unknown;
};

/** stores/agentStore getAgentViews: the concept row and the runtime projection. */
export type AgentViews = { draft: AgentRow | null; runtime?: Record<string, unknown> | null; [key: string]: unknown };

export type AgentGrade = 'read' | 'edit' | 'manage';

/** Structural request and response types, as in auth/adminOrg.mts: no express types needed. */
export type AgentSession = { isAdmin?: boolean; user?: { id?: string; role?: string; [key: string]: unknown } | null; [key: string]: unknown };
// No index signature: express's Request has none, and the gates sit in its chains.
export type AgentRequest = {
    session?: AgentSession | null;
    params?: Record<string, string | string[] | undefined>;
    agentAccess?: AgentAccess;
};
/** The shape express sees: typed loosely on purpose, so a route's handler keeps express's own Request type. */
export type GateMiddleware = (req: any, res: any, next: any) => Promise<unknown>;
type GateResponse = { status: (code: number) => { json: (body: unknown) => unknown } };
type Next = (err?: unknown) => void;

/** What a gate leaves on the request for the handler. */
export type AgentAccess = {
    agent: AgentRow;
    /** Only when the gate was asked for the views (`{ views: true }`). */
    views: AgentViews | null;
    grade: AgentGrade | 'chat';
    userId: string;
};

export type OrgPermissions = { holds: (permission: string, orgId: string | null | undefined) => boolean };
/** The user row fields the rules read (stores/userStore getUser). */
export type AgentUser = { id?: string; organizationId?: string | null; orgRole?: string | null; groups?: unknown; [key: string]: unknown };
/** The per-user inputs of the edit rule, prefetched once per request. */
export type EditContext = { permissions: OrgPermissions; orgIds: Set<string> | null; user: AgentUser | null };

/** What the edit rule alone needs (core/agentRuntime/agentAccess.js makeAgentAccess, automation/agentBinding.js). */
export type AgentEditDeps = {
    resolvePermissionsByOrg: (userId: string, session?: unknown) => Promise<OrgPermissions>;
    resolveUserOrgIds: (req: AgentRequest) => Promise<Set<string> | null>;
    getUser: (userId: string) => Promise<AgentUser | null | undefined>;
    roles: () => { SystemRoles: { SUPER_ADMIN: string }; OrgRoles: { AGENT_EDITOR: string } };
    /** utils/bestEffort fallback: a failed read is logged and grants nothing. Absent, the read fails silently. */
    fallback?: <T>(where: string, err: unknown, value: T) => T;
};

export type AgentAccessDeps = AgentEditDeps & {
    getAgent: (id: string) => Promise<AgentRow | null | undefined>;
    getAgentViews: (id: string) => Promise<AgentViews | null | undefined>;
    /** utils/routeHelpers getEffectiveUserId: the session user, or the visitor's `guest_…` id. */
    getEffectiveUserId: (req: AgentRequest) => string;
    /** auth/audience resolveUserGroups: the caller's group ids, fresh from the database. */
    resolveUserGroups: (userId: string) => Promise<string[]>;
    /** auth/audience canSeePublished. */
    canSeePublished: (entity: AgentRow, who: { userId: string; orgIds: Set<string> | null; userGroups: string[] }) => boolean;
    /** auth/permissions isOrgAdminRole. */
    isOrgAdminRole: (orgRole: string | null | undefined) => boolean;
    /** telemetry/log warn; ids only. */
    warn?: (message: string) => void;
};

const RANK: Readonly<Record<AgentGrade, number>> = Object.freeze({ read: 1, edit: 2, manage: 3 });

const HOLDS_NOWHERE: OrgPermissions = Object.freeze({ holds: () => false });

const NOT_FOUND = Object.freeze({ error: 'Agent not found' });
/** The structured 403 the clients read: they translate it and lock the editor (code `agent_not_editable`). */
const NOT_EDITABLE = Object.freeze({ error: 'You do not have permission to edit this agent.', code: 'agent_not_editable' });
const NOT_MANAGEABLE = Object.freeze({ error: 'Only the owner or an organisation admin can transfer this agent.', code: 'agent_not_editable' });

/** True for the grades at or above `min`. */
export function gradeAtLeast(grade: AgentGrade | null | undefined, min: AgentGrade): boolean {
    return !!grade && RANK[grade] >= RANK[min];
}

/** The path parameter as a string; an array (a repeated segment) names no agent. */
function paramOf(req: AgentRequest, param: string): string {
    const raw = req.params?.[param];
    return typeof raw === 'string' ? raw : '';
}

function isSystemOwned(agent: AgentRow): boolean {
    return agent.owner_id === 'system' || agent.owner_id === 'swarm';
}

function isSuperAdminSession(req: AgentRequest, superAdminRole: string): boolean {
    return !!(req.session?.isAdmin || req.session?.user?.role === superAdminRole);
}

/** The group ids an agent row carries: an array off getAgent, a JSON string off a raw row. */
function sharedGroupsOf(agent: AgentRow): string[] {
    const raw = agent.shared_groups;
    if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
    if (typeof raw === 'string' && raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
        } catch {
            return [];
        }
    }
    return [];
}

/**
 * The edit rule and its prefetch, on the deps it alone needs. The order of the
 * rules is the contract (routes/agents/crud.authz.test.js, core/agentRuntime/agentAccess.test.js):
 *   1. the owner, before any lookup (owners without manage_agents keep their flows);
 *   2. the super admin;
 *   3. an agent without an organisation is its owner's;
 *   4. membership of the agent's organisation, and manage_agents held IN it (a
 *      right held in another organisation of the caller does not count);
 *   5. an agent editor cannot edit another person's unpublished draft.
 */
export function makeAgentEditRules(deps: AgentEditDeps) {
    const swallow = deps.fallback ?? ((_where: string, _err: unknown, value) => value);
    /** The context per request and user, so a list computes `can_edit` for many agents with one set of lookups. */
    const contexts = new WeakMap<object, Map<string, Promise<EditContext>>>();
    const orgIdsMemo = new WeakMap<object, Promise<Set<string> | null>>();

    /** resolveUserOrgIds, once per request. Its rejection is the caller's to handle. */
    function orgIdsOf(req: AgentRequest): Promise<Set<string> | null> {
        if (!req || typeof req !== 'object') return deps.resolveUserOrgIds(req);
        let p = orgIdsMemo.get(req);
        if (!p) { p = Promise.resolve().then(() => deps.resolveUserOrgIds(req)); orgIdsMemo.set(req, p); }
        return p;
    }

    async function buildCanModifyContext(userId: string, req: AgentRequest): Promise<EditContext> {
        if (!userId) return { permissions: HOLDS_NOWHERE, orgIds: new Set(), user: null };
        const [permissions, orgIds, user] = await Promise.all([
            // A failed permission read grants nothing.
            Promise.resolve().then(() => deps.resolvePermissionsByOrg(userId, req.session))
                .catch((e: unknown) => swallow('auth/agentAccess:buildCanModifyContext#permissions', e, HOLDS_NOWHERE)),
            orgIdsOf(req).catch(() => new Set<string>()),
            Promise.resolve(deps.getUser(userId)).then((u) => u ?? null)
                .catch((e: unknown) => swallow('auth/agentAccess:buildCanModifyContext', e, null)),
        ]);
        return { permissions: permissions || HOLDS_NOWHERE, orgIds, user };
    }

    /** `buildCanModifyContext`, once per request and user. */
    function contextOf(userId: string, req: AgentRequest): Promise<EditContext> {
        if (!req || typeof req !== 'object') return buildCanModifyContext(userId, req);
        let perUser = contexts.get(req);
        if (!perUser) { perUser = new Map(); contexts.set(req, perUser); }
        let ctx = perUser.get(userId);
        if (!ctx) { ctx = buildCanModifyContext(userId, req); perUser.set(userId, ctx); }
        return ctx;
    }

    async function canModifyAgent(agent: AgentRow, userId: string, req: AgentRequest, ctx: EditContext | null = null): Promise<boolean> {
        if (agent.owner_id === userId) return true;
        const { SystemRoles, OrgRoles } = deps.roles();
        if (isSuperAdminSession(req, SystemRoles.SUPER_ADMIN)) return true;
        if (!agent.organization_id) return false;
        const c = ctx || await contextOf(userId, req);
        // resolveUserOrgIds answers null for the super admin only (handled above);
        // the null guard keeps a degenerate context from widening access.
        if (c.orgIds === null || !c.orgIds.has(agent.organization_id)) return false;
        if (!c.permissions || !c.permissions.holds('manage_agents', agent.organization_id)) return false;
        const orgRole = c.user ? c.user.orgRole : null;
        if (orgRole === OrgRoles.AGENT_EDITOR && !agent.is_published) return false;
        return true;
    }

    return { buildCanModifyContext, contextOf, canModifyAgent, orgIdsOf };
}

export function makeAgentRules(deps: AgentAccessDeps) {
    const edit = makeAgentEditRules(deps);
    const swallow = deps.fallback ?? ((_where: string, _err: unknown, value) => value);
    const { orgIdsOf } = edit;
    const groupsMemo = new WeakMap<object, Map<string, Promise<string[]>>>();

    /** resolveUserGroups, once per request and user. */
    function groupsOf(req: AgentRequest, userId: string): Promise<string[]> {
        if (!req || typeof req !== 'object') return deps.resolveUserGroups(userId);
        let perUser = groupsMemo.get(req);
        if (!perUser) { perUser = new Map(); groupsMemo.set(req, perUser); }
        let p = perUser.get(userId);
        if (!p) { p = deps.resolveUserGroups(userId); perUser.set(userId, p); }
        return p;
    }

    /** read: the owner, a system or swarm agent, or the published audience (super admin included). */
    async function canReadAgent(agent: AgentRow | null | undefined, userId: string, req: AgentRequest): Promise<boolean> {
        if (!agent) return false;
        if (agent.owner_id === userId) return true;
        if (isSystemOwned(agent)) return true;
        const orgIds = await orgIdsOf(req).catch(() => new Set<string>());
        const userGroups = await groupsOf(req, userId);
        return deps.canSeePublished(agent, { userId, orgIds, userGroups });
    }

    /** manage: edit, and the owner, the super admin, or an organisation admin at home in the agent's organisation. */
    async function canManageAgent(agent: AgentRow, userId: string, req: AgentRequest, ctx: EditContext | null = null): Promise<boolean> {
        if (agent.owner_id === userId) return true;
        if (isSuperAdminSession(req, deps.roles().SystemRoles.SUPER_ADMIN)) return true;
        if (!agent.organization_id) return false;
        if (!(await edit.canModifyAgent(agent, userId, req, ctx))) return false;
        const me = (ctx || await edit.contextOf(userId, req)).user;
        return !!me && me.organizationId === agent.organization_id && deps.isOrgAdminRole(me.orgRole);
    }

    /**
     * chat: the audience of a turn. Membership is read fresh (not from the
     * session), so a revoked group or organisation takes effect on the next
     * message. `userId` may be a visitor's `guest_…` id: no user row, no
     * organisation, so only a published agent in no organisation.
     */
    async function canChatAgent(agent: AgentRow, userId: string, req: AgentRequest): Promise<boolean> {
        if (!agent.is_published) return false;
        if (agent.owner_id === userId) return true;
        const user = await Promise.resolve(deps.getUser(userId))
            .catch((e: unknown) => swallow('auth/agentAccess:canChatAgent', e, null));
        const resolved = await orgIdsOf(req);
        // The super admin resolves to null (no filter): here they are a member of their home organisation.
        const userOrgIds = resolved instanceof Set ? resolved : new Set(user?.organizationId ? [user.organizationId] : []);
        if (userOrgIds.size > 0) {
            if (!agent.organization_id || !userOrgIds.has(agent.organization_id)) return false;
        } else if (agent.organization_id) {
            return false;
        }
        const groups = sharedGroupsOf(agent);
        if (groups.length === 0) return true;
        const userGroups = await groupsOf(req, userId);
        return groups.some((g) => userGroups.includes(g));
    }

    /**
     * The caller's grade on the agent, or null for none. Never looks beyond
     * `upTo`: under `upTo: 'read'` a 'read' answer means "at least read", and
     * the permission lookups of the edit rule are spent only when the read
     * rule alone refused (whoever may edit may read).
     */
    async function gradeOf(req: AgentRequest, agent: AgentRow, upTo: AgentGrade = 'manage'): Promise<AgentGrade | null> {
        const userId = deps.getEffectiveUserId(req);
        const read = await canReadAgent(agent, userId, req);
        if (read && upTo === 'read') return 'read';
        const ctx = await edit.contextOf(userId, req);
        const canEdit = await edit.canModifyAgent(agent, userId, req, ctx);
        if (!canEdit) return read ? 'read' : null;
        if (upTo === 'edit') return 'edit';
        return (await canManageAgent(agent, userId, req, ctx)) ? 'manage' : 'edit';
    }

    const { buildCanModifyContext, contextOf, canModifyAgent } = edit;
    return { buildCanModifyContext, contextOf, canModifyAgent, canReadAgent, canManageAgent, canChatAgent, gradeOf };
}

/** What the gates need to know about a caller: the rules, or a test's stand-in for them. */
export type AgentRules = {
    gradeOf: (req: AgentRequest, agent: AgentRow, upTo?: AgentGrade) => Promise<AgentGrade | null>;
    canChatAgent: (agent: AgentRow, userId: string, req: AgentRequest) => Promise<boolean>;
};
export type AgentGateDeps = Pick<AgentAccessDeps, 'getAgent' | 'getAgentViews' | 'getEffectiveUserId' | 'warn'>;

/** The two gates over `rules` (the real ones from makeAgentRules, or a test's). */
export function makeAgentGates(deps: AgentGateDeps, rules: AgentRules) {
    /**
     * The gate: load the agent behind `req.params[param]`, refuse below `minGrade`,
     * leave `req.agentAccess` for the handler. `views: true` loads
     * getAgentViews (the handler needs the projection) and decides on its draft.
     */
    function requireAgentGrade(minGrade: AgentGrade, { param = 'id', views: wantViews = false }: { param?: string; views?: boolean } = {}): GateMiddleware {
        const gate = async (req: AgentRequest, res: GateResponse, next: Next) => {
            const id = paramOf(req, param);
            let views: AgentViews | null = null;
            let agent: AgentRow | null = null;
            if (wantViews) {
                views = (await deps.getAgentViews(id)) ?? null;
                agent = views?.draft ?? null;
            } else {
                agent = (await deps.getAgent(id)) ?? null;
            }
            if (!agent) return res.status(404).json(NOT_FOUND);
            const grade = await rules.gradeOf(req, agent, minGrade);
            if (!grade) return res.status(404).json(NOT_FOUND);
            if (!gradeAtLeast(grade, minGrade)) return res.status(403).json(minGrade === 'manage' ? NOT_MANAGEABLE : NOT_EDITABLE);
            req.agentAccess = { agent, views, grade, userId: deps.getEffectiveUserId(req) };
            return next();
        };
        return tagGate(gate as GateMiddleware, { axis: 'scoped', minGrade, param });
    }

    /**
     * May a visitor without an account take a turn? Only where the agent has a
     * public chat page, which exists while its owner has Web embed switched on.
     * A visitor is never userless here (`guest_…`), so this is asked before the
     * audience rule, which would admit every published agent without an organisation.
     */
    function anonymousOutsideEmbed(agent: AgentRow, req: AgentRequest): boolean {
        return !req.session?.user?.id && !agent.embed_enabled;
    }

    /** The turn routes' gate (POST /agents/:id/chat, /chat/stream, the history). */
    function requireAgentChat({ param = 'id' }: { param?: string } = {}): GateMiddleware {
        const gate = async (req: AgentRequest, res: GateResponse, next: Next) => {
            const agent = (await deps.getAgent(paramOf(req, param))) ?? null;
            if (!agent) return res.status(404).json(NOT_FOUND);
            const userId = deps.getEffectiveUserId(req);
            if (!agent.is_published) {
                // A draft is its owner's. A visitor gets the answer a published
                // agent without a public page gives, so a probe cannot tell the two apart.
                if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
                if (agent.owner_id !== userId) return res.status(403).json({ error: 'Access denied' });
            } else if (anonymousOutsideEmbed(agent, req)) {
                return res.status(401).json({ error: 'Not authenticated' });
            } else if (userId && !(await rules.canChatAgent(agent, userId, req))) {
                deps.warn?.(`[AgentChat] user ${userId} is outside the audience of agent ${agent.id}`);
                return res.status(403).json({ error: 'Access denied' });
            }
            req.agentAccess = { agent, views: null, grade: 'chat', userId };
            return next();
        };
        return tagGate(gate as GateMiddleware, { axis: 'scoped', minGrade: 'chat', param });
    }

    return { requireAgentGrade, requireAgentChat, anonymousOutsideEmbed };
}

/** The rules and the gates over them, from one set of deps. */
export function makeAgentAccess(deps: AgentAccessDeps) {
    const rules = makeAgentRules(deps);
    return { ...rules, ...makeAgentGates(deps, rules) };
}

export type AgentAccessInstance = ReturnType<typeof makeAgentAccess>;

/** What a gate left on the request. Throws when a handler runs without its gate. */
export function agentAccessOf(req: AgentRequest): AgentAccess {
    if (!req.agentAccess) throw new Error('agent gate missing: the route runs without requireAgentGrade or requireAgentChat');
    return req.agentAccess;
}
