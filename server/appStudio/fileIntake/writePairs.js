// @typecheck
/**
 * file_intake phase 4 — upsert one row per pair, as the viewer under RLS.
 */

'use strict';
const { hasField } = require('./attachmentRows');

// Required by a variable path (see actionExecutor/dispatch.js).
const WRITE_TO_ROWS = '../actionExecutor/writeToRows.mts';

/**
 * Resolve writeTo.constants ({ col: binding }) to literal values, keeping only
 * columns that exist on the target table. Resolved ONCE for the whole batch —
 * provenance cannot vary between rows of the same intake.
 */
function resolveConstants(constants, table, ctx, scope, resolveBinding) {
    const out = {};
    if (!constants || typeof constants !== 'object') return out;
    for (const [col, binding] of Object.entries(constants)) {
        if (!hasField(table, col)) continue;
        out[col] = resolveBinding(binding, ctx, scope);
    }
    return out;
}

/**
 * The explicit writeTo.upsertKey (package 5) or the implicit base_name key, and writeTo.replaceWhere:
 * checked (strict, under the limit) before anything is written, then the matching rows go first.
 * Not atomic with the per-pair upserts (documented). Returns `{ upsert }` (the explicit key or
 * null) or the refusal.
 * @param {{ id: string, userId: string, organizationId?: string | null }} app
 * @param {{ key: string, id?: string, fields?: Record<string, unknown>[] }} table
 * @param {Record<string, any>} writeTo
 * @param {{ constants: Record<string, any>, baseCol: string | null, run: { ctx: any, viewer: any, resolveValue: (b: any) => any } }} opts
 * @returns {Promise<{ ok: false, error: string, code?: string } | { ok: true, upsert: any }>}
 */
async function prepareKeyAndReplace(app, table, writeTo, { constants, baseCol, run }) {
    const writeToRows = require(WRITE_TO_ROWS);
    const upsert = Array.isArray(writeTo.upsertKey) && writeTo.upsertKey.length
        ? writeToRows.upsertKeyOf(writeTo, table, constants)
        : null;
    if (!upsert && (!baseCol || !hasField(table, baseCol))) {
        return { ok: false, error: 'writeTo.mapping must map a column to base_name' };
    }
    if (writeTo.replaceWhere !== undefined && writeTo.replaceWhere !== null) {
        const prepared = await writeToRows.prepareReplace(app, table, writeTo.replaceWhere, run);
        if (writeToRows.isRefusal(prepared)) return prepared;
        await writeToRows.replaceBefore(app, table, prepared.filters, run);
    }
    return { ok: true, upsert };
}

