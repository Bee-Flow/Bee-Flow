/**
 * builder_update_step on a datatable step: the add path's foreign vocabulary
 * translated before the allow-list, the fill-only table link, and the
 * values / where / sort / cursor canonicalisation against the catalog table.
 * Moved out of applyUpdateStep (stepEditing.js); the bodies are verbatim,
 * an early `return X` became `return { refusal: X }` where the caller also
 * needs a value back.
 */

const { sanitizeForEach } = require('../../bindings');
const { approvalGateError } = require('../../datatableApproval');
const {
    translateDatatableVocabulary, resolveDatatableOp, resolveDatatableRef, mapColumnKeys,
} = require('../../datatableRefs');
const {
    sanitizeDatatableBindings, DATATABLE_WRITE_OPS, readOnlyTableError,
    resolveDatatableColumns, checkExtractionFieldRefs,
} = require('../../stepBuilders/datatableStep');

/**
 * The datatable translation: { refusal } or { patch } (the translated one).
 * @param {string[]} patchNotes
 */
function translateDatatablePatch(step, patch, patchNotes) {
    if (step.type === 'datatable') {
        const tr = translateDatatableVocabulary(patch);
        if (tr.error) return { refusal: tr };
        patch = tr.args;
        patchNotes.push(...tr.notes);
        if ('op' in patch) {
            const r = resolveDatatableOp(patch.op, { hasValues: true });
            if (r.error) return { refusal: r };
            patch.op = r.op;
            if (r.note) patchNotes.push(r.note);
        }
    }
    return { patch };
}

/**
 * The fill-only table link: { refusal } or { filledTable } (null when nothing was filled).
 * @param {string[]} patchNotes
 */
function linkDatatablePatch(stepId, step, patch, draftWrap, patchNotes) {
    // FILL-ONLY: a datatable step that already names a table keeps it. The
    // patch exists so an IMPORTED step — whose id export deliberately blanked —
    // can be linked to a table here; re-pointing a bound step is a different
    // act with a different blast radius (the rows of another organisation's
    // table), and it stays where it was. The id is never trusted on its own
    // either: execDatatable resolves it inside the automation's own scopes and
    // fails closed, so a patched id can name nothing outside them.
    //
    // With a catalog the patch is RESOLVED first (id, key, name — the same
    // ladder the add path climbs), because the refusal compared strings: a
    // patch of `{datatableId:"Facturen"}` on a step already linked to that
    // very table was refused as a re-point, and the model's next move was to
    // remove + re-add the step. The same table is a no-op and says so; a blank
    // step is filled with both id and key; a different table is the refusal.
    /** @type {Builder.CatalogTable | null} */
    let filledTable = null;
    if (step.type === 'datatable' && ('datatableId' in patch || 'datatableKey' in patch)) {
        const linked = (typeof step.datatableId === 'string' && step.datatableId) ? step.datatableId : null;
        const ref = resolveDatatableRef({ id: patch.datatableId, key: patch.datatableKey, datatables: draftWrap?._datatables });
        if (ref.error) return { refusal: ref };
        if (ref.table) {
            patchNotes.push(...ref.notes);
            if (linked && ref.table.id === linked) {
                delete patch.datatableId;
                delete patch.datatableKey;
                patchNotes.push(`datatableId already is ${linked} (${ref.table.key}, "${ref.table.name}") — nothing to change there.`);
            } else if (!linked) {
                const deny = approvalGateError(ref.table, draftWrap, { op: patch.op || step.op });
                if (deny) return { refusal: deny };
                patch.datatableId = ref.table.id;
                patch.datatableKey = ref.table.key;
                filledTable = ref.table;
            } else {
                return { refusal: { error: `Step "${stepId}" already uses datatable "${step.datatableId}". Pointing a step at a different table is not a patch — use builder_replace_step, or leave it to the person who owns the data.` } };
            }
        } else if ('datatableId' in patch && linked && String(patch.datatableId || '').trim() !== linked) {
            return { refusal: { error: `Step "${stepId}" already uses datatable "${step.datatableId}". Pointing a step at a different table is not a patch — use builder_replace_step, or leave it to the person who owns the data.` } };
        }
    }
    return { filledTable };
}

