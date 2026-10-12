/**
 * Flow-container steps (extracted verbatim from engine.js): parallel
 * branches, loop bodies, per-step forEach fan-out, inline layers and
 * external Steps (call_block) — everything that runs a sub-DAG.
 */

const { classifyUnknownError } = require('../automationErrors');
const { resolveInputs } = require('../../automation/bind');
const { MASK_VALUES } = require('./httpAuth');
const {
    cloneRunValue, MAX_LAYER_DEPTH, LOOP_ROOT_ID, PARALLEL_ROOT_ID,
    refIsSynthetic, COLLECTION_OP_MAX_ITEMS, isToolErrorResult,
} = require('./shared');
const { isRunPause } = require('./execApproval');
const { unresolvedListMessage } = require('./execCollections');
const { runDag } = require('./runDag');
const { resolveForEachItems } = require('./forEachScope');

// ── Parallel branches ───────────────────────────────────
//
// step.branches: Step[][] — each entry is a list of steps to run in
// sequence. Branches run concurrently with Promise.allSettled; output
// is { branches: [{ status, output, error? }, ...] }.
//
// Per-branch failures don't fail the whole step by default; set
// `step.failOnAnyBranchError: true` to flip that semantics. This matches
// Power Automate's "Run after" behaviour where parallel branches default
// to soft-fail unless explicitly chained.
async function execParallel(step, ctx, runState, mode, dispatchSubStep) {
    const branches = Array.isArray(step.branches) ? step.branches : [];
    if (branches.length === 0) {
        return { output: { branches: [] } };
    }
    const results = await Promise.allSettled(branches.map((branchSteps, branchIndex) => {
        // Each branch needs its own `steps` map so concurrent writes don't
        // clobber sibling branches. Upstream steps are visible (the clone
        // copies them in); branch-internal writes stay local. Per-branch
        // step outputs are still persisted to `automation_run_steps` via
        // recordRunStep so the run history captures everything.
        const subState = {
            ...runState,
            steps: { ...(runState.steps || {}) },
            parallel: { ...(runState.parallel || {}), _branchIndex: branchIndex },
        };
        // The synthesized root id has to match the one buildLinearEdges wires
        // the first body step from. It didn't: buildLinearEdges hardcoded
        // '__loop_root__', so `adj.get('__parallel_root__')` was undefined, the
        // queue drained on the first turn and EVERY branch reported success
        // with output null — a parallel node executed zero steps and the run
        // still finished green (node-audit W4-9).
        const subDef = {
            steps: branchSteps || [],
            edges: buildLinearEdges(branchSteps || [], PARALLEL_ROOT_ID),
            trigger: { id: PARALLEL_ROOT_ID },
        };
        return runDag(subDef, { ...ctx, _branchIndex: branchIndex }, subState, mode, dispatchSubStep, { recordSteps: true, branchIndex });
    }));
    // An approval pause inside a branch is a control-flow signal, not a
    // branch failure — Promise.allSettled would otherwise flatten it into
    // a plain rejected result, and with the default failOnAnyBranchError
    // false the parallel step would report success and the run would
    // complete, silently skipping the human approval gate. Propagate it
    // unconditionally, the same way runDag itself always rethrows it.
    const approvalRejection = results.find(r => r.status === 'rejected' && isRunPause(r.reason));
    if (approvalRejection) throw approvalRejection.reason;
    const branchOutputs = results.map((r, idx) => {
        if (r.status === 'fulfilled') {
            return { branchIndex: idx, status: 'success', output: r.value?.lastOutput ?? null };
        }
        const reason = r.reason;
        return {
            branchIndex: idx,
            status: 'error',
            error: reason?.message || String(reason),
            errorName: reason?.name || null,
            errorStack: reason?.stack || null,
            errorCause: reason?.cause ? (reason.cause.message || String(reason.cause)) : null,
        };
    });
    if (step.failOnAnyBranchError && branchOutputs.some(b => b.status === 'error')) {
        const firstError = branchOutputs.find(b => b.status === 'error');
        throw new Error(`Parallel branch ${firstError.branchIndex} failed: ${firstError.error}`);
    }
    return { output: { branches: branchOutputs } };
}

