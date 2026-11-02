/**
 * forEachFailure.mts: what a "run once per item" step (execFlow.execForEachStep)
 * keeps of an item that failed, and the error it throws when EVERY item failed.
 *
 * A failed item keeps the step's own `stepErrorCode` when it had one (the
 * runner's permission gate, an http_request that knows its URL is wrong), and
 * the all-failed error carries the code of the item its message quotes. The
 * step's error card (utils/stepErrorInfo.js) otherwise rebuilds the cause
 * from the text alone, and a permission refusal on a Nextcloud step read as a
 * Nextcloud app switched off (BFSF-490).
 */

export interface ItemError {
    message: string;
    stepErrorCode?: unknown;
}

export interface FailedItemRow {
    index: number;
    item: unknown;
    output: null;
    error: string;
    errorClass: string;
    attempts: number;
    status: 'error';
    stepErrorCode?: string;
}

export interface AllItemsFailedError extends Error {
    errorClass: 'foreach_all_failed';
    foreachHandled: true;
    foreachResults: ReadonlyArray<unknown>;
    stepErrorCode?: string;
}

/**
 * The result row of a failed item. `output: null` keeps the slot:
 * `results[*].output` stays as long as `results[*].item` and lines up with it.
 * Without the key the [*] walk skipped the failed item and every later output
 * moved one row up against its item.
 */
export function failedItemRow(row: { index: number; item: unknown; err: ItemError; errorClass: string; attempts: number }): FailedItemRow {
    const { index, item, err, errorClass, attempts } = row;
    return {
        index, item, output: null, error: err.message, errorClass, attempts, status: 'error',
        ...(typeof err.stepErrorCode === 'string' ? { stepErrorCode: err.stepErrorCode } : {}),
    };
}

/**
 * §WS2.5: a fan-out where every item failed is a real step failure, not a
 * green 'success'. `foreachHandled` tells the outer dispatch retry loop NOT
 * to re-run the whole fan-out: per-item retry already ran.
 */
export function allItemsFailedError(results: ReadonlyArray<{ error?: string; stepErrorCode?: string } | undefined>): AllItemsFailedError {
    const first = results[0];
    const err = new Error(`All ${results.length} forEach iteration(s) failed (e.g. "${first?.error || 'unknown error'}").`) as AllItemsFailedError;
    err.errorClass = 'foreach_all_failed';
    err.foreachHandled = true;
    err.foreachResults = results;
    if (first?.stepErrorCode) err.stepErrorCode = first.stepErrorCode;
    return err;
}
