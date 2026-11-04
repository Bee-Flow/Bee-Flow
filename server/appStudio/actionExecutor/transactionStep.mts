/**
 * App Studio action executor — the `transaction` step: record writes on the
 * app's own tables that land together or not at all.
 *
 * ONE server step. Every child (create_record / update_record / delete_record)
 * is resolved and compiled up front, then all statements run in ONE database
 * batch (studioAppDbStore.batch, a single transaction on both engines). An
 * update or delete that changes no row (missing, outside the viewer's scope,
 * or changed by someone else when it carries expectedUpdatedAt) fails the
 * batch through `expectChanges`, so nothing an earlier child wrote is kept.
 *
 * A child's resultVar is readable by the children after it (`vars.order.id`):
 * an insert's id is chosen before the statement runs. The step's result is
 * `{ results, vars, count }`; the runners copy `vars` into the sequence's vars.
 *
 * Refused before anything runs: a child of another kind, a missing table, a
 * table backed by a Studio datatable (another store: no shared rollback), a
 * role that may not write. Quotas are checked once, before the batch.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type Table = Obj & { key: string; id?: string };
type Statement = { sql: string; params: unknown[]; expectChanges?: boolean };
type Planned = { kind: string; table: Table; statement: Statement; result: Obj; expectedUpdatedAt: string | null; resultVar: string | null };

const { TRANSACTION_CHILD_KINDS, MAX_TRANSACTION_STEPS } = nodeRequire('../../shared/appDefinition/stepFlow.mjs') as {
    TRANSACTION_CHILD_KINDS: readonly string[]; MAX_TRANSACTION_STEPS: number;
};

type Deps = {
    queryCompiler: {
        compileInsert(t: Table, v: Obj, o: Obj): { sql: string; params: unknown[]; id: string };
        compileUpdate(t: Table, id: string, v: Obj, f: unknown, o: Obj): { sql: string; params: unknown[] };
        compileDelete(t: Table, id: string, f: unknown): { sql: string; params: unknown[] };
    };
    rls: { assertCanWrite(t: Table, role: unknown, op: string): void; compileAccessFilter(t: Table, role: unknown, viewer: unknown, op: string): unknown };
    db: { batch(ownerId: string, appId: string, statements: Statement[]): Promise<unknown[]> };
    quota: { assertRowQuota(app: App, key: string, adding?: number, appAdding?: number): Promise<void>; assertDbByteQuota(app: App): Promise<void> };
    isDatatableBacked(t: Table): boolean;
    shared: {
        findTable(model: unknown, id: unknown): Table | null;
        buildServerScope(ctx: Obj): unknown;
        resolveBinding(b: unknown, ctx: Obj, scope: unknown): unknown;
        resolveValues(v: unknown, ctx: Obj, scope: unknown): Obj;
        coerceRecordId(v: unknown): string | null;
        writeViewer(ctx: Obj): Obj;
    };
    records: { bumpVersion(app: App, key: string): Promise<void>; bumpCount(app: App, key: string, delta: number): Promise<void> };
    describeStepError(e: unknown, step: unknown): { ok: false; error: string; code: string; retryable: boolean };
};

/**
 * The data-version and row-count bumps after a commit, best effort like the
 * record writes' own (actionExecutor/records.js): the rows are already saved,
 * a missed bump is a stale cache, never a failed step.
 */
function bookkeepingStore(): Deps['records'] {
    const store = nodeRequire('../../stores/studioAppDataStore') as {
        bumpDataVersion(appId: string, key: string, ownerId: string): Promise<unknown>;
        bumpRowCount(appId: string, key: string, delta: number, ownerId: string): Promise<unknown>;
    };
    const log = nodeRequire('../../telemetry/log') as { warn: (msg: string, meta?: Obj) => void };
    const quietly = async (what: string, run: () => Promise<unknown>): Promise<void> => {
        try { await run(); } catch (e) { log.warn(`[ActionExecutor] transaction ${what} bump failed`, { name: (e as Error)?.name ?? null }); }
    };
    return {
        bumpVersion: (app, key) => quietly('data-version', () => store.bumpDataVersion(app.id, key, app.userId)),
        bumpCount: (app, key, delta) => quietly('row-count', () => store.bumpRowCount(app.id, key, delta, app.userId)),
    };
}

