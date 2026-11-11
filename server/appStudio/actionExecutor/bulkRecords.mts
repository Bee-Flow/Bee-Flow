/**
 * App Studio action executor: update_record / delete_record in FILTER mode (package 5).
 *
 * Instead of one `recordId`, the step names a clause list (`filter`) and a `limit` (default and
 * maximum LIMITS.MAX_BULK_WRITE_ROWS). The rows are matched under the WRITE access filter of the
 * op on the table's own storage (writeTarget.mts), oldest first; at most `limit` of them change,
 * and the result says how many matched and how many remain:
 *
 *   { bulk: true, matched, updated | deleted, changes, remaining, ids }
 *
 * App storage and a linked datatable change in ONE statement (atomic, the filters re-applied to
 * the picked ids so a row that changed in between is left alone). A source mirror writes row by
 * row through the source (not atomic). Zero matches is a success with zeros. A filter clause whose
 * value resolves to nothing BLOCKS the write (nothing changes, a note says which field): an empty
 * value never widens the filter to every row.
 *
 * The one-row path (recordId) stays in records.js, unchanged.
 */

import { createRequire } from 'node:module';
import { resolveWriteTarget, resolveStrictFilters, matchIds, countMatching, WriteFilterError } from './writeTarget.mts';
import type { Filter, WriteTarget } from './writeTarget.mts';
import { applyFieldRules } from '../../core/dataEngine/fieldRules.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type StepResult = Obj & { ok: boolean };
type Op = 'update' | 'delete';

const shared = nodeRequire('./shared') as {
    findTable(model: unknown, id: unknown): (Obj & { key: string; id?: string }) | null;
    buildServerScope(ctx: Obj): unknown;
    resolveBinding(b: unknown, ctx: Obj, scope: unknown): unknown;
    resolveValues(v: unknown, ctx: Obj, scope: unknown): Obj;
    writeViewer(ctx: Obj): Obj;
};
const records = nodeRequire('./records') as {
    mirrorWrites(bound: Obj): { updateRow(c: unknown, id: string, v: Obj, o: Obj): Promise<{ changes: number }>; deleteRow(c: unknown, id: string): Promise<{ changes: number }> };
    mirrorCtx(bound: Obj): unknown;
    sourceRefusal(e: unknown): StepResult | null;
    managedRefusal(e: unknown): StepResult | null;
};
const bulk = nodeRequire('../../core/dataEngine/queryCompilerBulk.mts') as {
    clampBulkLimit(l: unknown): number;
    compileDeleteIds(t: unknown, ids: string[], f: Filter[], a: unknown, o: Obj): { sql: string; params: unknown[] };
    compileUpdateIds(t: unknown, ids: string[], v: Obj, f: Filter[], a: unknown, o: Obj): { sql: string; params: unknown[] };
};
const { LIMITS } = nodeRequire('../componentSpecs/limits') as { LIMITS: Record<string, number> };
const log = nodeRequire('../../telemetry/log') as { info(msg: string, meta?: Obj): void };

export type BulkOutcome = { matched: number; changed: number; remaining: number; ids: string[] };

/** The note a blocked filter leaves; the field name is the author's, never a value. */
export const blockedNote = (field: string): string => `The filter value for "${field}" was empty, so no rows were changed.`;

/** Delete the first `limit` rows matching `filters` on `target`. */
export async function eraseMatching(target: WriteTarget, filters: Filter[], limit: number): Promise<BulkOutcome> {
    const { matched, ids } = await matchIds(target, filters, limit);
    if (!ids.length) return { matched, changed: 0, remaining: matched, ids: [] };
    let changed = 0;
    if (target.kind === 'mirror' && target.bound) {
        const w = records.mirrorWrites(target.bound);
        for (const id of ids) changed += (await w.deleteRow(records.mirrorCtx(target.bound), id)).changes || 0;
    } else {
        const c = bulk.compileDeleteIds(target.tableMeta, ids, filters, target.access, { dialect: target.dialect });
        changed = await target.exec(c.sql, c.params);
    }
    if (changed) await target.bump(0 - changed);
    return { matched, changed, remaining: Math.max(0, matched - ids.length), ids };
}

/** Update the first `limit` rows matching `filters` on `target` with the resolved `values`. */
export async function updateMatching(app: App, target: WriteTarget, filters: Filter[], values: Obj, limit: number): Promise<BulkOutcome> {
    const { matched, ids } = await matchIds(target, filters, limit);
    if (!ids.length) return { matched, changed: 0, remaining: matched, ids: [] };
    let changed = 0;
    if (target.kind === 'mirror' && target.bound) {
        const w = records.mirrorWrites(target.bound);
        for (const id of ids) changed += (await w.updateRow(records.mirrorCtx(target.bound), id, values, {})).changes || 0;
    } else {
        // Updates need byte headroom on the app's own storage, as a one-row update does.
        if (target.kind === 'app') await (nodeRequire('../studioAppQuota') as { assertDbByteQuota(a: App): Promise<void> }).assertDbByteQuota(app);
        const c = bulk.compileUpdateIds(target.tableMeta, ids, values, filters, target.access, { dialect: target.dialect });
        changed = await target.exec(c.sql, c.params);
    }
    if (changed) await target.bump(0);
    return { matched, changed, remaining: Math.max(0, matched - ids.length), ids };
}