/** values / where / sort / matchColumn / forEach of a datatable patch onto `next`: a refusal, or null. */
function patchDatatableBody(graph, step, patch, next, { filledTable, draftWrap, inputsMode, patchNotes }) {
    // A datatable's bindings live in `values` and `where[].value`, so the
    // bindKey pass below — hard-coded to 'fields' or 'inputs' — never saw them
    // and a patched "{{steps.x.output.y}}" was stored as literal text. Same
    // sanitizer the add tool uses, over the MERGED step so patching one column
    // does not re-canonicalize the others out of existence.
    if (step.type === 'datatable') {
        // The catalog table the step is on once this patch lands: filled just
        // above, or the one it already had — by EXACT id only; a step whose id
        // the catalog does not know is left as it is (an import that has not
        // been re-linked yet), never re-checked against a table it may not
        // mean. null = no catalog or no match → the column checks are skipped.
        const tableId = filledTable ? filledTable.id : step.datatableId;
        const table = filledTable || ((Array.isArray(draftWrap?._datatables) && typeof tableId === 'string' && tableId)
            ? (draftWrap._datatables.find((/** @type {{ id: string; }} */ t) => t && t.id === tableId) || null)
            : null);
        const opAfter = ('op' in patch) ? patch.op : step.op;
        // The add path refuses a write on a table this user can only read; a
        // patch that turns a read into a write, or links a write to such a
        // table, is the same run-time failure by another door.
        if (table && ('op' in patch || filledTable) && DATATABLE_WRITE_OPS.has(opAfter) && !table.canWrite) {
            return readOnlyTableError(table, opAfter);
        }
        if ('values' in patch || 'where' in patch) {
            // Only what the patch sends is canonicalised and checked; the
            // columns it leaves alone are the author's and stay byte-identical
            // (a broken one is the validator's report, never a reason to
            // refuse an unrelated patch).
            const merged = { values: {}, where: [] };
            let patchValues = null;
            if ('values' in patch) {
                let raw = (patch.values && typeof patch.values === 'object' && !Array.isArray(patch.values)) ? patch.values : {};
                // The PATCH keys are mapped before the merge, not the merged
                // map after it: a patch of {"Excl. btw": …} onto a step that
                // already writes excl_btw would otherwise collapse two keys
                // onto one column and be refused for the model's own title.
                // Without a catalog this only refuses one binding for the
                // whole row (mapColumnKeys passes everything else through).
                const m = mapColumnKeys(raw, table ? table.columns : null, { tableName: table ? table.name : undefined });
                if (m.error) return m;
                patchNotes.push(...m.notes);
                raw = m.map;
                patchValues = raw;
                merged.values = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null));
            }
            // `where` is a LIST — merging by index would silently keep a condition
            // the author meant to drop, so it is replaced wholesale like
            // set.operations and parse_json.fields. The column-keyed object form
            // is handed to sanitizeDatatableBindings as-is: it translates that
            // shape and reports the translation. Emptying it here instead is
            // what made a patch carrying the object form a no-op — the step kept
            // its old `where`, the result said "already had exactly these
            // values", and the model re-sent the same patch (measured, four
            // rounds running, 2026-09-16).
            if ('where' in patch) merged.where = patch.where;
            const bound = sanitizeDatatableBindings(merged, graph, draftWrap);
            if (bound.error) return { error: bound.error };
            patchNotes.push(...bound.repairs);
            if (patchValues) {
                if (inputsMode === 'replace') next.values = bound.values;
                else {
                    const mm = { ...(step.values || {}) };
                    for (const [k, v] of Object.entries(patchValues)) { if (v === null) delete mm[k]; else mm[k] = bound.values[k]; }
                    next.values = mm;
                }
            }
            if ('where' in patch) next.where = bound.where;
        }
        if (table) {
            // Only what the patch touched: a stale column on a field the patch
            // leaves alone is the validator's report, not a reason to refuse a
            // label change.
            const cols = resolveDatatableColumns({
                op: opAfter,
                where: ('where' in patch) ? next.where : undefined,
                sort: ('sort' in patch) ? patch.sort : undefined,
                matchColumn: ('matchColumn' in patch) ? patch.matchColumn : undefined,
            }, table);
            if (cols.error) return cols;
            patchNotes.push(...cols.notes);
            if ('where' in patch) next.where = cols.where;
            if ('sort' in patch) patch.sort = cols.sort;
            if ('matchColumn' in patch) patch.matchColumn = cols.matchColumn;
        }
        if ('values' in patch || 'forEach' in patch) {
            // The same declared-field check the add path runs, against the
            // forEach the step will have once this patch lands (an invalid one
            // is left for the forEach block below to refuse).
            const fe = 'forEach' in patch
                ? (patch.forEach === null ? undefined : sanitizeForEach(patch.forEach, graph, draftWrap).forEach)
                : step.forEach;
            if (fe) {
                const ex = checkExtractionFieldRefs(graph, next.values, fe, draftWrap);
                if (ex.error) return ex;
                next.values = ex.values;
                patchNotes.push(...ex.notes);
            }
        }
    }
    return null;
}

module.exports = { translateDatatablePatch, linkDatatablePatch, patchDatatableBody };

/** @typedef {import('../../pendingDatatables').DraftWrap} DraftWrap */

/** @typedef {import('../../pendingDatatables').DatatableCatalogEntry} DatatableCatalogEntry */

/** @typedef {import('../../draftGraph').DraftGraph} DraftGraph */