async function execLoop(step, ctx, runState, mode, dispatchSubStep) {
    const resolved = require('../../automation/bind').walkList(step.overRef, runState);
    if (!Array.isArray(resolved)) {
        // Top-level skippedReason → runDag records the row as 'skipped', not
        // a green success (A10). An UNRESOLVED source is not the same thing
        // as an empty list — the old `|| []` fallback made a typo'd overRef
        // run zero iterations and report success.
        // Same sentence as the other two unresolved-list paths (BFSF-370): a
        // Loop and a run-once-per-item step fail the author's expectation
        // identically, so they should not explain themselves differently.
        return {
            output: { iterations: 0, results: [], skipped: unresolvedListMessage('the list it loops over', step.overRef, resolved) },
            skippedReason: 'overref_unresolved',
        };
    }
    const list = resolved;
    const itemVar = step.itemVar || 'item';
    // batchSize=1 (default/omitted) is BYTE-IDENTICAL to pre-batching
    // behavior: a single element bound to loop.<itemVar>, one iteration per
    // item. batchSize>1 binds a SLICE (an array of up to batchSize items)
    // instead — n8n's Split-In-Batches semantics.
    const batchSize = Math.max(1, Number(step.batchSize) || 1);
    // maxIterations caps ITERATIONS, as the label/chip/validator all say —
    // it used to slice the ITEM list before batching, so batchSize 10 +
    // max 100 over 500 items ran only 10 iterations and silently dropped
    // 400 items (A9). batchSize=1 is unchanged (items == iterations).
    const maxIter = Math.min(step.maxIterations || 100, 1000);
    const totalIter = batchSize === 1 ? list.length : Math.ceil(list.length / batchSize);
    const cappedIter = Math.min(totalIter, maxIter);
    const items = list.slice(0, Math.min(list.length, cappedIter * batchSize));
    const truncated = totalIter > cappedIter;
    const results = [];
    // Loop bodies are NOT individually recorded (each iteration would
    // collide on the (run_id, step_id, attempts) PK). suppress:true also
    // mutes the dispatchStep error/approval record sites AND any layer
    // called from inside the body — a call_layer in a loop records nothing.
    const loopCtx = { ...ctx, stepRecord: { prefix: '', parentStepId: null, suppress: true } };
    // Dry-run taint: iterating a synthesized array makes every loop.<var>
    // binding inside the body synthetic (see execForEachStep).
    const sourceSynthetic = mode === 'dry_run' && refIsSynthetic(step.overRef, runState, ctx);
    const iterationCount = cappedIter;
    for (let i = 0; i < iterationCount; i++) {
        const itemOrBatch = batchSize === 1 ? items[i] : items.slice(i * batchSize, i * batchSize + batchSize);
        const subState = {
            ...runState,
            loop: { ...(runState.loop || {}), [itemVar]: itemOrBatch, _index: i },
            _syntheticLoopVars: { ...(runState._syntheticLoopVars || {}), [itemVar]: sourceSynthetic },
        };
        const subDef = { steps: step.body || [], edges: buildLinearEdges(step.body || [], LOOP_ROOT_ID), trigger: { id: LOOP_ROOT_ID } };
        const subRun = await runDag(subDef, loopCtx, subState, mode, dispatchSubStep, { recordSteps: false });
        results.push({ index: i, item: itemOrBatch, output: subRun.lastOutput });
    }
    return {
        // `truncated`/`totalItems` are additive observability keys: a loop
        // that hit its iteration cap used to drop the tail silently (A9).
        output: { iterations: iterationCount, results, ...(truncated ? { truncated: true, totalItems: list.length } : {}) },
        ...(mode === 'dry_run' && sourceSynthetic ? { dryRunSynthesised: true, dryRunFallback: 'synthetic_input' } : {}),
    };
}