type Prepared = { target: WriteTarget; filters: Filter[]; limit: number; scope: unknown } | { result: StepResult };

/** Table, target, strict filters: or the result that ends the step here. */
async function prepare(app: App, model: unknown, step: Obj, ctx: Obj, op: Op): Promise<Prepared> {
    const table = shared.findTable(model, step.tableId);
    if (!table) return { result: { ok: false, error: 'Table not found' } };
    const scope = shared.buildServerScope(ctx);
    let target: WriteTarget;
    try {
        target = await resolveWriteTarget(app, table, shared.writeViewer(ctx), op);
    } catch (e) { const r = records.sourceRefusal(e); if (r) return { result: r }; throw e; }
    const strict = resolveStrictFilters(step.filter, (b) => shared.resolveBinding(b, ctx, scope));
    const limit = bulk.clampBulkLimit(step.limit);
    if (strict.blocked) {
        const note = blockedNote(strict.field);
        const zero = op === 'update' ? { updated: 0 } : { deleted: 0 };
        return { result: { ok: true, notes: [note], result: { bulk: true, matched: 0, ...zero, changes: 0, remaining: 0, ids: [], notes: [note] } } };
    }
    return { target, filters: strict.filters, limit, scope };
}

function bulkResult(op: Op, out: BulkOutcome, limit: number): StepResult {
    const notes = out.remaining > 0 ? [`${out.remaining} more rows match; limit ${limit}. Run the step again to continue.`] : [];
    const counted = op === 'update' ? { updated: out.changed } : { deleted: out.changed };
    const result: Obj = { bulk: true, matched: out.matched, ...counted, changes: out.changed, remaining: out.remaining, ids: out.ids };
    if (notes.length) result.notes = notes;
    return notes.length ? { ok: true, notes, result } : { ok: true, result };
}

/** The refusals this module answers itself; anything else goes back to the dispatcher. */
function refusalOf(e: unknown): StepResult | null {
    if (e instanceof WriteFilterError) return { ok: false, error: e.message, code: e.code, retryable: false };
    return records.managedRefusal(e) || records.sourceRefusal(e);
}

async function runBulk(app: App, model: unknown, step: Obj, ctx: Obj, op: Op): Promise<StepResult> {
    try {
        const p = await prepare(app, model, step, ctx, op);
        if ('result' in p) return p.result;
        const out = op === 'update'
            ? await updateMatching(app, p.target, p.filters, applyFieldRules(p.target.table, shared.resolveValues(step.values, ctx, p.scope), { op: 'update', role: shared.writeViewer(ctx).role ?? null }), p.limit)
            : await eraseMatching(p.target, p.filters, p.limit);
        // Counts only: no values, no ids (they are customer data in someone's table).
        log.info('[ActionExecutor] bulk record write', { appId: app.id, table: p.target.table.key, op, matched: out.matched, changed: out.changed, remaining: out.remaining });
        return bulkResult(op, out, p.limit);
    } catch (e) {
        const r = refusalOf(e);
        if (r) return r;
        throw e;
    }
}

/** update_record with `filter`. */
export function bulkUpdateRecordStep(app: App, model: unknown, step: Obj, ctx: Obj = {}): Promise<StepResult> {
    return runBulk(app, model, step, ctx, 'update');
}

/** delete_record with `filter`. */
export function bulkDeleteRecordStep(app: App, model: unknown, step: Obj, ctx: Obj = {}): Promise<StepResult> {
    return runBulk(app, model, step, ctx, 'delete');
}

/**
 * Read-only preview for a dry run: how many rows a filter-mode step WOULD change. Never writes.
 * `{ matched, wouldAffect, limit }`, or `{ blocked: field }` when a value is empty.
 */
export async function previewMatching(app: App, model: unknown, step: Obj, ctx: Obj = {}): Promise<Obj> {
    const op: Op = step.kind === 'delete_record' ? 'delete' : 'update';
    const table = shared.findTable(model, step.tableId);
    if (!table) return { error: 'Table not found' };
    const scope = shared.buildServerScope(ctx);
    try {
        const target = await resolveWriteTarget(app, table, shared.writeViewer(ctx), op);
        const strict = resolveStrictFilters(step.filter, (b) => shared.resolveBinding(b, ctx, scope));
        const limit = bulk.clampBulkLimit(step.limit);
        if (strict.blocked) return { blocked: strict.field, limit };
        const matched = await countMatching(target, strict.filters);
        return { matched, wouldAffect: Math.min(matched, limit), limit };
    } catch (e) {
        const r = refusalOf(e);
        if (r) return { error: r.error, code: r.code };
        return { error: (e as Error)?.message || 'preview failed' };
    }
}

/** The ceiling, for callers that want to name it (guide, notes). */
export const MAX_BULK_WRITE_ROWS = LIMITS.MAX_BULK_WRITE_ROWS;
