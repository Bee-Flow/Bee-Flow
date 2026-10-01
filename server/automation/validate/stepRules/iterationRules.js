/**
 * Running the same work more than once, or beside itself: the `loop` and its
 * body, the `parallel` and its branches, the per-step `forEach` fan-out any
 * leaf step may carry, and the collection ops (`filter`, `limit`, `dedupe`,
 * `aggregate`, `summarize`) that each take an upstream list as `arrayRef`.
 *
 * The steps INSIDE a body or a branch are validated by the nested walker in
 * validate/graph.js, which calls the same checker again; what is checked here
 * is the container's own shape.
 */

const { parseExpr, TOPIC_HOST_SPEC } = require('../../expr');
const { isObject } = require('../helpers');
const { checkMaxItems } = require('../fieldChecks');
const { SUMMARIZE_OPS, LIMIT_MODES } = require('../constants');

// The step types that may run once per item (`forEach`, and the v2
// `repeat` in mappingRules.js, which runs through the same loop).
// http_request is here because the RUNNER already honours it
// (executeStepWithIteration) and the builder already offers it —
// only this list disagreed, so builder_update_step accepted a field
// builder_finalize then hard-rejected, on precisely the "one API
// call per row" shape the response cache exists for.
// 'datatable' joined 2026-09-04: a write per item of an upstream list (one
// audit row per accepted proposal, one update per matched row) is the
// common case, and a loop body for a single step was the workaround.
// The runner's forEach wrapper is type-agnostic (execution.js
// executeStepWithIteration); a datatable step already runs once per
// item there, so only the validator stood in the way.
// 'knowledge_write' joined with K10, for the same reason
// 'datatable' did: one write per item of an upstream list is the
// ordinary shape ("each resolved ticket → an article").
// 'data_extraction' joined for the shape it exists for: "read every
// file, then pull the same fields out of each" is two flat forEach
// steps, and the second one is this type.
// 'slide' joined with the presentation step: "one slide per row"
// is the shape it exists for, and it is pure — a forEach over it
// costs nothing but the slide objects the deck then collects.
const FOREACH_ALLOWED = new Set(['integration_action', 'ai_step', 'code', 'notification', 'set', 'http_request', 'datatable', 'knowledge_write', 'data_extraction', 'slide']);

function checkLoop(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'loop') {
        if (!step.itemVar || typeof step.itemVar !== 'string') pushE({ code: 'loop.itemVar_missing', severity: 'error', path: at + '.itemVar', message: `Step ${step.id}: loop requires \`itemVar\`.`, hint: 'Choose a short variable name like `item` or `email`.' });
        // `over` (a v2 Source) names the list instead of `overRef`; its own
        // shape is checked in mappingRules.js.
        const hasOver = isObject(step.over);
        if (!hasOver && (!step.overRef || typeof step.overRef !== 'string')) pushE({ code: 'loop.overRef_missing', severity: 'error', path: at + '.overRef', message: `Step ${step.id}: loop requires \`overRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
        if (!Array.isArray(step.body) || step.body.length === 0) {
            pushE({ code: 'loop.body_missing', severity: 'error', path: at + '.body', message: `Step ${step.id}: loop has no body steps.`, hint: 'Add at least one step to run per item, or remove the loop.' });
        }
        // Body items themselves are validated by the nested walker below
        // (id/type shape + the full per-type field rules).
        if (typeof step.maxIterations !== 'number' || step.maxIterations < 1 || step.maxIterations > 1000) {
            pushE({ code: 'loop.max_iterations_range', severity: 'error', path: at + '.maxIterations', message: `Step ${step.id}: loop maxIterations must be 1..1000.`, hint: 'Pick a small integer; 100 is a sensible default.' });
        }
        // Optional (unlike maxIterations above) — omitted defaults to 1 at
        // runtime (execLoop), so every pre-existing loop step (none of
        // which carry batchSize yet) keeps validating clean. Only flag it
        // when EXPLICITLY set to something out of range.
        if (step.batchSize !== undefined && (typeof step.batchSize !== 'number' || step.batchSize < 1 || step.batchSize > 1000)) {
            pushE({ code: 'loop.batch_size_range', severity: 'error', path: at + '.batchSize', message: `Step ${step.id}: loop batchSize must be 1..1000.`, hint: 'Leave it at 1 to process one item at a time, or raise it to process items in batches.' });
        }
    }
}

function checkParallel(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'parallel') {
        // execParallel expects `branches` to be an array of branches, each
        // branch an array of step objects. A malformed branch (non-array,
        // or a step with no/unknown type) crashes runDag at run time — the
        // nested branch is never validated by the main step loop, so check
        // its shape here.
        if (!Array.isArray(step.branches) || step.branches.length === 0) {
            pushE({ code: 'parallel.branches_missing', severity: 'error', path: at + '.branches', message: `Step ${step.id}: parallel needs a non-empty \`branches\` array.`, hint: 'Each branch is an array of steps that run concurrently.' });
        } else {
            step.branches.forEach((branch, bi) => {
                if (!Array.isArray(branch)) pushE({ code: 'parallel.branch_shape', severity: 'error', path: at + `.branches[${bi}]`, message: `Step ${step.id}: parallel branch ${bi} must be an array of steps.`, hint: 'Wrap the branch steps in an array.' });
            });
        }
        // Branch items themselves are validated by the nested walker below
        // (id/type shape + the full per-type field rules).
    }
}

