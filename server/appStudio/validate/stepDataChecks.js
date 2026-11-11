// @typecheck
/**
 * App Studio validator — per-kind rules of the file_intake and dataset_query steps and their output vocabularies.
 * Split out of actions.js; the refusals are pinned by actions.validateStep.test.js.
 */

'use strict';

const { isObject, pushDataRef } = require('./shared');
const { LIMITS } = require('../componentSpecs/limits');
const { countFilterLeaves } = require('../../shared/expr/filterGroups.mjs');

// The fixed output vocabulary of file_intake — what writeTo.mapping values may
// name (where ai_extract maps to its declared schema fields instead).
const FILE_INTAKE_OUTPUTS = [
    'base_name', 'cad_name', 'cad_file', 'drawing_name', 'drawing_file', 'role', 'file_name', 'match_status',
    // What the FOLDER knew and a filename could not say: the part number both
    // sides of an order can be joined on, the machining the folder asked for,
    // where the files came out of, and the cutting files this line did not take.
    'part_key', 'operation', 'folder', 'extra_cad',
];

// The fixed output vocabulary of dataset_query rows. `variant_key` is the
// synthesized "chrom:pos:ref>alt" identity — the natural upsert key, since a
// re-queried variant is the same variant. `info` is the parsed INFO object
// serialized as JSON text.
const DATASET_QUERY_OUTPUTS = [
    'chrom', 'pos', 'id', 'ref', 'alt', 'qual', 'filter', 'info', 'variant_key', 'gene', 'region',
];

function checkFileIntake(step, path, ctx) {
    const { pushE } = ctx;
    if (ctx.dataMailboxConnectors && typeof step.connectorId === 'string' && !ctx.dataMailboxConnectors.has(step.connectorId)) {
        const known = Array.from(ctx.dataMailboxConnectors);
        pushDataRef(ctx, {
            code: 'action.file_intake_connector_invalid', severity: 'error', path: `${path}.connectorId`,
            message: `Step "file_intake" references ${JSON.stringify(step.connectorId)}, which is not a mailbox connector.`,
            hint: known.length ? `Mailbox connectors in this app: ${known.join(', ')}.` : 'Add a mailbox connector in the Data tab first.',
        });
    }
    if (isObject(step.writeTo) && isObject(step.writeTo.mapping)) {
        // mapping values name the step's FIXED outputs (there is no
        // authored schema here, unlike ai_extract).
        for (const [col, out] of Object.entries(step.writeTo.mapping)) {
            if (typeof out === 'string' && out && !FILE_INTAKE_OUTPUTS.includes(out)) {
                pushE({
                    code: 'action.file_intake_output_unknown', severity: 'error', path: `${path}.writeTo.mapping.${col}`,
                    message: `file_intake has no output named ${JSON.stringify(out)}.`,
                    hint: `Outputs: ${FILE_INTAKE_OUTPUTS.join(', ')}.`,
                });
            }
        }
        // The upsert matches on the mapped base_name column. Without it,
        // every press of the button appends a duplicate row per pair.
        const explicitKey = Array.isArray(step.writeTo.upsertKey) && step.writeTo.upsertKey.length > 0;
        if (!explicitKey && !Object.values(step.writeTo.mapping).includes('base_name')) {
            pushE({
                code: 'action.file_intake_no_upsert_key', severity: 'error', path: `${path}.writeTo.mapping`,
                message: 'file_intake writeTo.mapping must map some column to "base_name".',
                hint: 'base_name is the upsert key — without it, re-running the intake duplicates every row.',
            });
        }
    }
    if (step.poPattern !== undefined && typeof step.poPattern === 'string' && step.poPattern) {
        // The pattern runs server-side against sender-supplied filenames and
        // compiles through core/text/userPattern at run time; refuse here what
        // that compiler refuses (does not compile), and a nested quantifier
        // such as `(a+)+` as before.
        const { compileUserPattern } = require('../../core/text/userPattern');
        const compiled = compileUserPattern(step.poPattern, { caseInsensitive: true });
        if (compiled.ok === false && 'reason' in compiled && compiled.reason === 'does_not_compile') {
            pushE({ code: 'action.file_intake_pattern_invalid', severity: 'error', path: `${path}.poPattern`, message: 'poPattern is not a valid regular expression.', hint: 'Fix the pattern or remove it to use the default.' });
        }
        const { hasNestedQuantifier } = require('../safePattern');
        if (hasNestedQuantifier(step.poPattern)) {
            pushE({
                code: 'action.file_intake_pattern_unsafe', severity: 'error', path: `${path}.poPattern`,
                message: 'poPattern nests a quantifier inside a quantified group (like (a+)+), which can hang the server on crafted filenames.',
                hint: 'Rewrite without a quantifier inside a quantified group, or remove it to use the default.',
            });
        }
    }
}