/**
 * Synthesize the edges for a loop-body / parallel-branch sub-DAG. Bodies are
 * persisted as a bare step ARRAY (no edges), so the chain is linear — but the
 * emitted edges must be BRANCHER-AWARE: runDag routes a condition/switch by
 * the label its executor returns (`then`/`else`/`case:<name>`), and an
 * unlabelled edge only matches plain `on_success`. Emitting bare `{from,to}`
 * after a brancher meant NO edge ever matched, so every body step after an
 * If/Switch silently dead-ended on every iteration (node-audit C3).
 *
 * Semantics in a linear body:
 *   - condition / guard → GUARD: `then` continues the body, `else` ends this
 *     iteration (same contract as the "Filter (route)" palette item). A guard
 *     ALWAYS answers `then`/`else` and runDag routes it exactly like a
 *     condition, so leaving it out of this list dead-ended every body step
 *     after a guard on every iteration (node-audit W4-10).
 *   - switch → pass-through: a linear body can't branch, so every declared
 *     case plus the default port continues to the next step.
 *
 * `rootId` is the synthetic trigger id of the sub-DAG the caller is about to
 * run — it MUST be the same id that caller puts in `trigger.id`, or nothing is
 * reachable from the root and the branch executes nothing (see execParallel).
 *
 * A `note` (BFSF-411) is dropped from the chain entirely rather than linked
 * in like any other body step. Bodies are the one place a step's edges are
 * SYNTHESIZED regardless of what the author drew — everywhere else a note
 * simply never receives an edge — so this is the one call site that could
 * otherwise wire a canvas annotation into the execution graph and dispatch
 * it. The filtered-out note stays in the caller's `steps` array (harmless:
 * with no edge in or out it is never reachable from the sub-DAG's root), so
 * nothing here needs to touch that array too.
 */
function buildLinearEdges(steps, rootId = LOOP_ROOT_ID) {
    const executable = (steps || []).filter(s => s?.type !== 'note');
    if (executable.length === 0) return [];
    const edges = [{ from: rootId, to: executable[0].id }];
    for (let i = 1; i < executable.length; i++) {
        const prev = executable[i - 1];
        const to = executable[i].id;
        if (prev.type === 'condition' || prev.type === 'guard') {
            edges.push({ from: prev.id, to, label: 'then' });
        } else if (prev.type === 'switch') {
            for (const c of (Array.isArray(prev.cases) ? prev.cases : [])) {
                if (c?.name) edges.push({ from: prev.id, to, label: `case:${c.name}` });
            }
            edges.push({ from: prev.id, to, label: 'case:default' });
        } else {
            edges.push({ from: prev.id, to });
        }
    }
    return edges;
}

/**
 * Per-step iteration ("run once per item"). When a leaf step carries
 * `step.forEach = { overRef, itemVar, maxIterations }`, run the step's own
 * leaf handler once per element of the resolved array, binding
 * `loop.<itemVar>` (+ `loop._index`) for each pass. Unlike the `loop`
 * container step this wraps the SAME step (no body subgraph) — it's the
 * implicit fan-out auto-map sets up when you wire an array-producing step
 * into one whose inputs match the array's element fields.
 *
 * Per-item failures are COLLECTED (continue-on-error) rather than aborting
 * the whole step, so a bulk fan-out over many items doesn't die on one bad
 * element; cancellation / approval still propagate. Output mirrors
 * execLoop's `{ iterations, results:[{index,item,output}] }` shape (plus
 * succeeded/failed counts) so downstream `steps.<id>.output.results`
 * bindings and the collection ops (filter/limit/…) keep working unchanged.
 *
 * `runLeaf` is the dispatch-by-type closure (no iteration) from the
 * enclosing executeAutomation scope, so container steps nested in a
 * forEach still recurse correctly.
 */
