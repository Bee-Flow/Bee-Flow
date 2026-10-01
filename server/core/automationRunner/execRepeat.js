/**
 * Running ONE step once per item of a list, and recording what each item got.
 *
 * Two ways in, one loop:
 *
 *   step.forEach = { overRef, itemVar, maxIterations }   (legacy; execFlow.js)
 *       binds `loop.<itemVar>` + `loop._index` per item; the list must be a
 *       real array.
 *   step.repeat  = { over: <Source>, max }                (v2; execRepeatStep)
 *       binds `runState._mappingScope = { over, item, index }` per item, so a
 *       pick with `take: 'each'` reads its path inside the current item
 *       (shared/mapping/resolve.mjs). The list is read with the v2 walk: a
 *       key on a list maps over it, and a single record is a list of one.
 *
 * Both return the same envelope, `{ iterations, succeeded, failed, results }`
 * (+ `truncated`/`totalItems` when the cap bit), so downstream bindings on
 * `steps.<id>.output.results` and the collection ops read either alike, and
 * both record the inputs of their first items for run history
 * (forEachInputSnapshot).
 *
 * Per-item failures are COLLECTED (continue-on-error) rather than aborting
 * the whole step, so a bulk fan-out over many items doesn't die on one bad
 * element; cancellation / approval still propagate.
 */

const { classifyUnknownError } = require('../automationErrors');
const { resolveDeep } = require('../../automation/bind');
const { refIsSynthetic, COLLECTION_OP_MAX_ITEMS, isToolErrorResult } = require('./shared');
const { isRunPause } = require('./execApproval');
const { unresolvedListMessage } = require('./execCollections');
const { walkSource, manyItems, isMany, plain, sourceProblems, describeSource } = require('../../shared/mapping/index.mjs');

// Run history keeps the inputs of the first this-many items of a fan-out.
const MAX_ITEM_INPUT_SNAPSHOTS = 20;
// ...and spends at most this many bytes of serialized JSON on the items after
// the first. recordRunStep caps a step's whole input at 256 KB
// (automation/payloadTruncation.js) and replaces ALL of it with a 1 KB head
// sample past that, so twenty copies of a shared 15 KB input would otherwise
// cost the step every field it used to show.
const PER_ITEM_INPUT_BUDGET_BYTES = 64 * 1024;

function jsonBytes(value) {
    try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8'); } catch { return Infinity; }
}

/**
 * What run history records as the INPUT of a "run once per item" step. The
 * dispatcher used to resolve step.inputs against the OUTER state, where
 * loop.<itemVar> is not bound, so every mapped field read as empty although
 * each item ran with the right value. Now: the first recorded item's inputs at
 * the top (what the Runs tab lists under "Got in"), and the items after it
 * under `_perItem` ({index, inputs}) while they fit PER_ITEM_INPUT_BUDGET_BYTES;
 * `_perItemOmitted` counts every item that is in neither place (past the
 * snapshot cap or the byte budget). Keys starting with `_` are not listed as
 * fields by the Runs tab.
 */
function forEachInputSnapshot(snapshots, total) {
    const recorded = [];
    for (let i = 0; i < snapshots.length; i++) if (i in snapshots) recorded.push({ index: i, inputs: snapshots[i] });
    if (!recorded.length) return undefined;
    const first = recorded[0].inputs;
    const perItem = [];
    let bytes = 0;
    for (const entry of recorded.slice(1)) {
        bytes += jsonBytes(entry);
        if (bytes > PER_ITEM_INPUT_BUDGET_BYTES) break;
        perItem.push(entry);
    }
    const shown = 1 + perItem.length;
    return {
        ...(first && typeof first === 'object' && !Array.isArray(first) ? first : {}),
        ...(perItem.length ? { _perItem: perItem } : {}),
        ...(total > shown ? { _perItemOmitted: total - shown } : {}),
    };
}


/**
 * The per-item loop both ways in share: run `runLeaf` once per item with the
 * state `scopeFor(i)` gives it, with per-item retry, and return the fan-out
 * envelope. `total` is the length of the list before the cap.
 *
 * `runLeaf` is the dispatch-by-type closure (no iteration) from the
 * enclosing executeAutomation scope, so container steps nested in a fan-out
 * still recurse correctly.
 */
