/**
 * Running the same work more than once, or beside itself: the `loop` and its
 * body, the `parallel` and its branches, the per-step `forEach` fan-out any
 * leaf step may carry, and the collection ops (`filter`, `limit`, `dedupe`,
 * `aggregate`, `summarize`, and `flatten` in flattenRules.js) that each take an upstream list as `arrayRef`.
 *
 * The steps INSIDE a body or a branch are validated by the nested walker in
 * validate/graph.js, which calls the same checker again; what is checked here
 * is the container's own shape.
 */

const { parseExpr, TOPIC_HOST_SPEC, parsePath, formatPath } = require('../../expr');
const { isObject, collectRefPaths } = require('../helpers');
const { fieldsAtRef, checkLoopRef, itemFieldsOf, topLevelFieldsOf } = require('../../builderTools/outputFields');
const { checkMaxItems } = require('../fieldChecks');
const { SUMMARIZE_OPS, LIMIT_MODES } = require('../constants');
const { checkFlatten } = require('./flattenRules');

function checkLoop(ctx, step, at) {
    const { pushE } = ctx;
    if (step.type === 'loop') {
        if (!step.itemVar || typeof step.itemVar !== 'string') pushE({ code: 'loop.itemVar_missing', severity: 'error', path: at + '.itemVar', message: `Step ${step.id}: loop requires \`itemVar\`.`, hint: 'Choose a short variable name like `item` or `email`.' });
        if (!step.overRef || typeof step.overRef !== 'string') pushE({ code: 'loop.overRef_missing', severity: 'error', path: at + '.overRef', message: `Step ${step.id}: loop requires \`overRef\`.`, hint: 'Bind to an upstream array, e.g. `steps.<id>.output.items`.' });
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
            if (typeof step.forEach.overRef === 'string' && step.forEach.overRef) {
                checkForEachSource(ctx, step, at);
                checkForEachParents(ctx, step, at);
                checkForEachItemFields(ctx, step, at);
            }
        }
    }
}

const tokensOf = (path) => parsePath(String(path || ''));
const isPrefix = (short, long) => short.length < long.length && short.every((t, i) => {
    const o = long[i];
    return t.type === o.type && (t.type === 'wild' || (t.key === o.key && (t.type !== 'match' || t.value === o.value)));
});

/**
 * The parents a forEach may bind (`forEach.parents`, a list inside a list —
 * see core/automationRunner/forEachScope.js): outermost first, each with an
 * overRef that is a leading part of the step's own overRef and a name of its
 * own. Returns the usable ones; `problems` collects why the others are not.
 */
function usableParents(fe, problems = []) {
    if (fe.parents === undefined || fe.parents === null) return [];
    if (!Array.isArray(fe.parents)) { problems.push('`parents` must be a list'); return []; }
    const own = tokensOf(fe.overRef);
    const names = new Set([fe.itemVar]);
    const out = [];
    for (const p of fe.parents) {
        if (!isObject(p) || typeof p.itemVar !== 'string' || !p.itemVar || typeof p.overRef !== 'string' || !p.overRef) {
            problems.push('every parent needs an `itemVar` and an `overRef`');
            continue;
        }
        if (names.has(p.itemVar)) { problems.push(`the name "${p.itemVar}" is used twice`); continue; }
        const pt = tokensOf(p.overRef);
        if (!own || !pt || !isPrefix(pt, own)) {
            problems.push(`"${p.overRef}" is not an outer part of "${fe.overRef}"`);
            continue;
        }
        names.add(p.itemVar);
        out.push(p);
    }
    return out;
}

/**
 * Every `loop.<var>` a step's forEach binds for its own fields: the item and
 * the outer items it keeps. referenceScoping.js counts these as bound.
 */
function forEachBoundVars(fe) {
    if (!isObject(fe) || typeof fe.itemVar !== 'string' || !fe.itemVar) return [];
    return [fe.itemVar, ...usableParents(fe).map(p => p.itemVar)];
}

// The list is resolved BEFORE any item is bound, so `loop.<own item>` (or one
// of its parents) as the source is always nothing; the run then skips the step
// as `overref_unresolved` while the editor showed a list to pick.
function checkForEachSource(ctx, step, at) {
    const fe = step.forEach;
    const t = tokensOf(fe.overRef);
    if (!t || t[0]?.key !== 'loop' || typeof t[1]?.key !== 'string') return;
    const own = forEachBoundVars(fe);
    // A Loop above that binds the same name is read before this step's own
    // item shadows it, so `loop.mail.attachments` inside a Loop over mails is fine.
    const above = (ctx.loopVarsAbove && ctx.loopVarsAbove.get(step)) || [];
    if (!own.includes(t[1].key) || above.includes(t[1].key)) return;
    ctx.pushE({
        code: 'foreach.overRef_self', severity: 'error', path: at + '.forEach.overRef',
        message: `Step ${step.id}: it runs once per item of "${fe.overRef}", which is inside its own item (loop.${t[1].key}) — that does not exist yet when the list is read.`,
        hint: 'Pick a list from an earlier step under "Run once per item". For a list inside each item, pick a value from it: the step then runs once per inner item.',
    });
}