// Read-only fetches a per-item step may run a few at a time (see
// execForEachStep). Attachments get fewer: each one is also parsed / OCR'd in
// this process, and five large PDFs at once is a memory spike for nothing.
const PARALLEL_READ_TOOLS = new Map([['gmail_read', 5], ['gmail_read_attachment', 3]]);

async function execForEachStep(step, ctx, runState, mode, runLeaf, checkCancel = null) {
    const fe = step.forEach || {};
    const list = require('../../automation/bind').walkList(fe.overRef, runState);
    if (!Array.isArray(list)) {
        // Top-level skippedReason → recorded as 'skipped', not success (A10).
        // The message names the binding and the remedy (BFSF-370) — a bare
        // "did not resolve to an array" left the author staring at
        // Iterations: 0 / Succeeded: 0 with nothing to act on.
        return {
            output: {
                iterations: 0, succeeded: 0, failed: 0, results: [],
                skipped: unresolvedListMessage('the list it runs once per item over', fe.overRef, list),
            },
            skippedReason: 'overref_unresolved',
        };
    }
    // A list inside a list keeps its outer items (`forEach.parents`, see
    // forEachScope.js): per item, the element it came from is bound under the
    // name it had before the step was moved down a level.
    const { scopes, noMatch } = resolveForEachItems(fe, runState, list);
    if (noMatch) {
        // `orders[*].line_items.properties` resolves to [] on every order — a
        // path that fits none of the data, not an empty source. Zero runs in
        // green is what the author would see, so say what did not match.
        return {
            output: {
                iterations: 0, succeeded: 0, failed: 0, results: [],
                skipped: `This step works through a list, but the list it runs once per item over \`${fe.overRef}\` matched none of the ${noMatch.count} items of \`${noMatch.outer}\`. `
                    + 'Pick the list again under "Run once per item", or re-run the step that produces it.',
            },
            skippedReason: 'overref_unresolved',
        };
    }
    // Hard platform ceiling first — fail loudly through on_error rather than
    // fanning out hundreds of thousands of API calls. Same error class as
    // resolveArrayRef so run-history facets group it.
    if (list.length > COLLECTION_OP_MAX_ITEMS) {
        const err = new Error(`forEach input has ${list.length} items (max ${COLLECTION_OP_MAX_ITEMS}). Add a limit/filter step upstream or raise AUTOMATION_COLLECTION_MAX_ITEMS.`);
        err.errorClass = 'collection_too_large';
        throw err;
    }
    const max = Math.min(fe.maxIterations || 100, 1000);
    const items = list.slice(0, max);
    // Did the cap actually bite? `maxIterations` is optional (validate.js only
    // range-checks it when present), so the default 100 applies to every
    // fan-out whose author never set one — and the tail was dropped with the
    // run finishing green and `iterations`/`succeeded` agreeing with each
    // other, which looks exactly like a complete pass. execLoop reports the
    // same fact with the same two keys (A9); a "run once per item" step is the
    // other half of that feature and must not stay quieter about it.
    const truncated = list.length > items.length;
    const itemVar = fe.itemVar || 'item';
    // Dry-run taint: when the source array itself is synthesized, every
    // per-item loop.<var> binding is fake — the leaf executor synthesizes
    // instead of dispatching N doomed live calls.
    const sourceSynthetic = mode === 'dry_run' && refIsSynthetic(fe.overRef, runState, ctx);
    const results = [];
    let failed = 0;
    let anyItemSynthesised = false;
    const withheldTools = new Map();
    // §WS2.5 — step.retry applies PER ITEM here. A fan-out is N executions of the
    // step body, so retrying the WHOLE forEach from the outer dispatch loop would
    // re-run already-succeeded items. We own retry at the item level instead.
    // nosemgrep: ajinabraham.njsscan.eval.eval_node.eval_nodejs -- the only timer below is setTimeout(fn, ms) with a function and a numeric delay; nothing is evaluated
    const retry = (step.retry && step.retry.max > 0) ? step.retry : null;
    const maxAttempts = retry ? retry.max + 1 : 1;
    // Only read-only Gmail fetches opt into bounded parallelism (results keep
    // their item order). Other actions may depend on order or have side
    // effects. Attachments are the slow case: each one is downloaded AND run
    // through text extraction / OCR, a mail often carries a dozen (logos), and
    // one at a time that took minutes. askOnce stays serial so duplicate IDs
    // can reuse the first result from the run memo.
    const concurrency = mode === 'live' && step.type === 'integration_action'
        && PARALLEL_READ_TOOLS.has(step.tool) && !step.askOnce ? PARALLEL_READ_TOOLS.get(step.tool) : 1;
    const runItem = async (i) => {
        // Honour cancellation between items — a long fan-out (hundreds of
        // API calls) must stop promptly, not only at the next step boundary.
        if (checkCancel) await checkCancel();
        const parentVars = scopes ? scopes[i] : null;
        const subState = {
            ...runState,
            loop: { ...(runState.loop || {}), ...(parentVars || {}), [itemVar]: items[i], _index: i },
            _syntheticLoopVars: {
                ...(runState._syntheticLoopVars || {}),
                ...(parentVars ? Object.fromEntries(Object.keys(parentVars).map(k => [k, sourceSynthetic])) : {}),
                [itemVar]: sourceSynthetic,
            },
        };
        let lastErr = null;
        let out = null;
        let ok = false;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const r = await runLeaf(step, ctx, subState, mode);
                out = r?.output ?? null;
                if (r?.dryRunSynthesised) anyItemSynthesised = true;
                // An AI step's withheld tools (handoff 5), once per fan-out.
                if (Array.isArray(r?.toolsWithheld)) {
                    for (const n of r.toolsWithheld) if (!withheldTools.has(n)) withheldTools.set(n, r.toolsWithheldReasons?.[n] || 'unavailable');
                }
                ok = true;
                break;
            } catch (e) {
                // Run pauses (approval, form page) and cancellation are not
                // per-item errors — they must halt the run, not get swallowed
                // into the results.
                if (isRunPause(e) || e.message === 'Run cancelled') throw e;
                lastErr = e;
                if (attempt < maxAttempts && retry?.backoffMs) {
                    await new Promise(r => setTimeout(r, Number(retry.backoffMs) || 0));
                }
            }
        }
        // A tool that returns a soft `{ error }` object instead of throwing is
        // a FAILED iteration, in dry run as much as live. The single-step path
        // deliberately keeps such a result green during a dry run so the
        // builder can plan without credentials, but inside a fan-out that
        // carve-out hid a real misconfiguration: a forEach whose step had no
        // `path` input reported "succeeded: 4, failed: 0" with
        // {error:"path is required"} tucked inside every item, and the builder
        // read the green count and moved on (2026-09-12). Counting it honestly
        // also means an all-error fan-out throws foreach_all_failed below.
        if (ok && isToolErrorResult(out)) {
            ok = false;
            lastErr = new Error(String(out.error));
            lastErr.errorClass = 'tool_error';
        }
        if (ok) {
            results[i] = { index: i, item: items[i], output: out, status: 'success' };
        } else {
            failed++;
            // `output: null` keeps the slot: `results[*].output` stays as long
            // as `results[*].item` and lines up with it. Without the key the
            // [*] walk skipped the failed item and every later output moved
            // one row up against its item.
            results[i] = { index: i, item: items[i], output: null, error: lastErr.message, errorClass: lastErr.errorClass || classifyUnknownError(lastErr), attempts: maxAttempts, status: 'error' };
        }
    };
    for (let start = 0; start < items.length; start += concurrency) {
        if (concurrency === 1) {
            await runItem(start);
            continue;
        }
        // Drain in-flight reads before propagating cancellation/a pause, so
        // no calls keep running after the step has been recorded as stopped.
        const batch = await Promise.allSettled(
            items.slice(start, start + concurrency).map((_, offset) => runItem(start + offset)),
        );
        const rejected = batch.find(r => r.status === 'rejected');
        if (rejected) throw rejected.reason;
    }
    // §WS2.5 — a fan-out where EVERY item failed is a real step failure, not a
    // green 'success'. Throw so it routes the on_error edge / is recorded as an
    // error. Continue-on-error still applies for PARTIAL failures (those return
    // fulfilled with a `failed` count). `foreachHandled` tells the outer dispatch
    // retry loop NOT to re-run the whole fan-out — per-item retry already ran.
    if (items.length > 0 && failed === items.length) {
        const err = new Error(`All ${items.length} forEach iteration(s) failed (e.g. "${results[0]?.error || 'unknown error'}").`);
        err.errorClass = 'foreach_all_failed';
        err.foreachHandled = true;
        err.foreachResults = results;
        throw err;
    }
    return {
        // `truncated`/`totalItems` are the same additive observability keys
        // execLoop emits, and mean the same thing: the fan-out stopped at its
        // iteration cap and `list.length - iterations` items were never
        // processed. Additive, so existing `results`/`iterations` bindings are
        // untouched, and absent entirely on a complete pass.
        output: {
            iterations: items.length, succeeded: items.length - failed, failed, results,
            ...(truncated ? { truncated: true, totalItems: list.length } : {}),
        },
        // Propagate dry-run taint: a fan-out over synthetic data (or whose
        // items were synthesized) produces synthetic aggregate results.
        ...(mode === 'dry_run' && (sourceSynthetic || anyItemSynthesised) ? { dryRunSynthesised: true, dryRunFallback: 'synthetic_input' } : {}),
        ...(withheldTools.size ? { toolsWithheld: [...withheldTools.keys()], toolsWithheldReasons: Object.fromEntries(withheldTools) } : {}),
    };
}

