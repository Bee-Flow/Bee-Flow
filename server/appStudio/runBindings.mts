/**
 * Resolve a binding on the server the way a click sees it: the server walker's `resolve`
 * (app_run_action, app_run_tests) for a loop source and a set_variable value. Not for the
 * wouldSend preview of send_email: the real email step does not read data bindings, so that
 * preview uses the executor's plain resolver (mcpRunHost.wouldSendOf).
 *
 *   - record / records / aggregate: READ, through stepDataSource.resolveDataBinding (the
 *     query compiler and the row-level access filter, as the app owner). A formula-valued
 *     shape field (groupBy, aggregates, sort, limit) is resolved first, as the browser does
 *     (resolveBindingShape). `limit` defaults to 50 (what a screen gets) and is capped at
 *     `maxRows`. `pick` and, for record, `path` are applied after the read.
 *   - static / field / formula: shared.resolveBinding, as before.
 *   - dataset / connector: not read (a connector run may have side effects; a dataset needs a
 *     request context). null, with a note.
 *
 * A refusal the read throws with `safe: true` (an access rule, a link that is gone) becomes the
 * step's error with that message; any other failure reads as "returned nothing", with a note.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;

export type ReadData = (app: unknown, model: unknown, binding: Obj, opts: {
    viewer: unknown; role: string; resolveValue: (b: Obj) => unknown; maxRows: number;
}) => Promise<unknown>;

export type RunBindingEnv = {
    app: { id: string; userId: string; organizationId?: string | null };
    model: unknown;
    ctx: Obj;
    scope: unknown;
    /** Ceiling on rows for this read (200 for a loop source). */
    maxRows: number;
    /** The read seam (default stepDataSource.resolveDataBinding). */
    readData?: ReadData;
    /** Non-data kinds (default actionExecutor/shared.resolveBinding). */
    resolveBinding?: (binding: unknown, ctx: Obj, scope: unknown) => unknown;
    /** Called before every read; throws to refuse (the read cap). */
    onRead?: () => void;
    onNote?: (text: string) => void;
    /** The step path, for notes. */
    where?: string;
};

/** What a screen gets when a binding sets no limit (queryCompilerBase DEFAULT_LIMIT). */
export const DEFAULT_LIMIT = 50;
const DATA_KINDS = new Set(['record', 'records', 'aggregate']);
const SHAPE_FIELDS = ['groupBy', 'aggregates', 'sort', 'limit'] as const;

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A refusal the caller may show: the message is the reason, never internals. */
export class BindingRefusal extends Error {
    safe = true;
    code: string | undefined;
    constructor(message: string, code?: string) { super(message); this.code = code; }
}

function shared(): { resolveBinding: (b: unknown, ctx: Obj, scope: unknown) => unknown } {
    return nodeRequire('./actionExecutor/shared.js');
}

function plainResolver(env: RunBindingEnv): (b: unknown, ctx: Obj, scope: unknown) => unknown {
    return env.resolveBinding ?? shared().resolveBinding;
}

/** The binding with formula-valued shape fields resolved (absent when they resolve to nothing). */
function resolveShape(binding: Obj, env: RunBindingEnv): Obj {
    const out: Obj = { ...binding };
    const resolve = plainResolver(env);
    for (const field of SHAPE_FIELDS) {
        const raw = binding[field];
        if (!isObject(raw) || raw.kind !== 'formula') continue;
        const value = resolve(raw, env.ctx, env.scope);
        if (value === undefined || value === null) delete out[field];
        else out[field] = value;
    }
    return out;
}