function checkForEachParents(ctx, step, at) {
    const problems = [];
    usableParents(step.forEach, problems);
    for (const why of problems) {
        ctx.pushE({
            code: 'foreach.parents_invalid', severity: 'error', path: at + '.forEach.parents',
            message: `Step ${step.id}: the outer lists this step keeps are not right: ${why}.`,
            hint: 'Pick the list again under "Run once per item"; that rewrites them.',
        });
    }
}

/**
 * What ONE item of `overRef` has, when we know: a direct list of a step
 * (fieldsAtRef), or a list inside each result of a step that ran per item
 * (`steps.read.output.results[*].output.attachments`). null when unknown —
 * never an empty list, or every field of an undescribed tool would be flagged.
 */
function itemFieldsAt(graph, overRef) {
    const direct = fieldsAtRef(graph, overRef, null);
    if (direct.fields) return { fields: direct.fields, direct: true };
    const t = tokensOf(overRef);
    const keys = t ? t.map(x => (x.type === 'wild' ? '*' : x.key)) : [];
    if (keys[0] !== 'steps' || keys[2] !== 'output' || keys[3] !== 'results' || keys[4] !== '*' || keys[5] !== 'output') return null;
    const up = (graph?.steps || []).find(s => isObject(s) && s.id === keys[1]);
    if (!up || up.type !== 'integration_action' || !isObject(up.forEach) || typeof up.tool !== 'string') return null;
    if (keys.length === 6) return { fields: topLevelFieldsOf(up.tool, null).fields, direct: false };
    if (keys.length === 7) return { fields: itemFieldsOf(up.tool, keys[6], null).fields, direct: false };
    return null;
}

// A field that reads a field the item does not have resolves to nothing for
// every item. The usual cause: the list the step runs over was switched and
// the fields kept reading the old item's names.
function checkForEachItemFields(ctx, step, at) {
    const fe = step.forEach;
    const scopes = [{ itemVar: fe.itemVar, overRef: fe.overRef }, ...usableParents(fe)];
    for (const [slot, binding] of Object.entries(isObject(step.inputs) ? step.inputs : {})) {
        const refs = [];
        collectRefPaths(binding, refs);
        for (const r of refs) {
            if (r.kind !== 'ref') continue;
            const t = tokensOf(r.path);
            if (!t || t.length < 3 || t[0].key !== 'loop' || t[2].type !== 'prop') continue;
            const scope = scopes.find(s => s.itemVar === t[1].key);
            if (!scope) continue;
            const shape = itemFieldsAt(ctx.graph, scope.overRef);
            if (!shape || !shape.fields) continue;
            let missing = null;
            let suggestion = null;
            if (shape.direct) {
                const chk = checkLoopRef(ctx.graph, formatPath(t), { overRef: scope.overRef, itemVar: scope.itemVar }, null);
                if (chk.ok && chk.path) suggestion = chk.path;
                else if (!chk.ok && !chk.ambiguous) missing = chk.missing;
            } else if (!shape.fields.includes(String(t[2].key))) {
                missing = String(t[2].key);
            }
            if (!missing && !suggestion) continue;
            const shown = shape.fields.slice(0, 12).join(', ') + (shape.fields.length > 12 ? ', …' : '');
            ctx.pushW({
                code: 'foreach.item_field_missing', severity: 'warning', path: `${at}.inputs.${slot}`,
                message: suggestion
                    ? `Step ${step.id}: input "${slot}" reads ${r.path}, but each item of ${scope.overRef} keeps that under ${suggestion}.`
                    : `Step ${step.id}: input "${slot}" reads ${r.path}, but an item of ${scope.overRef} has no "${missing}" (it has: ${shown}).`,
                hint: suggestion
                    ? `Use ${suggestion}.`
                    : 'Pick the field again from the current item under "Comes in" — the list this step runs over may have changed.',
            });
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
    checkFlatten(ctx, step, at);
    if (step.type === 'summarize') {
        if (!step.op || !SUMMARIZE_OPS.has(step.op)) pushE({ code: 'summarize.op_invalid', severity: 'error', path: at + '.op', message: `Step ${step.id}: summarize requires \`op\` in ${Array.from(SUMMARIZE_OPS).join('/')}.`, hint: 'Pick the aggregation operator.' });
    }
}

module.exports = { checkLoop, checkParallel, checkForEach, checkCollectionOps, forEachBoundVars, usableParents };