/**
 * Call a Layer — an inline sub-flow stored at `definition.layers[layerKey]`
 * (a full mini-definition: layer_input trigger + steps incl. a layer_output
 * step + edges). Modelled on execLoop: resolve mapped inputs from the PARENT
 * runState, run the layer's own DAG in a fresh isolated runState (inputs land
 * in `trigger.output.<param>`), and return the layer's declared output
 * (`layer_output` step) as this step's output.
 *
 * Sub-step recording: the layer's internal steps ARE recorded, namespaced as
 * `<callStepId>/<subStepId>` (nested: `cl1/cl2/out`) with `parent_step_id`
 * pointing at the recorded id of the calling step, so the run history can
 * nest them. The (run_id, step_id, attempts) PK stays collision-free because
 * the prefix is unique per call step. When the surrounding context is
 * suppressed (loop bodies), the layer records nothing — parity with today's
 * unrecorded loop bodies.
 *
 * Safety: ctx.layerStack carries the chain of layerKeys so direct (A→A) and
 * transitive (A→B→A) recursion is rejected at runtime (validation also
 * rejects cycles at save time — this is the backstop), plus a hard
 * MAX_LAYER_DEPTH cap. The layer runs under the SAME ctx (user/session), so
 * the per-tool permission re-check inside execIntegrationAction governs every
 * nested step. Cancellation + hard-timeout propagate for free (same
 * dispatchStep closure).
 */
