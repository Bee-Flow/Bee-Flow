/**
 * file_intake phase 4 — upsert one row per pair, as the viewer under RLS.
 */

'use strict';
const { hasField } = require('./attachmentRows');

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
        // required); the scalar constants narrow the match so two orders never
        // collide on the same part number.
        const baseCol = Object.entries(mapping).find(([, out]) => out === 'base_name')?.[0] || null;
        if (!baseCol || !hasField(table, baseCol)) {
            return { ok: false, error: 'writeTo.mapping must map a column to base_name' };
        }

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

            // Existing row for this (base name + scalar constants)?
            const matchFilter = [{ field: baseCol, op: 'eq', value: pair.baseName, required: true }];
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
