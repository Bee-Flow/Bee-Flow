/**
 * Which steps are BULK writes (package 5): an update_record / delete_record with a `filter`
 * (up to LIMITS.MAX_BULK_WRITE_ROWS rows in one step), or a writeTo with `replaceWhere` (deletes
 * a filtered set before it writes). One click on such a step can change hundreds of rows, so the
 * step routes charge it to the per-run budget (actionRunLimiter) like the other heavy steps; a
 * one-row write stays on the plain step budget.
 *
 * Pure, so the routes and the walkers can ask it without loading the executor.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isBulkWriteStep(step: unknown): boolean {
    if (!isObj(step)) return false;
    if ((step.kind === 'update_record' || step.kind === 'delete_record') && step.filter !== undefined && step.filter !== null) return true;
    const writeTo = step.writeTo;
    return isObj(writeTo) && writeTo.replaceWhere !== undefined && writeTo.replaceWhere !== null;
}