async function execCallLayer(step, ctx, runState, mode, dispatchSubStep) {
    if (!step.layerKey) {
        if (step.layerId) {
            // Pre-migration shape (call_layer pointed at a standalone
            // automations row). The boot migration rewrites these; a row
            // that slipped through (e.g. restored from an old version
            // snapshot) needs a re-save to re-embed the layer.
            throw new Error(`Step "${step.id}" uses a legacy layer reference — re-save this automation in the builder to migrate it to an inline layer.`);
        }
        throw new Error('call_layer step is missing layerKey');
    }

    const stack = ctx.layerStack || [];
    if (stack.includes(step.layerKey)) {
        throw new Error(`Layer recursion detected: ${[...stack, step.layerKey].join(' → ')}`);
    }
    if (stack.length >= MAX_LAYER_DEPTH) {
        throw new Error(`Maximum layer nesting depth (${MAX_LAYER_DEPTH}) exceeded`);
    }

    const layer = (ctx.layers || {})[step.layerKey];
    if (!layer) {
        throw new Error(`Unknown layer "${step.layerKey}" — it does not exist in this automation's layers. Available: ${Object.keys(ctx.layers || {}).join(', ') || '(none)'}.`);
    }
    if (!layer.trigger?.id) throw new Error(`Layer "${layer.title || step.layerKey}" has no input contract`);

    // Mapped inputs resolve against the PARENT runState → synthetic trigger.
    const mappedInputs = resolveInputs(step.inputs || {}, runState, { allowSecrets: false });

    const subState = {
        trigger: { output: cloneRunValue(mappedInputs) },
        steps: {},
        // Shared by REFERENCE with the parent — vars are document-level
        // (root definition), not per-graph, so a layer sees the same vars
        // the parent does.
        vars: runState.vars,
        secrets: runState.secrets || {},
        loop: {},
        parallel: {},
        _templateWarnings: runState._templateWarnings,
        // Same REFERENCE as the parent — handled errors inside the layer
        // count toward the run-level summary/handled_error_count. (execLoop
        // and execParallel preserve the reference implicitly via spread.)
        _handledErrors: runState._handledErrors,
        // Same REFERENCE too: credential mask needles pushed inside the layer
        // must still mask the parent's recorded aggregate output. (Spread
        // copies symbol keys, but this subState is built explicitly.)
        [MASK_VALUES]: runState[MASK_VALUES],
    };
    // Recorded sub-step ids are namespaced under this call step's own
    // recorded id. When the parent context is suppressed (loop body), the
    // layer's sub-steps stay suppressed too.
    const parentRecord = ctx.stepRecord || { prefix: '', parentStepId: null, suppress: false };
    const subRecord = parentRecord.suppress
        ? { prefix: '', parentStepId: null, suppress: true }
        : {
            prefix: `${parentRecord.prefix || ''}${step.id}/`,
            parentStepId: `${parentRecord.prefix || ''}${step.id}`,
            suppress: false,
        };
    const subCtx = {
        ...ctx,
        definition: layer,
        layerStack: [...stack, step.layerKey],
        stepRecord: subRecord,
    };

    const sub = await runDag(layer, subCtx, subState, mode, dispatchSubStep, { recordSteps: true });

    // Output contract: the layer_output step's resolved fields, else lastOutput.
    const outStep = (layer.steps || []).find(s => s.type === 'layer_output');
    const output = outStep
        ? (subState.steps[outStep.id]?.output ?? sub.lastOutput)
        : sub.lastOutput;
    return { output: output ?? {} };
}