/** Same rule as the client walkPath: a path in the shared grammar, else one own key ("Full name"). */
function walkPath(value: unknown, path: unknown): unknown {
    if (path == null || path === '') return value;
    if (typeof path !== 'string') return undefined;
    const expr = nodeRequire('../shared/expr/path.mjs') as { parsePath: (p: string) => unknown; getRelativePath: (v: unknown, p: string) => unknown };
    let p = path.trim();
    if (p.startsWith('$.')) p = p.slice(2); else if (p.startsWith('$[')) p = p.slice(1);
    if (p === '' || p === '$' || expr.parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`) !== null) return expr.getRelativePath(value, path);
    return isObject(value) && Object.hasOwn(value, path) ? value[path] : undefined;
}

/** The client's applyPick: one value out of a row-shaped result. */
export function applyPick(value: unknown, pick: unknown): unknown {
    if (!isObject(pick)) return value;
    let row = value;
    if (Array.isArray(row)) {
        if (row.length === 0) return undefined;
        row = pick.row === 'last' ? row[row.length - 1] : row[0];
    }
    const column = pick.column;
    if (column == null || column === '') return row;
    if (!isObject(row)) return undefined;
    return Object.hasOwn(row, String(column)) ? row[String(column)] : undefined;
}

/**
 * stepDataSource.resolveFilters' `required` rule, asked up front so the walk can say why a
 * read returned no rows (and skip the read): a required filter without a value reads nothing.
 */
function blockedByRequiredFilter(binding: Obj, resolveValue: (b: Obj) => unknown): boolean {
    if (!Array.isArray(binding.filter)) return false;
    return binding.filter.some((entry) => {
        if (!isObject(entry) || entry.required !== true) return false;
        const raw = entry.value;
        const value = isObject(raw) && typeof raw.kind === 'string' ? resolveValue(raw) : raw;
        return value === undefined || value === null || value === '';
    });
}

function defaultReadData(): ReadData {
    return (nodeRequire('./stepDataSource.js') as { resolveDataBinding: ReadData }).resolveDataBinding;
}

function noteOf(env: RunBindingEnv, text: string): void {
    env.onNote?.(env.where ? `${env.where}: ${text}` : text);
}

async function readOnce(binding: Obj, env: RunBindingEnv, resolveValue: (b: Obj) => unknown): Promise<unknown> {
    env.onRead?.();
    const read = env.readData ?? defaultReadData();
    try {
        return await read(env.app, env.model, binding, {
            viewer: { id: env.app.userId, role: 'owner', organizationId: env.app.organizationId || null },
            role: 'owner', resolveValue, maxRows: env.maxRows,
        });
    } catch (e) {
        const err = e as { safe?: boolean; message?: string; code?: unknown };
        if (err && err.safe === true && err.message) throw new BindingRefusal(err.message, typeof err.code === 'string' ? err.code : undefined);
        return null;
    }
}

async function resolveData(binding: Obj, env: RunBindingEnv): Promise<unknown> {
    const shaped = resolveShape(binding, env);
    const limit = typeof shaped.limit === 'number' && Number.isFinite(shaped.limit) && shaped.limit > 0 ? shaped.limit : DEFAULT_LIMIT;
    const capped = Math.min(limit, env.maxRows);
    const query: Obj = { ...shaped, limit: capped };
    const resolveValue = (b: Obj): unknown => plainResolver(env)(b, env.ctx, env.scope);
    if (blockedByRequiredFilter(query, resolveValue)) {
        noteOf(env, `a required filter of the ${binding.kind} binding has no value, so it reads no rows (as on a screen).`);
        return binding.kind === 'record' ? null : [];
    }
    const got = await readOnce(query, env, resolveValue);
    if (got === null || got === undefined) {
        noteOf(env, `the ${binding.kind} binding returned nothing (unknown table or a filter the compiler refused); check it with app_query_data.`);
        return null;
    }
    if (Array.isArray(got) && binding.kind !== 'record' && got.length >= capped) {
        noteOf(env, `the ${binding.kind} binding returned its limit of ${capped} rows; set limit on the binding for more (at most ${env.maxRows} here).`);
    }
    if (binding.pick !== undefined && binding.pick !== null) return applyPick(got, binding.pick);
    if (binding.kind === 'record' && binding.path) return walkPath(got, binding.path);
    return got;
}

/** One binding, resolved for a server walk. See the header for the rules per kind. */
export async function resolveRunBinding(binding: unknown, env: RunBindingEnv): Promise<unknown> {
    if (isObject(binding) && typeof binding.kind === 'string' && DATA_KINDS.has(binding.kind)) return resolveData(binding, env);
    if (isObject(binding) && (binding.kind === 'dataset' || binding.kind === 'connector')) {
        noteOf(env, `${binding.kind} bindings are not read here (a connector run may have side effects); pass the rows in scope.vars, or read a dataset with a dataset_query step.`);
        return null;
    }
    return plainResolver(env)(binding, env.ctx, env.scope);
}