function checkDatasetQuery(step, path, ctx) {
    const { pushE, pushW } = ctx;
    // The slice selector is EXACTLY one of gene | region | rsid. Zero would
    // ask for the whole file (the thing this step exists to never do); two
    // is ambiguous. queryRegion enforces the same rule at run time.
    //
    // Only a selector whose value is decidable HERE can be counted. The
    // obvious search UI is one form with three optional fields — gene OR
    // region OR rsID — wired to one step, and every field is a formula
    // reading form.<name>. Counting those as "set" made that UI
    // unbuildable and pushed authors towards three near-identical actions.
    // So: literals are checked statically, formulas are left to the run
    // time, which knows what the viewer actually typed.
    const present = ['gene', 'region', 'rsid'].filter((f) => step[f] !== undefined && step[f] !== null);
    const isDecidable = (/** @type {{ kind: string; }} */ v) => typeof v === 'string'
        || (isObject(v) && v.kind === 'static');
    const literal = present.filter((f) => {
        const v = step[f];
        if (typeof v === 'string') return v.trim() !== '';
        return isObject(v) && v.kind === 'static' && v.value !== null && v.value !== undefined && String(v.value).trim() !== '';
    });
    const dynamic = present.filter((f) => !isDecidable(step[f]));

    if (present.length === 0) {
        pushE({
            code: 'action.dataset_query_selector', severity: 'error', path,
            message: 'Step "dataset_query" needs a slice selector: set gene, region or rsid.',
            hint: 'gene ("BRCA1"), region ("chr17:43044295-43125364") or rsid ("rs1801133") — one of the three.',
        });
    } else if (literal.length > 1) {
        pushE({
            code: 'action.dataset_query_selector', severity: 'error', path,
            message: `Step "dataset_query" sets ${literal.join(' and ')} to fixed values — exactly one selector is allowed.`,
            hint: 'gene ("BRCA1"), region ("chr17:43044295-43125364") or rsid ("rs1801133") — one of the three.',
        });
    } else if (literal.length === 1 && dynamic.length) {
        // A fixed selector next to a variable one: the fixed one is always
        // present, so the step either ignores what the viewer typed or
        // fails arity at run time. Neither is what the author meant.
        pushW({
            code: 'action.dataset_query_mixed_selector', severity: 'warning', path,
            message: `Step "dataset_query" combines a fixed ${literal[0]} with ${dynamic.join(' and ')} from the form — the fixed one is always set, so this errors whenever the viewer fills a field.`,
            hint: 'Make every selector come from the form, or drop the extra ones and keep the fixed selector alone.',
        });
    }
    if (isObject(step.writeTo) && isObject(step.writeTo.mapping)) {
        for (const [col, out] of Object.entries(step.writeTo.mapping)) {
            if (typeof out === 'string' && out && !DATASET_QUERY_OUTPUTS.includes(out)) {
                pushE({
                    code: 'action.dataset_query_output_unknown', severity: 'error', path: `${path}.writeTo.mapping.${col}`,
                    message: `dataset_query has no output named ${JSON.stringify(out)}.`,
                    hint: `Outputs: ${DATASET_QUERY_OUTPUTS.join(', ')}.`,
                });
            }
        }
        if (!step.writeTo.upsertOn && !(Array.isArray(step.writeTo.upsertKey) && step.writeTo.upsertKey.length)) {
            pushW({
                code: 'action.dataset_query_no_upsert', severity: 'warning', path: `${path}.writeTo`,
                message: 'dataset_query writeTo has no upsertOn — re-running the query appends duplicate rows.',
                hint: 'Map a column to "variant_key" and set upsertOn to it so repeats update instead of doubling.',
            });
        }
    }
}