function checkForEach(ctx, step, at) {
    const { pushE } = ctx;
    // Per-step iteration ("run once per item"). A leaf executable step
    // may carry `step.forEach = { overRef, itemVar, maxIterations }` to
    // fan out over an upstream array — the runner runs the step once per
    // element with `loop.<itemVar>` bound (see execForEachStep). Control /
    // container types iterate via their own mechanics, so forEach there is
    // rejected (default-deny allow-list).
    if (step.forEach !== undefined && step.forEach !== null) {
        if (!isObject(step.forEach)) {
            pushE({ code: 'foreach.shape', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: forEach must be an object { overRef, itemVar, maxIterations }.`, hint: 'Remove it, or provide overRef + itemVar.' });
        } else if (!FOREACH_ALLOWED.has(step.type)) {
            pushE({ code: 'foreach.type_unsupported', severity: 'error', path: at + '.forEach', message: `Step ${step.id}: "${step.type}" steps cannot use forEach iteration.`, hint: `Only ${[...FOREACH_ALLOWED].join(' / ')} can run once per item. Use a loop step, or remove forEach.` });
        } else {
            if (!step.forEach.overRef || typeof step.forEach.overRef !== 'string') pushE({ code: 'foreach.overRef_missing', severity: 'error', path: at + '.forEach.overRef', message: `Step ${step.id}: forEach requires \`overRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.results`.' });
            if (!step.forEach.itemVar || typeof step.forEach.itemVar !== 'string') pushE({ code: 'foreach.itemVar_missing', severity: 'error', path: at + '.forEach.itemVar', message: `Step ${step.id}: forEach requires \`itemVar\`.`, hint: 'Choose a short name like `item` or `result`; reference each element as loop.<itemVar>.' });
            if (step.forEach.maxIterations !== undefined && (typeof step.forEach.maxIterations !== 'number' || step.forEach.maxIterations < 1 || step.forEach.maxIterations > 1000)) {
                pushE({ code: 'foreach.max_iterations_range', severity: 'error', path: at + '.forEach.maxIterations', message: `Step ${step.id}: forEach maxIterations must be 1..1000.`, hint: 'Pick a small integer; 100 is a sensible default.' });
            }
        }
    }
}

function checkCollectionOps(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // Phase B: collection ops — every type takes `arrayRef`.
    if (step.type === 'filter' || step.type === 'limit' || step.type === 'dedupe' || step.type === 'aggregate' || step.type === 'summarize') {
        if (!step.arrayRef || typeof step.arrayRef !== 'string') pushE({ code: `${step.type}.arrayRef_missing`, severity: 'error', path: at + '.arrayRef', message: `Step ${step.id}: ${step.type} requires \`arrayRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
        checkMaxItems(step, at, pushE, pushW);
    }
    if (step.type === 'filter') {
        if (!step.expr || typeof step.expr !== 'string') pushE({ code: 'filter.expr_missing', severity: 'error', path: at + '.expr', message: `Step ${step.id}: filter requires \`expr\`.`, hint: 'Use the current element as `item`, e.g. `item.amount > 1000`.' });
        // A filter is a one-output Condition node, so it may ask "is about".
        else { try { parseExpr(step.expr, { host: TOPIC_HOST_SPEC }); } catch (e) { pushE({ code: 'filter.expr_parse', severity: 'error', path: at + '.expr', message: `Step ${step.id}: filter expr parse error — ${e.message}`, hint: 'Restricted grammar only.' }); } }
    }
    if (step.type === 'limit') {
        if (typeof step.count !== 'number' || step.count < 0 || !Number.isFinite(step.count)) pushE({ code: 'limit.count_missing', severity: 'error', path: at + '.count', message: `Step ${step.id}: limit requires non-negative numeric \`count\`.`, hint: '0 returns no items, 10 returns first/last 10.' });
        if (step.mode !== undefined && !LIMIT_MODES.has(step.mode)) pushE({ code: 'limit.mode_invalid', severity: 'error', path: at + '.mode', message: `Step ${step.id}: limit.mode must be "first" or "last".`, hint: 'Default is "first".' });
    }
    // `field` is required — except for summarize op="count", whose
    // executor never reads it (it counts items). Demanding it there
    // rejected a config the runtime handles fine (A7).
    if (step.type === 'aggregate' || (step.type === 'summarize' && step.op !== 'count')) {
        if (!step.field || typeof step.field !== 'string') pushE({ code: `${step.type}.field_missing`, severity: 'error', path: at + '.field', message: `Step ${step.id}: ${step.type} requires \`field\` name to read from each item.`, hint: 'e.g. "amount" or "email".' });
    }
    if (step.type === 'summarize') {
        if (!step.op || !SUMMARIZE_OPS.has(step.op)) pushE({ code: 'summarize.op_invalid', severity: 'error', path: at + '.op', message: `Step ${step.id}: summarize requires \`op\` in ${Array.from(SUMMARIZE_OPS).join('/')}.`, hint: 'Pick the aggregation operator.' });
    }
}

module.exports = { checkLoop, checkParallel, checkForEach, checkCollectionOps, FOREACH_ALLOWED };