/**
 * Terminal step inside a layer declaring what the layer returns. Resolves
 * its `fields` map exactly like `set` — the resolved object is surfaced to
 * the caller as the layer's output (see execCallLayer).
 */
async function execLayerOutput(step, ctx, runState) {
    const fields = resolveInputs(step.fields || {}, runState, { allowSecrets: false });
    return { output: fields };
}

// ── Steps (reusable building blocks, kind='block') ──────
//
// A `call_block` step invokes an EXTERNAL stored Step (kind='block') by id —
// the global cousin of call_layer. We resolve the Step's PUBLISHED definition
// (publish-to-apply), check the caller may use it, then hydrate it as an
// ephemeral layer and delegate to execCallLayer. That reuse buys cross-Step
// recursion detection, the combined MAX_LAYER_DEPTH cap, sub-step nesting,
// cancellation, timeouts, secret redaction, and handled-error accounting for
// free — and the Step runs under the CALLER's ctx, never the author's.

const BLOCK_EPHEMERAL_PREFIX = '__block_';

/** Can `ctx` (the running user) use this Step row? Owner, or shared into one
 *  of the caller's orgs (and, when group-restricted, a shared group). */
function callerCanUseBlock(row, ctx) {
    if (!row) return false;
    if (row.userId === ctx.userId) return true;
    if (!row.isPublished) return false;
    const orgs = Array.isArray(ctx.userOrgIds) ? ctx.userOrgIds : (ctx.orgId ? [ctx.orgId] : []);
    if (!row.organizationId || !orgs.includes(row.organizationId)) return false;
    const groups = Array.isArray(row.sharedGroups) ? row.sharedGroups : [];
    if (groups.length === 0) return true;
    const myGroups = Array.isArray(ctx.userGroupIds) ? ctx.userGroupIds : [];
    return groups.some(g => myGroups.includes(g));
}

