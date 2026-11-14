// @typecheck strict
/**
 * The pure steps of one connector sync (connectorSync.js runs them between
 * its reads and writes): what rides up to the provider, which rows of the
 * answer are the primary table's, which of those are new, what a failure
 * records and what a finished run reports.
 */

'use strict';

const connectorSchema = require('./connectorSchema');
const { renderWatermark } = require('./connectorWatermark.mts');

/** @typedef {{ param?: string | null, format?: string, field?: string }} Incremental */
/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ rows?: unknown, grains?: unknown, partial?: unknown } | null | undefined} ConnectorResult */
/** @typedef {{ rows?: Row[] }} Grain */

/**
 * 'request' tier: the watermark rides UP to the provider, so only what
 * changed is ever fetched.
 * @param {Incremental | null} incremental
 * @param {string | null} priorWatermark
 */
function sinceParams(incremental, priorWatermark) {
    /** @type {Record<string, unknown>} */
    const params = {};
    if (incremental?.param && priorWatermark) {
        const rendered = renderWatermark(priorWatermark, incremental.format);
        if (rendered !== null) params[incremental.param] = rendered;
    }
    return params;
}

/**
 * The since-param is OURS, not the audience's: it is never a declared viewer
 * param, so it rides the systemArgs channel (merged like pinned args, but
 * still below them so an author's pin always wins). A mailbox filters
 * server-side by date rather than through a declared since-param, so it reads
 * the watermark straight off systemArgs. Scoped to that kind so every other
 * connector's systemArgs stays exactly what its author declared.
 * @param {string | undefined} kind
 * @param {Record<string, unknown>} params
 * @param {string | null} priorWatermark
 */
function systemArgsFor(kind, params, priorWatermark) {
    return kind === 'mailbox' && priorWatermark ? { ...params, since: priorWatermark } : params;
}

/**
 * The grains of a traced run, or null when the run carried none.
 * @param {ConnectorResult} result
 * @returns {Grain[] | null}
 */
function grainsOf(result) {
    return Array.isArray(result?.grains) ? result.grains : null;
}

/**
 * The primary table stores grain 0 (the source list), not the flattened
 * output — those differ the moment a step expands.
 * @param {ConnectorResult} result
 * @param {Grain[] | null} grains
 * @param {number} maxRows
 * @returns {Row[]}
 */
function primaryRowsOf(result, grains, maxRows) {
    const primaryRows = grains ? (grains[0]?.rows || []) : (result?.rows || []);
    return Array.isArray(primaryRows) ? primaryRows.slice(0, maxRows) : [];
}

/**
 * 'client' tier: everything came back, but only newer rows are written.
 * Not with child tables: their `_parentIndex` points into grain 0 as it came back, so a
 * shorter parent list linked a skipped conversation's messages to its neighbour instead.
 * Not for a mailbox either: it already narrowed server-side (systemArgs.since, on the
 * MODIFIED time), and an old message labelled later has a received_at below the watermark.
 * @param {Row[]} rows
 * @param {{ incremental: Incremental | null, priorWatermark: string | null, hasChildren: boolean, kind: string | undefined }} tier
 * @returns {{ rows: Row[], skipped: number }}
 */
function newerRowsOnly(rows, { incremental, priorWatermark, hasChildren, kind }) {
    const field = incremental?.field;
    if (!field || incremental.param || !priorWatermark || hasChildren || kind === 'mailbox') return { rows, skipped: 0 };
    const newer = rows.filter((row) => {
        const iso = connectorSchema.toIsoStamp(connectorSchema.readPath(row, field));
        return !iso || iso > priorWatermark;
    });
    return { rows: newer, skipped: rows.length - newer.length };
}

/**
 * What a failed run records: the streak, a provider's Retry-After and the
 * message, kept so the editor can show WHY.
 * @param {{ consecutiveErrors?: unknown } | null | undefined} claim
 * @param {{ retryAfterMs?: number, message?: string } | null | undefined} err  whatever the run threw
 */
function failureState(claim, err) {
    const priorErrors = Number.isInteger(claim?.consecutiveErrors) ? /** @type {number} */ (claim?.consecutiveErrors) : 0;
    return { consecutiveErrors: priorErrors + 1, retryAfterMs: err?.retryAfterMs || 0, error: err?.message || String(err) };
}

/**
 * What a finished run reports. The optional parts appear only when they say something.
 * @param {{ inserted: number, updated: number, skipped: number, rowCount: number, purged: number, hook: unknown,
 *   watermark: string | null, nextRunAt: string, reason: string, durationMs: number,
 *   childResults: Array<{ tableId: unknown, table: string, inserted: number, updated: number }>, partial: unknown }} run
 */
function syncSummary({ inserted, updated, skipped, rowCount, purged, hook, watermark, nextRunAt, reason, durationMs, childResults, partial }) {
    return {
        inserted, updated, skipped, rows: rowCount, rowsWritten: inserted + updated,
        ...(purged ? { purged } : {}),
        ...(hook ? { hook } : {}),
        watermark, nextRunAt, reason,
        durationMs,
        ...(childResults.length ? { children: childResults } : {}),
        ...(partial ? { partial: true } : {}),
    };
}

module.exports = { sinceParams, systemArgsFor, grainsOf, primaryRowsOf, newerRowsOnly, failureState, syncSummary };