/**
 * update_record / delete_record address ONE row (`recordId`) or every row matching a `filter`
 * (package 5): exactly one of the two. A filter is a non-empty clause list (an empty one would
 * mean every row), at most LIMITS.MAX_WRITE_FILTER_CLAUSES, in the records-binding grammar.
 * @param {Record<string, any>} step
 * @param {string} path
 */
function checkRecordTarget(step, path, ctx) {
    const { pushE } = ctx;
    const hasId = step.recordId !== undefined && step.recordId !== null;
    const hasFilter = step.filter !== undefined && step.filter !== null;
    const label = `Step "${step.kind}"`;
    if (!hasId && !hasFilter) {
        pushE({ code: 'action.step_field_required', severity: 'error', path: `${path}.recordId`, message: `${label} is missing required \`recordId\`.`, hint: 'Provide a binding for one row, or a `filter` (clause list) plus an optional `limit` for many rows.' });
        return;
    }
    if (hasId && hasFilter) {
        pushE({ code: 'action.record_target_ambiguous', severity: 'error', path: `${path}.filter`, message: `${label} has both \`recordId\` and \`filter\`.`, hint: 'Use recordId for one row or filter for many rows, not both.' });
        return;
    }
    if (!hasFilter) {
        if (step.limit !== undefined) pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}.limit`, message: `${label} has a \`limit\` but no \`filter\`.`, hint: 'limit only applies to a filter; remove it.' });
        return;
    }
    checkWriteFilter(step.filter, `${path}.filter`, step.tableId, ctx, label);
    if (step.kind === 'update_record' && step.expectedUpdatedAt !== undefined) {
        pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}.expectedUpdatedAt`, message: `${label} with a \`filter\` cannot carry \`expectedUpdatedAt\`.`, hint: 'The compare-and-set token belongs to one row; remove it or use recordId.' });
    }
}

/**
 * A write filter clause list (filter-mode record step, writeTo.replaceWhere).
 * @param {unknown} filter
 * @param {string} at
 * @param {unknown} tableId
 * @param {string} label
 */
function checkWriteFilter(filter, at, tableId, ctx, label) {
    const { pushE } = ctx;
    if (typeof filter === 'string' || !Array.isArray(filter)) {
        pushE({ code: 'binding.filter_invalid', severity: 'error', path: at, message: `${label} filter must be a list of { field, op, value? } clauses (a formula string cannot run on the server).`, hint: 'Write [{ field: "status", op: "eq", value: "done" }].' });
        return;
    }
    if (!filter.length) {
        pushE({ code: 'action.bulk_filter_empty', severity: 'error', path: at, message: `${label} has an empty filter, which would change every row.`, hint: 'Add at least one clause, e.g. { field: "status", op: "eq", value: "done" }.' });
        return;
    }
    // Clauses inside { any: [...] } groups count too (package 6).
    const leaves = countFilterLeaves(filter);
    if (leaves > LIMITS.MAX_WRITE_FILTER_CLAUSES) {
        pushE({ code: 'action.bulk_filter_too_large', severity: 'error', path: at, message: `${label} filter has ${leaves} clauses (limit ${LIMITS.MAX_WRITE_FILTER_CLAUSES}, counting the clauses inside any groups).`, hint: 'Narrow it with fewer clauses (use op "in" for a list of values).' });
        return;
    }
    require('./bindings').validateBindingFilter(filter, at, ctx, tableId, label);
}

const KIND_CHECKS = {
    file_intake: checkFileIntake,
    dataset_query: checkDatasetQuery,
    update_record: checkRecordTarget,
    delete_record: checkRecordTarget,
};

module.exports = { DATASET_QUERY_OUTPUTS, FILE_INTAKE_OUTPUTS, KIND_CHECKS, checkWriteFilter };

/** @typedef {import('./shared').ValidationCtx} ValidationCtx */