function defaultDeps(): Deps {
    return {
        queryCompiler: nodeRequire('../queryCompiler'),
        rls: nodeRequire('../rlsGateway'),
        db: nodeRequire('../../stores/studioAppDbStore'),
        quota: nodeRequire('../studioAppQuota'),
        isDatatableBacked: (nodeRequire('../datatableSource') as { isDatatableBacked: (t: Table) => boolean }).isDatatableBacked,
        shared: nodeRequire('./shared'),
        records: bookkeepingStore(),
        describeStepError: (nodeRequire('./stepErrors.mts') as { describeStepError: Deps['describeStepError'] }).describeStepError,
    };
}

const refuse = (error: string, code: string): { ok: false; error: string; code: string; retryable: false } => ({ ok: false, error, code, retryable: false });
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Step N of the transaction (1-based, as a person counts) and its kind. */
const label = (i: number, kind: string): string => `Step ${i + 1} of the transaction (${kind})`;

type Refusal = ReturnType<typeof refuse>;

/** The child's table, or why it cannot take part. */
function tableFor(d: Deps, model: unknown, child: Obj, i: number, kind: string): { table: Table } | Refusal {
    const table = d.shared.findTable(model, child.tableId);
    if (!table) return refuse(`${label(i, kind)}: Table not found. Nothing was saved.`, 'transaction_invalid');
    if (d.isDatatableBacked(table)) {
        return refuse(`${label(i, kind)}: a linked table cannot be written in a transaction (it lives in another store, so it cannot be rolled back together). Nothing was saved.`, 'transaction_linked_table');
    }
    return { table };
}

/** One child, compiled against the vars the children before it produced. */
function planChild(d: Deps, app: App, model: unknown, child: Obj, i: number, ctx: Obj): Planned | Refusal {
    const kind = typeof child.kind === 'string' ? child.kind : '';
    if (!TRANSACTION_CHILD_KINDS.includes(kind)) {
        return refuse(`${label(i, kind || 'unknown')}: a transaction holds only create_record, update_record and delete_record. Nothing was saved.`, 'transaction_invalid');
    }
    const found = tableFor(d, model, child, i, kind);
    if ('ok' in found) return found;
    const { table } = found;
    const viewer = d.shared.writeViewer(ctx);
    const role = viewer.role ?? null;
    const scope = d.shared.buildServerScope(ctx);
    const resultVar = typeof child.resultVar === 'string' && child.resultVar ? child.resultVar : null;
    if (kind === 'create_record') {
        d.rls.assertCanWrite(table, role, 'create');
        const values = d.shared.resolveValues(child.values, ctx, scope);
        const c = d.queryCompiler.compileInsert(table, values, { createdBy: viewer.id ?? null, orgId: app.organizationId || null });
        return { kind, table, statement: { sql: c.sql, params: c.params }, result: { id: c.id, created: true }, expectedUpdatedAt: null, resultVar };
    }
    const recordId = d.shared.coerceRecordId(d.shared.resolveBinding(child.recordId, ctx, scope));
    if (!recordId) return refuse(`${label(i, kind)}: Record not found. Nothing was saved.`, 'transaction_rolled_back');
    const op = kind === 'update_record' ? 'update' : 'delete';
    d.rls.assertCanWrite(table, role, op);
    const filter = d.rls.compileAccessFilter(table, role, viewer, op);
    if (kind === 'update_record') {
        const values = d.shared.resolveValues(child.values, ctx, scope);
        const raw = child.expectedUpdatedAt !== undefined ? d.shared.resolveBinding(child.expectedUpdatedAt, ctx, scope) : null;
        const expectedUpdatedAt = typeof raw === 'string' && raw ? raw : null;
        const c = d.queryCompiler.compileUpdate(table, recordId, values, filter, { expectedUpdatedAt });
        return { kind, table, statement: { sql: c.sql, params: c.params, expectChanges: true }, result: { id: recordId, updated: true, changes: 1 }, expectedUpdatedAt, resultVar };
    }
    const c = d.queryCompiler.compileDelete(table, recordId, filter);
    return { kind, table, statement: { sql: c.sql, params: c.params, expectChanges: true }, result: { id: recordId, deleted: true, changes: 1 }, expectedUpdatedAt: null, resultVar };
}

