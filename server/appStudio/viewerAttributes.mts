/**
 * App Studio: what a row rule may know about the person reading, beyond their id and role.
 *
 *   viewer.email    the address of the person's account
 *   viewer.groups   the ids of the groups they are a member of (manual, directory-synced and
 *                   Nextcloud-mirrored groups alike: the same ids `roleMapping.byGroup` uses)
 *   viewer.orgId    the organisation of their own account, the same on every path
 *
 * All three come from the person's own user row, read HERE at the moment a query is about to
 * be compiled. Nothing is taken from the request, the session or the client: a session can be
 * hours old and group membership changes in between.
 *
 * COST. Only a model whose row rules read one of these attributes pays the user read; for every
 * other model `withViewerAttributes` returns the viewer it was given, untouched.
 *
 * UNKNOWN IS NOT EMPTY. When the user row cannot be read the attributes are left OFF the viewer.
 * The access filter (core/dataEngine/accessFilter.js) compiles an attribute that is not there to
 * "unknown": no row, not under a negation either. A list that is there and empty is a plain
 * false, which is right for someone who is in no group and for an anonymous visitor.
 *
 * `viewer.organizationId` is not touched here: every path keeps the value it always put there.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { VIEWER_ATTRIBUTES } = nodeRequire('../core/dataEngine/dataModel/vocabulary') as {
    VIEWER_ATTRIBUTES: ReadonlyArray<{ key: string; resolved?: boolean }>;
};
const { fallback } = nodeRequire('../utils/bestEffort') as { fallback<T>(label: string, err: unknown, value: T): T };

type Obj = Record<string, unknown>;
type UserRow = { email?: unknown; groups?: unknown; organizationId?: unknown } | null | undefined;
export type ViewerAttributes = { email: string | null; groups: string[]; orgId: string | null };
export type ViewerAttributeDeps = { getUser?: (userId: string) => Promise<UserRow> };

/** The attribute names this module supplies (the vocabulary's `resolved` entries). */
const RESOLVED_KEYS: readonly string[] = VIEWER_ATTRIBUTES.filter((spec) => spec.resolved === true).map((spec) => spec.key);

const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** One `rowFilters[role]` entry as text: the rule itself, or the JSON of an AST / per-operation object. */
function ruleText(entry: unknown): string {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    try { return JSON.stringify(entry) || ''; } catch { return ''; }
}

/**
 * Does any row rule of this model read a resolved attribute? Deliberately coarse (the name
 * anywhere in the rule text): a false "yes" costs one user read, a false "no" would leave a
 * rule matching nothing.
 */
export function modelReadsViewerAttributes(model: unknown): boolean {
    const tables = isObject(model) && Array.isArray(model.tables) ? model.tables : [];
    for (const table of tables) {
        const rules = isObject(table) && isObject(table.access) && isObject(table.access.rowFilters) ? table.access.rowFilters : null;
        if (!rules) continue;
        for (const entry of Object.values(rules)) {
            const text = ruleText(entry);
            if (text && RESOLVED_KEYS.some((key) => text.includes(key))) return true;
        }
    }
    return false;
}

function groupIds(raw: unknown): string[] {
    let list: unknown = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw || '[]'); } catch { list = []; }
    }
    return Array.isArray(list) ? list.filter((g): g is string => typeof g === 'string' && g !== '') : [];
}

/** What an anonymous visitor of a public page is: nobody's account, in no group, in no organisation. */
export function anonymousViewerAttributes(): ViewerAttributes {
    return { email: null, groups: [], orgId: null };
}

/**
 * The attributes of one user, fresh from the database, or null when they cannot be known (no
 * id, no such user, a failed read).
 */
export async function resolveViewerAttributes(userId: unknown, deps: ViewerAttributeDeps = {}): Promise<ViewerAttributes | null> {
    if (typeof userId !== 'string' || !userId) return null;
    const getUser = deps.getUser || (nodeRequire('../stores/userStore') as { getUser(id: string): Promise<UserRow> }).getUser;
    let user: UserRow;
    try {
        user = await getUser(userId);
    } catch (err) {
        return fallback('appStudio/viewerAttributes:user', err, null);
    }
    if (!user) return null;
    return {
        email: typeof user.email === 'string' && user.email ? user.email : null,
        groups: groupIds(user.groups),
        orgId: typeof user.organizationId === 'string' && user.organizationId ? user.organizationId : null,
    };
}

/**
 * The viewer a row rule sees: `viewer` plus the resolved attributes, when a rule of `model`
 * reads one. `viewer.id` names the user; `opts.anonymous` marks a public visitor, whose id is
 * not a user id and who gets the anonymous attributes without a lookup. Values already on the
 * viewer under these names are replaced: they are never taken from a caller.
 */
export async function withViewerAttributes<V extends Obj>(
    viewer: V, model: unknown, opts: ViewerAttributeDeps & { anonymous?: boolean } = {},
): Promise<V> {
    if (!isObject(viewer) || !modelReadsViewerAttributes(model)) return viewer;
    const attrs = opts.anonymous === true ? anonymousViewerAttributes() : await resolveViewerAttributes(viewer.id, opts);
    const out: Obj = { ...viewer };
    for (const key of RESOLVED_KEYS) delete out[key];
    return (attrs ? { ...out, ...attrs } : out) as V;
}

/**
 * The resolved attributes that are on a viewer, and nothing else: for a step that builds its
 * own narrower viewer out of the run context and must not drop them.
 */
export function viewerAttributesOf(viewer: unknown): Partial<ViewerAttributes> {
    const out: Obj = {};
    if (!isObject(viewer)) return out;
    for (const key of RESOLVED_KEYS) if (Object.hasOwn(viewer, key)) out[key] = viewer[key];
    return out as Partial<ViewerAttributes>;
}

/**
 * The context of one server step, with the resolved attributes on its viewer. A context whose
 * viewer already carries all of them (the public page resolves its anonymous visitor itself)
 * is returned as it is; a model that reads none is too.
 */
export async function ctxWithViewerAttributes<C extends Obj>(model: unknown, ctx: C, deps: ViewerAttributeDeps = {}): Promise<C> {
    if (!isObject(ctx) || !modelReadsViewerAttributes(model)) return ctx;
    const base: Obj = isObject(ctx.viewer) ? ctx.viewer : { id: ctx.viewerId ?? null };
    if (RESOLVED_KEYS.every((key) => Object.hasOwn(base, key))) return ctx;
    return { ...ctx, viewer: await withViewerAttributes(base, model, deps) };
}