/** Returns `{ written }`, or the `{ ok: false, error }` that ends the step. */
async function writePairs(app, model, step, pairs, {
    ctx, scope, viewer, resolveBinding, findTable, writeRecord, writeViewer, stepDataSource,
}) {
    // ── 4. Upsert one row per pair, as the viewer ───────────────────────
    let written = 0;
    if (step.writeTo && typeof step.writeTo === 'object' && step.writeTo.tableId && pairs.length) {
        const table = findTable(model, step.writeTo.tableId);
        if (!table) return { ok: false, error: 'The table to write pairs to was not found' };
        const mapping = (step.writeTo.mapping && typeof step.writeTo.mapping === 'object') ? step.writeTo.mapping : {};
        const constants = resolveConstants(step.writeTo.constants, table, ctx, scope, resolveBinding);

        // The mapped base_name column is the upsert key (validate.js makes it
        // required unless writeTo.upsertKey names the key); the scalar constants
        // narrow the match so two orders never collide on the same part number.
        const baseCol = Object.entries(mapping).find(([, out]) => out === 'base_name')?.[0] || null;
        const writeToRows = require(WRITE_TO_ROWS);
        const run = { ctx, viewer, resolveValue: (/** @type {unknown} */ b) => resolveBinding(b, ctx, scope) };
        const prep = await prepareKeyAndReplace(app, table, step.writeTo, { constants, baseCol, run });
        if (prep.ok === false) return prep;
        const explicitKey = prep.upsert;

        const outputsFor = (pair) => ({
            base_name: pair.baseName,
            cad_name: pair.cadName,
            cad_file: pair.cadFile,
            drawing_name: pair.drawingName,
            drawing_file: pair.drawingFile,
            role: pair.role,
            file_name: pair.cadName || pair.drawingName,
            // The spelling both sides of the order agree on, so an extraction
            // reading the bill of materials can upsert onto the right line.
            part_key: pair.partKey,
            // 'afschuining', 'tappen' — what still has to happen to the plate.
            operation: pair.operation || null,
            folder: pair.folder || null,
            // What this line did NOT take, so a second cutting file is visible
            // on the line rather than only in the attachments list.
            extra_cad: pair.extraCad && pair.extraCad.length ? pair.extraCad.join(', ') : null,
            // 'exact' | 'fuzzy' | 'geen' — how the drawing↔CAD pairing was
            // made. Fuzzy is a flag for the human, never a silent success.
            match_status: pair.matchStatus,
        });

        for (const pair of pairs) {
            const outputs = outputsFor(pair);
            const values = {};
            for (const [col, out] of Object.entries(mapping)) {
                if (!hasField(table, col)) continue;
                values[col] = Object.prototype.hasOwnProperty.call(outputs, out) ? outputs[out] : null;
            }
            // Constants last — provenance wins over anything mapped onto the
            // same column, exactly as ai_extract's writeTo does.
            Object.assign(values, constants);

            // Existing row for this (base name + scalar constants)? With an explicit
            // upsertKey: exactly those columns (an empty one means no identity: insert).
            if (explicitKey) {
                const keyFilter = writeToRows.keyFilterOf(explicitKey, values);
                const twin = keyFilter ? await writeToRows.findExistingByKey(app, model, table, keyFilter, run) : null;
                const saved = await writeRecord(app, model, table, values, {
                    viewer: writeViewer(ctx), recordId: twin && twin.id ? twin.id : undefined,
                });
                pair.recordId = (saved && (saved.id || saved.recordId)) || (twin && twin.id) || null;
                written += 1;
                continue;
            }
            /** @type {Array<{field: string, op: string, value: any, required?: boolean}>} */
            const matchFilter = [{ field: /** @type {string} */ (baseCol), op: 'eq', value: pair.baseName, required: true }];
            for (const [col, v] of Object.entries(constants)) {
                // Date/datetime constants are stamps, not identity: a
                // `toegevoegd_op: now` resolves fresh on every press, so
                // matching on it would never find the first run's rows and
                // the second press would duplicate every pair — the exact
                // failure the upsert exists to prevent.
                const field = (table.fields || []).find((f) => f && f.key === col);
                if (field && (field.type === 'date' || field.type === 'datetime')) continue;
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    matchFilter.push({ field: col, op: 'eq', value: v });
                }
            }
            const existing = await stepDataSource.resolveDataBinding(app, model, {
                kind: 'record', tableId: table.id, filter: matchFilter,
            }, {
                viewer,
                role: ctx.role ?? null,
                resolveValue: (b) => resolveBinding(b, ctx, scope),
            });

            // Upsert semantics: a re-run refreshes the descriptors and the
            // pairing but must never clobber columns the mapping does not own
            // (someone's manual edits on the line survive the second press).
            const saved = await writeRecord(app, model, table, values, {
                viewer: writeViewer(ctx),
                recordId: existing && existing.id ? existing.id : undefined,
            });

            // Hand the row id BACK to the caller on the pair. Everything an
            // action wants to do per document afterwards — read the drawing,
            // write the result onto its line — needs to address that line, and
            // a pair that only carries file descriptors cannot say which row it
            // became. Without this, an action looping over `pairs` and guarding
            // on `paar.recordId` silently ran zero iterations: the lines were
            // created and paired, and every extracted column stayed empty.
            pair.recordId = (saved && (saved.id || saved.recordId))
                || (existing && existing.id)
                || null;
            written += 1;
        }
    }
    return { written };
}

module.exports = { resolveConstants, writePairs };
