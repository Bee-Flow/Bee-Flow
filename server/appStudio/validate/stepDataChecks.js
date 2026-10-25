// @typecheck
/**
 * App Studio validator — per-kind rules of the file_intake and dataset_query steps and their output vocabularies.
 * Split out of actions.js; the refusals are pinned by actions.validateStep.test.js.
 */

'use strict';

const { isObject, pushDataRef } = require('./shared');

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
        if (!Object.values(step.writeTo.mapping).includes('base_name')) {
            pushE({
                code: 'action.file_intake_no_upsert_key', severity: 'error', path: `${path}.writeTo.mapping`,
                message: 'file_intake writeTo.mapping must map some column to "base_name".',
                hint: 'base_name is the upsert key — without it, re-running the intake duplicates every row.',
            });
        }
    }
    if (step.poPattern !== undefined && typeof step.poPattern === 'string' && step.poPattern) {
        // The pattern runs server-side against attacker-supplied filenames;
        // refuse one that does not even compile rather than failing at run
        // time. (Bounded input: maxLen 200 is enforced by the field spec —
        // but that bounds the PATTERN, not the filenames it scans, so an
        // exponential-backtracking shape is refused too: `(a+)+` against a
        // crafted filename blocks the event loop for every tenant.)
        try { new RegExp(step.poPattern, 'i'); } catch {
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
        if (!step.writeTo.upsertOn) {
            pushW({
                code: 'action.dataset_query_no_upsert', severity: 'warning', path: `${path}.writeTo`,
                message: 'dataset_query writeTo has no upsertOn — re-running the query appends duplicate rows.',
                hint: 'Map a column to "variant_key" and set upsertOn to it so repeats update instead of doubling.',
            });
        }
    }
}

const KIND_CHECKS = {
    file_intake: checkFileIntake,
    dataset_query: checkDatasetQuery,
};

module.exports = { DATASET_QUERY_OUTPUTS, KIND_CHECKS };

/** @typedef {import('./shared').ValidationCtx} ValidationCtx */