/** Every child planned in order, with resultVars accumulating; or the first refusal. */
function planAll(d: Deps, app: App, model: unknown, children: unknown[], ctx: Obj): { plan: Planned[]; vars: Obj } | Refusal {
    const plan: Planned[] = [];
    const vars: Obj = {};
    const baseVars = isObject(ctx.vars) ? ctx.vars : {};
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!isObject(child)) return refuse(`${label(i, 'unknown')}: not a step. Nothing was saved.`, 'transaction_invalid');
        const planned = planChild(d, app, model, child, i, { ...ctx, vars: { ...baseVars, ...vars } });
        if ('ok' in planned) return planned;
        plan.push(planned);
        if (planned.resultVar) vars[planned.resultVar] = planned.result;
    }
    return { plan, vars };
}

async function assertQuotas(d: Deps, app: App, plan: Planned[]): Promise<void> {
    // Every create of the batch counts: per table, and in total for the app-wide cap.
    const created = new Map<string, number>();
    for (const p of plan) if (p.kind === 'create_record') created.set(p.table.key, (created.get(p.table.key) ?? 0) + 1);
    const total = [...created.values()].reduce((a, b) => a + b, 0);
    for (const [name, n] of created) await d.quota.assertRowQuota(app, name, n, total);
    if (plan.some((p) => p.kind !== 'delete_record')) await d.quota.assertDbByteQuota(app);
}

/** The batch failed: name the child, and say that nothing was kept. */
function rolledBack(d: Deps, e: unknown, plan: Planned[], step: Obj): Refusal | ReturnType<Deps['describeStepError']> {
    const err = e as { code?: unknown; statementIndex?: unknown };
    if (err && err.code === 'batch_no_rows' && Number.isInteger(err.statementIndex)) {
        const i = err.statementIndex as number;
        const p = plan[i];
        const why = p && p.expectedUpdatedAt
            ? 'This record was changed by someone else — refresh and try again.'
            : 'Record not found.';
        return refuse(`${label(i, p ? p.kind : 'unknown')}: ${why} Nothing was saved.`, 'transaction_rolled_back');
    }
    const described = d.describeStepError(e, step);
    return { ...described, error: `${described.error} Nothing was saved.` };
}

/** After the commit: one data-version bump per table, row counts by their net change. */
async function bookkeeping(d: Deps, app: App, plan: Planned[]): Promise<void> {
    const delta = new Map<string, number>();
    for (const p of plan) {
        const n = p.kind === 'create_record' ? 1 : p.kind === 'delete_record' ? -1 : 0;
        delta.set(p.table.key, (delta.get(p.table.key) ?? 0) + n);
    }
    for (const [key, n] of delta) {
        await d.records.bumpVersion(app, key);
        if (n) await d.records.bumpCount(app, key, n);
    }
}

/**
 * Run a `transaction` step. Throws only what the dispatcher maps itself (an
 * access refusal, a compile error, a quota error, before anything is written);
 * a failure of the batch is answered here, naming the child.
 */
export async function transactionStep(app: App, model: unknown, step: Obj, ctx: Obj = {}, deps?: Partial<Deps>): Promise<Obj> {
    const d: Deps = { ...defaultDeps(), ...(deps ?? {}) };
    const children = Array.isArray(step.steps) ? step.steps : [];
    if (!children.length) return { ok: true, result: { results: [], vars: {}, count: 0 } };
    if (children.length > MAX_TRANSACTION_STEPS) {
        return refuse(`A transaction holds at most ${MAX_TRANSACTION_STEPS} steps; this one has ${children.length}. Nothing was saved.`, 'transaction_too_many');
    }
    const planned = planAll(d, app, model, children, ctx);
    if ('ok' in planned) return planned;
    const { plan, vars } = planned;
    await assertQuotas(d, app, plan);
    try {
        await d.db.batch(app.userId, app.id, plan.map((p) => p.statement));
    } catch (e) {
        return rolledBack(d, e, plan, step);
    }
    await bookkeeping(d, app, plan);
    return { ok: true, result: { results: plan.map((p) => p.result), vars, count: plan.length } };
}
