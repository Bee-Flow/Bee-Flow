/**
 * Notebook access: "may this person do X to this notebook", decided in one place.
 *
 * The role comes from the store (stores/notebookStore getNotebook: the row the
 * caller may see, with `role`), which builds it from the rules every notebook
 * surface shares and which this module does not repeat:
 *   owner   the notebook's own owner (`notebooks.user_id`): delete it, delete
 *           its versions, pin it, change its knowledge bases;
 *   editor  a project editor or owner of the project the notebook is filed
 *           in (the project ladder, auth/projectAccess through
 *           stores/lib/projectRole), or someone it is shared with for
 *           editing: change the document and its sources, generate, fill,
 *           import, name and restore versions;
 *   viewer  a project viewer, or someone it is shared with: read the notebook,
 *           its sources, versions and exports; chat with it privately (the AI
 *           may not change it on a viewer's behalf).
 * A project owner is an EDITOR of a colleague's notebook: deleting someone's
 * work, or its history, stays with the person whose notebook it is. The roles
 * are a ladder (`hasNotebookRole`).
 *
 * One gate puts the answer in a route's chain, tagged so the route contract
 * (auth/routeContract.js) records the route as `scoped`:
 *   requireNotebookRole(min)  404 `notebook_not_found` when the caller holds no
 *                             role at all (a stranger cannot tell a notebook
 *                             they may not see from one that does not exist;
 *                             an unknown id answers the same), 403
 *                             `notebook_read_only` / `notebook_owner_only`
 *                             when the role is too low. Leaves the loaded
 *                             notebook as `req.notebook` and the role as
 *                             `req.notebookRole`, so a handler does not read
 *                             it a second time.
 * The same rule auth/projectAccess.requireProjectRole applies to projects.
 *
 * Pure: the store comes in through `deps`, read at call time so a test that
 * swaps `notebookStore.getNotebook` (testUtils/swaps.js) is honoured;
 * `defaultNotebookAccess` wires the real store for the routes, and
 * `requireNotebookRole(min, { store })` is the gate over a test's own store.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type GateMeta = { tagGate: <T extends (...args: never[]) => unknown>(fn: T, meta: Record<string, unknown>) => T };
type Errors = { HttpError: new (status: number, code: string, message: string) => Error };
const { tagGate } = nodeRequire('./gateMeta.js') as GateMeta;
const { HttpError } = nodeRequire('../core/http/errors.js') as Errors;

export type NotebookRole = 'viewer' | 'editor' | 'owner';

/** The notebook as the store answers it to a caller: the row, with the caller's role on it. */
export type NotebookRow = { id: string; userId?: string | null; role?: NotebookRole | string | null; [key: string]: any };

/** Structural request type, as in auth/agentAccess.mts: no express types needed. */
export type NotebookRequest = {
    session?: { user?: { id?: string; [key: string]: unknown } | null; [key: string]: unknown } | null;
    params?: Record<string, string | string[] | undefined>;
    notebook?: NotebookRow;
    notebookRole?: string;
};
/** The shape express sees: typed loosely on purpose, so a route's handler keeps express's own Request type. */
export type GateMiddleware = (req: any, res: any, next: any) => Promise<unknown>;
type Next = (err?: unknown) => void;

export type NotebookAccessDeps = {
    /** stores/notebookStore getNotebook: the notebook when the caller may see it, with `role`; else null. */
    getNotebook: (id: string, userId: string) => Promise<NotebookRow | null | undefined>;
};

export const ROLE_RANK: Readonly<Record<NotebookRole, number>> = Object.freeze({ viewer: 1, editor: 2, owner: 3 });

const REFUSALS: Readonly<Record<'editor' | 'owner', { code: string; message: string }>> = Object.freeze({
    editor: { code: 'notebook_read_only', message: 'You can view this notebook but not change it. Ask its owner for edit access.' },
    owner: { code: 'notebook_owner_only', message: 'Only the owner of this notebook can do this.' },
});

/** True for the roles at or above `min`. */
export function hasNotebookRole(role: string | null | undefined, min: NotebookRole): boolean {
    return (ROLE_RANK[(role || '') as NotebookRole] || 0) >= ROLE_RANK[min];
}

/** The path parameter as a string; an array (a repeated segment) names no notebook. */
function paramOf(req: NotebookRequest, param: string): string {
    const raw = req.params?.[param];
    return typeof raw === 'string' ? raw : '';
}

export function makeNotebookAccess(deps: NotebookAccessDeps) {
    /**
     * The caller's role on the notebook, with the row, or null for none (the
     * store already answers nothing for a stranger; a row without a role is
     * its owner's when the owner asks, nobody's otherwise).
     */
    async function roleOf(req: NotebookRequest, id: string): Promise<{ notebook: NotebookRow; role: NotebookRole } | null> {
        const userId = req.session?.user?.id;
        if (!userId || !id) return null;
        const notebook = (await deps.getNotebook(id, userId)) ?? null;
        if (!notebook) return null;
        const role = (notebook.role || (notebook.userId === userId ? 'owner' : null)) as NotebookRole | null;
        if (!role || !ROLE_RANK[role]) return null;
        return { notebook, role };
    }

    /**
     * The gate: load the notebook behind `req.params[param]` for the caller,
     * refuse below `min`, leave `req.notebook` and `req.notebookRole`.
     */
    function requireNotebookRole(min: NotebookRole, { param = 'id' }: { param?: string } = {}): GateMiddleware {
        if (!ROLE_RANK[min]) throw new Error(`requireNotebookRole: unknown role "${min}"`);
        const gate = async (req: NotebookRequest, _res: unknown, next: Next) => {
            if (!req.session?.user?.id) throw new HttpError(401, 'unauthorized', 'Not authenticated');
            const held = await roleOf(req, paramOf(req, param));
            if (!held) throw new HttpError(404, 'notebook_not_found', 'Notebook not found');
            if (!hasNotebookRole(held.role, min)) {
                const refusal = REFUSALS[min === 'owner' ? 'owner' : 'editor'];
                throw new HttpError(403, refusal.code, refusal.message);
            }
            req.notebook = held.notebook;
            req.notebookRole = held.role;
            return next();
        };
        return tagGate(gate as GateMiddleware, { axis: 'scoped', minGrade: min, param });
    }

    return { roleOf, requireNotebookRole };
}

export type NotebookAccessInstance = ReturnType<typeof makeNotebookAccess>;

type NotebookStoreLike = { getNotebook: (id: string, userId: string) => Promise<NotebookRow | null | undefined> };

let defaultInstance: NotebookAccessInstance | null = null;

/** The gate over the real store (stores/notebookStore), required lazily and read at call time. */
export function defaultNotebookAccess(): NotebookAccessInstance {
    if (!defaultInstance) {
        defaultInstance = makeNotebookAccess({
            // Spelled as the routes spell it, so a test's module mock of the store (keyed on the request) is honoured.
            getNotebook: (id, userId) => (nodeRequire('../stores/notebookStore') as NotebookStoreLike).getNotebook(id, userId),
        });
    }
    return defaultInstance;
}

/**
 * The gate every notebook route puts first: over the real store, or over
 * `store` (a test's own) when given.
 */
export function requireNotebookRole(min: NotebookRole, { store, param }: { store?: NotebookStoreLike; param?: string } = {}): GateMiddleware {
    const access = store ? makeNotebookAccess({ getNotebook: (id, userId) => store.getNotebook(id, userId) }) : defaultNotebookAccess();
    return access.requireNotebookRole(min, { param });
}