/** Resolve the published definition of a Step for a run, memoised per-run.
 *  Throws a typed error if the Step is missing, unpublished, or forbidden. */
async function loadBlockForRun(ctx, blockId) {
    if (!ctx._blockCache) ctx._blockCache = new Map();
    if (ctx._blockCache.has(blockId)) return ctx._blockCache.get(blockId);
    const automationStore = require('../../stores/automationStore');
    const row = await automationStore.getAutomation(blockId).catch(() => null);
    if (!row || row.kind !== 'block') {
        const e = new Error(`Step "${blockId}" was deleted or is unavailable.`); e.errorClass = 'block_unavailable'; throw e;
    }
    if (!callerCanUseBlock(row, ctx)) {
        const e = new Error(`You do not have access to Step "${row.title || blockId}".`); e.errorClass = 'block_forbidden'; throw e;
    }
    if (row.publishedVersion == null) {
        const e = new Error(`Step "${row.title || blockId}" has not been published yet.`); e.errorClass = 'block_unpublished'; throw e;
    }
    const def = await automationStore.getVersionDefinition(blockId, row.publishedVersion).catch(() => null)
        || row.definition; // fall back to the working def if the snapshot is missing
    if (!def || !def.trigger) {
        const e = new Error(`Step "${row.title || blockId}" has no published definition.`); e.errorClass = 'block_unavailable'; throw e;
    }
    const resolved = { def, title: row.title };
    ctx._blockCache.set(blockId, resolved);
    return resolved;
}

async function execCallBlock(step, ctx, runState, mode, dispatchSubStep) {
    if (!step.blockId || typeof step.blockId !== 'string') {
        throw new Error('call_block step is missing blockId');
    }
    const { def } = await loadBlockForRun(ctx, step.blockId);
    // Hydrate the external Step as an ephemeral layer and delegate. A stable
    // ephemeral key per blockId makes execCallLayer's own layerStack catch
    // cross-Step recursion (A→A and A→B→A) and enforce the shared depth cap.
    const ephemeralKey = `${BLOCK_EPHEMERAL_PREFIX}${step.blockId}`;
    const subCtx = { ...ctx, layers: { ...(ctx.layers || {}), [ephemeralKey]: def } };
    return execCallLayer(
        { ...step, type: 'call_layer', layerKey: ephemeralKey },
        subCtx, runState, mode, dispatchSubStep,
    );
}

/**
 * Run a published Step as a one-shot tool (direct/agent chat). Feeds `args`
 * into the Step's layer_input contract (trigger.output.<param>) and returns
 * its layer_output fields.
 *
 * v1: chat-tool exposure is OWNER-ONLY (mirrors agent_call), so the Step runs
 * under the caller's own identity — no cross-identity secret leak. We reuse
 * executeAutomation with a synthetic automation carrying the PUBLISHED
 * definition, so the run is recorded, cancellable, and time-boxed like any
 * other.
 */

module.exports = {
    execParallel, execLoop, buildLinearEdges, execForEachStep,
    execCallLayer, execLayerOutput, callerCanUseBlock, loadBlockForRun, execCallBlock,
};