async function runPerItem({ step, ctx, mode, runLeaf, checkCancel = null, items, total, sourceSynthetic, scopeFor }) {
    const results = [];
    const inputSnapshots = [];
    let failed = 0;
    let anyItemSynthesised = false;
    const withheldTools = new Map();
    // §WS2.5 — step.retry applies PER ITEM here. A fan-out is N executions of the
    // step body, so retrying the WHOLE forEach from the outer dispatch loop would
    // re-run already-succeeded items. We own retry at the item level instead.
    // nosemgrep: ajinabraham.njsscan.eval.eval_node.eval_nodejs -- the only timer below is setTimeout(fn, ms) with a function and a numeric delay; nothing is evaluated
    const retry = (step.retry && step.retry.max > 0) ? step.retry : null;
    const maxAttempts = retry ? retry.max + 1 : 1;
    // Only Gmail message reads opt into bounded parallelism. Other actions
    // may depend on order or have side effects. askOnce stays serial so
    // duplicate IDs can reuse the first result from the run memo.
    const concurrency = mode === 'live' && step.type === 'integration_action'
        && step.tool === 'gmail_read' && !step.askOnce ? 5 : 1;
    const runItem = async (i) => {
        // Honour cancellation between items — a long fan-out (hundreds of
        // API calls) must stop promptly, not only at the next step boundary.
        if (checkCancel) await checkCancel();
        const subState = scopeFor(i);
        if (step.inputs && i < MAX_ITEM_INPUT_SNAPSHOTS) {
            inputSnapshots[i] = resolveDeep(step.inputs, subState, { allowSecrets: false, silent: true });
        }
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
            results[i] = { index: i, item: items[i], error: lastErr.message, errorClass: lastErr.errorClass || classifyUnknownError(lastErr), attempts: maxAttempts, status: 'error' };
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
        err.forEachInputSnapshot = forEachInputSnapshot(inputSnapshots, items.length);
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
            ...(total > items.length ? { truncated: true, totalItems: total } : {}),
        },
        // Propagate dry-run taint: a fan-out over synthetic data (or whose
        // items were synthesized) produces synthetic aggregate results.
        ...(mode === 'dry_run' && (sourceSynthetic || anyItemSynthesised) ? { dryRunSynthesised: true, dryRunFallback: 'synthetic_input' } : {}),
        ...(withheldTools.size ? { toolsWithheld: [...withheldTools.keys()], toolsWithheldReasons: Object.fromEntries(withheldTools) } : {}),
        // Picked up (and removed) by the dispatcher as the step's inputSnapshot.
        ...(inputSnapshots.length ? { forEachInputSnapshot: forEachInputSnapshot(inputSnapshots, items.length) } : {}),
    };
}

/** The legacy path refIsSynthetic reads for a Source's root, for the dry-run taint. */
function syntheticHead(over) {
    if (over.root === 'steps') return `steps.${over.id}`;
    if (over.root === 'trigger') return 'trigger';
    if (over.root === 'loop') return `loop.${over.id}`;
    return '';
}

/**
 * The items a repeat runs for, or a reason it can't: what `over` holds, read
 * the v2 way. A list gives its items (a key on a list of lists gives all of
 * theirs), a single record or value is a list of one, nothing (or an empty
 * field) is a skip that says which list it looked for.
 */
function repeatItems(over, runState) {
    if (sourceProblems(over).length) return { missing: true, found: undefined };
    const resolved = walkSource(over, runState, { memo: runState._mappingMemo instanceof Map ? runState._mappingMemo : undefined });
    if (resolved === undefined || resolved === null) return { missing: true, found: resolved };
    return { items: manyItems(resolved).items, crossed: isMany(resolved), found: plain(resolved) };
}

/**
 * `step.repeat`: run the step once per item of `repeat.over` (a v2 Source),
 * at most `repeat.max` (default 100, ceiling 1000) times. See the header.
 */
async function execRepeatStep(step, ctx, runState, mode, runLeaf, checkCancel = null) {
    const rep = step.repeat || {};
    const over = rep.over;
    const where = describeSource(over) || null;
    const read = repeatItems(over, runState);
    if (read.missing) {
        return {
            output: {
                iterations: 0, succeeded: 0, failed: 0, results: [],
                skipped: unresolvedListMessage('the list it repeats over', where, read.found),
            },
            skippedReason: 'overref_unresolved',
        };
    }
    const list = read.items;
    if (list.length > COLLECTION_OP_MAX_ITEMS) {
        const err = new Error(`repeat input has ${list.length} items (max ${COLLECTION_OP_MAX_ITEMS}). Add a limit/filter step upstream or raise AUTOMATION_COLLECTION_MAX_ITEMS.`);
        err.errorClass = 'collection_too_large';
        throw err;
    }
    const max = Math.min(Number.isSafeInteger(rep.max) && rep.max > 0 ? rep.max : 100, 1000);
    const items = list.slice(0, max);
    const sourceSynthetic = mode === 'dry_run' && refIsSynthetic(syntheticHead(over), runState, ctx);
    return runPerItem({
        step, ctx, mode, runLeaf, checkCancel, items, total: list.length, sourceSynthetic,
        scopeFor: (i) => ({ ...runState, _mappingScope: { over, item: items[i], index: i } }),
    });
}

module.exports = { runPerItem, execRepeatStep, repeatItems, syntheticHead, forEachInputSnapshot, MAX_ITEM_INPUT_SNAPSHOTS };
