/**
 * Partial runs — the canvas's "Execute step", "retry from step" and "run up to
 * here" (extracted verbatim from automationRunner.js).
 *
 * Each mode seeds a synthetic replayState from recent live runs and current pins
 * and then calls executeAutomation with the matching partial-execution flag.
 * The TRIGGER's own pinned sample is resolved through executeAutomation's
 * resolveTriggerPayload — except in the two branches here that synthesize a run
 * without calling it (▶ on the root trigger, ▶ on a flowlet input), which apply
 * the same rule themselves rather than reimplementing it.
 * Steps that are not nodes of the root DAG get their own entry points: one for a
 * node inside a LOOP BODY, one for a node inside a flowlet/layer.
 *
 * An automation managed by a Solution stage (D17) is partially run on its LIVE
 * copy: runPartial swaps the definition once, up front, through
 * automationForRun({ managed: true }), and refuses (409
 * managed_part_not_deployed) when there is no live copy. Every branch below
 * reads `automation.definition` after that swap. `vars` are the automation's own
 * with the project's Solution variable values over them (stageVars.js).
 */

const automationStore = require('../../stores/automationStore');
const { buildLinearEdges } = require('./engine');
const { seedReplayState, withReplayStale } = require('./replaySeeding');
const execution = require('./execution');
const { resolveTriggerPayload } = execution;
const { automationForRun } = require('./definitionForRun');
const { runVarsFor, isManagedAutomation } = require('./stageVars');

// The init seam for what a partial run hands its synthetic to and seeds its
// replay from. Production never sets it; a test captures the synthetic here
// instead of replacing a module.
const defaultDeps = {
    executeAutomation: (...a) => execution.executeAutomation(...a),
    seedReplayState: (...a) => seedReplayState(...a),
};
let deps = defaultDeps;

/** Swap the executor / replay seeding (tests). Returns a restore function. */
function configurePartialRuns(overrides = {}) {
    const previous = deps;
    deps = { ...deps, ...overrides };
    return () => { deps = previous; };
}
const executeAutomation = (...a) => deps.executeAutomation(...a);

/**
 * Locate a step that lives inside a flowlet/layer (definition.layers[*])
 * rather than the root graph. Returns { layerKey, layer } when `stepId` is
 * one of the layer's own steps (or its layer_input trigger), else null.
 */
function findStepInLayers(def, stepId) {
    const layers = def?.layers || {};
    for (const [layerKey, layer] of Object.entries(layers)) {
        if (!layer || typeof layer !== 'object') continue;
        const hit = layer.trigger?.id === stepId
            || (Array.isArray(layer.steps) && layer.steps.some(s => s?.id === stepId));
        if (hit) return { layerKey, layer };
    }
    return null;
}

/**
 * Locate a step that lives inside a LOOP BODY.
 *
 * A loop's `body[]` holds ordinary steps that are not nodes of the root DAG. The
 * builder draws them inside the container and gives each one the runtime's own
 * namespaced id — `<loopId>/<stepId>`, nesting for a loop in a loop (see
 * flow/inlineFlowlets.js) — and the ▶ / Execute button posts exactly that. The
 * root lookup therefore never finds them, which is what answered
 * "step lp1/s4 not found in definition" on every attempt to run one.
 *
 * Returns `{ chain, prefix, localId, body }` — `chain` is the loop steps from
 * OUTERMOST to innermost, which is the order their item variables have to be
 * resolved in (an inner loop's source may be a field of the outer item).
 */
function findStepInLoopBody(def, stepId) {
    const parts = String(stepId || '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const localId = parts[parts.length - 1];
    let steps = Array.isArray(def?.steps) ? def.steps : [];
    const chain = [];
    for (const seg of parts.slice(0, -1)) {
        const owner = steps.find(s => s?.id === seg);
        if (!owner || owner.type !== 'loop') return null;   // a flowlet path → findStepInLayers
        chain.push(owner);
        steps = Array.isArray(owner.body) ? owner.body : [];
    }
    if (!steps.some(s => s?.id === localId)) return null;
    return { chain, prefix: `${parts.slice(0, -1).join('/')}/`, localId, body: steps };
}

/** Cheap heuristic: does anything in these steps bind a `loop.<var>` value? */
function _referencesLoopVar(steps) {
    try { return /\bloop\.[A-Za-z_]/.test(JSON.stringify(steps || [])); }
    catch (_) { return true; } // unstringifiable → assume it does, and say so
}

/**
 * "Execute step" / "retry from step" / "run up to here" for a node that lives
 * inside a LOOP BODY.
 *
 * A body step's whole context is the iteration it runs in, so this reconstructs
 * ONE iteration — the first — and runs the target inside it:
 *
 *   - The body becomes the top-level DAG (linear, brancher-aware: the same
 *     `buildLinearEdges` the runtime chains a real iteration with), entered from
 *     a synthetic root, so 'from'/'upTo' walk the body in the order it runs in.
 *   - `loop.<itemVar>` is seeded from the loop's own `overRef` resolved against
 *     the replayed/pinned upstream — the first item, or the first batch when the
 *     loop is batched, exactly as execLoop binds it. Nested loops are resolved
 *     outermost-first so an inner source that reads the outer item works.
 *   - Everything OUTSIDE the loop (root steps, the trigger payload) is replayed
 *     from recent live runs and current pins. It is not re-executed: a body step
 *     is one link of an iteration, and re-running the parent flow to reach it
 *     would be a different (and much more expensive) request than the one made.
 *
 * Recorded under the namespaced id the canvas asked for (`<loopId>/<stepId>`,
 * parent_step_id = the loop) so the inspector finds the row for the node the
 * user clicked, and so the root partial-run seeding keeps ignoring it (it filters
 * out rows that carry a parent).
 */
async function runPartialInLoopBody(automation, { chain, prefix, localId, body }, { mode = 'only', triggerKind = 'manual', triggerPayload = null, startedByUserId = null } = {}) {
    const def = automation.definition || {};
    const rootStepIds = new Set((def.steps || []).map(s => s?.id).filter(Boolean));
    const bodyStepIds = new Set(body.map(s => s?.id).filter(Boolean));

    const { replayState, staleFrom, runsWindow, parentRunId } = await deps.seedReplayState(
        automation.id,
        automation.version,
        (row) => {
            if (typeof row.stepId !== 'string') return null;
            if (row.parentStepId) {
                // Sub-step row. Only THIS container's own body rows (written by a
                // previous ▶ Execute in it) replay, under their bare id.
                if (!row.stepId.startsWith(prefix)) return null;
                const subId = row.stepId.slice(prefix.length);
                return bodyStepIds.has(subId) ? subId : null;
            }
            return rootStepIds.has(row.stepId) ? row.stepId : null;
        },
    );
    // Pins win over history — on the steps around the loop and inside the body.
    for (const s of [...(def.steps || []), ...body]) {
        if (s?.pinnedOutput !== undefined && s?.pinnedOutput !== null) {
            replayState[s.id] = { output: s.pinnedOutput, status: 'success' };
            delete staleFrom[s.id];
        }
    }

    // The trigger payload of the most recent real run, so a body step that binds
    // `trigger.output.*` resolves to something real rather than to undefined.
    let payload = triggerPayload;
    if (payload == null) payload = (runsWindow || []).find(r => r?.triggerPayload != null)?.triggerPayload || null;
    // Still nothing: fall back to the sample pinned on the automation's own
    // trigger, exactly as a root-level builder run does. A body step that binds
    // `trigger.output.*` is the same step whether you run it from inside the
    // loop or from the canvas root, so it must see the same payload either way.
    if (payload == null) payload = resolveTriggerPayload({ trigger: def.trigger, triggerKind, mode: 'live' });
    const runVars = await runVarsFor(automation);

    // ── rebuild the iteration ──
    const { walkPath } = require('../../automation/bind');
    const loopVars = {};
    let unresolved = null;
    for (const lp of chain) {
        const list = walkPath(lp.overRef, {
            trigger: { output: payload || {} },
            steps: replayState,
            vars: runVars,
            loop: { ...loopVars },
        });
        if (!Array.isArray(list) || list.length === 0) { unresolved = lp; break; }
        const batchSize = Math.max(1, Number(lp.batchSize) || 1);
        loopVars[lp.itemVar || 'item'] = batchSize === 1 ? list[0] : list.slice(0, batchSize);
        loopVars._index = 0;
    }
    // Running a body step with no item is running it wrong — it would fail on
    // whatever the item was supposed to fill in, and the error would point at
    // the wrong thing. Say what is actually missing instead.
    if (unresolved && _referencesLoopVar(mode === 'only' ? body.filter(s => s?.id === localId) : body)) {
        const src = unresolved.overRef || 'its source list';
        throw new Error(`This step runs once per item, and there are no items yet: ${src} has no data. Run the steps before the loop first (or pin their output), then try again.`);
    }

    const ROOT_ID = '__loop_body_root__';
    const syntheticAutomation = {
        ...automation,
        definition: {
            trigger: { id: ROOT_ID, type: 'trigger', kind: 'manual', label: 'Each item' },
            steps: body,
            edges: buildLinearEdges(body, ROOT_ID),
            // Keep flowlets called from the body resolvable, and document vars visible.
            layers: def.layers || {},
            vars: runVars,
        },
    };

    const opts = {
        triggerKind,
        triggerPayload: payload,
        mode: 'live',
        startedByUserId,
        parentRunId,
        replayState,
        loopVars,
        stepRecord: { prefix, parentStepId: prefix.slice(0, -1), suppress: false },
    };
    if (mode === 'only') {
        opts.onlyStepId = localId;
    } else if (mode === 'from') {
        opts.fromStepId = localId;
    } else if (mode === 'upTo') {
        // "Run up to here" inside a body means the body steps BEFORE the target
        // execute for real. Only their replay is dropped: the context outside the
        // loop must stay replayed, or the iteration itself can't be rebuilt.
        for (const id of bodyStepIds) { delete opts.replayState[id]; delete staleFrom[id]; }
        opts.untilStepId = localId;
    } else {
        throw new Error(`runPartial: unknown mode "${mode}" (expected 'only', 'from' or 'upTo')`);
    }

    return withReplayStale(await executeAutomation(syntheticAutomation, opts), staleFrom);
}

/**
 * "Execute step" / "retry from step" for a node that lives INSIDE a flowlet
 * (layer). A layer is a self-contained mini-definition (layer_input trigger +
 * steps + layer_output), so we run IT as the top-level DAG with `stepId` as
 * the partial-run target — the root graph never contains the node, which is
 * why the plain root lookup throws "step not found".
 *
 * Seeding mirrors the root partial run:
 *   - The layer_input (trigger.output) is filled from the inputs the most
 *     recent real run mapped into a call_layer step that targets this layer,
 *     so bindings like {{trigger.output.x}} resolve to realistic values.
 *     Falls back to {} (same as a dry-run with no payload).
 *   - The layer's own steps replay from the same REPLAY_RUN_WINDOW of prior
 *     LIVE runs the root partial run uses, accepting BOTH row shapes: the
 *     namespaced sub-step rows a full run writes ('<callStepId>/<subId>') and
 *     the BARE layer ids a previous partial run of this layer wrote. Any gap is
 *     filled live by runDag (fillMissingUpstream). Pinned outputs win.
 *
 * Modes are the root partial run's: 'only', 'from' and 'upTo' (the canvas ▶).
 *
 * The synthetic definition keeps the full `layers` map (so nested call_layer
 * still resolves) and document-level `vars`. Recorded step ids are the layer's
 * own bare ids, so the inspector finds the target step record by its id.
 */
async function runPartialInLayer(automation, { layerKey, layer }, stepId, { mode = 'only', triggerKind = 'manual', triggerPayload = null, recordPrefix = '', startedByUserId = null } = {}) {
    const def = automation.definition || {};
    const isLayerTrigger = layer.trigger?.id === stepId;
    const layerStepIds = new Set((layer.steps || []).map(s => s?.id).filter(Boolean));

    // Same REPLAY_RUN_WINDOW walk as the root partial run. This path never got
    // that fix: it still read `{limit: 1}` and accepted ONLY the namespaced
    // sub-step rows a FULL run writes ('<callStepId>/<subId>'), while its own
    // partial runs record the layer's BARE ids — so the second ▶ Execute inside
    // a flowlet lost every bit of context the first one had just produced
    // (W3-5). `stepIdFor` therefore accepts both row shapes.
    const { replayState, staleFrom, runsWindow, stepsByRun, parentRunId } = await deps.seedReplayState(
        automation.id,
        automation.version,
        (row) => {
            if (typeof row.stepId !== 'string') return null;
            if (row.parentStepId) {
                // Namespaced sub-step row from a full run.
                if (!row.stepId.includes('/')) return null;
                const subId = row.stepId.slice(row.stepId.lastIndexOf('/') + 1);
                return layerStepIds.has(subId) ? subId : null;
            }
            // Bare row from a previous partial run OF THIS LAYER. (A root step
            // sharing an id with a layer step would be picked up here too —
            // ids are unique per graph, not across graphs — but it would be
            // replaying data the author gave the same name, which is the least
            // surprising of the available answers.)
            return layerStepIds.has(row.stepId) ? row.stepId : null;
        },
    );

    // Seed the layer input. Prefer an explicit payload, else the inputs the most
    // recent run fed into a call_layer step that targets this layer.
    let layerInput = triggerPayload;
    if (layerInput == null) {
        const callStepIds = new Set(
            (def.steps || [])
                .filter(s => s?.type === 'call_layer' && s.layerKey === layerKey)
                .map(s => s.id),
        );
        for (const priorRun of runsWindow) {
            const callRec = (stepsByRun.get(priorRun.id) || []).find(s => callStepIds.has(s.stepId) && s.input != null);
            if (callRec) { layerInput = callRec.input; break; }
        }
    }
    // A pinned sample on the flowlet's own input serves the same purpose a pin
    // on a trigger does — something to run this graph against when no caller
    // supplied anything — so it is resolved through the same gate. Applied
    // before the input-only branch below so both it and the full layer run see
    // the sample; a real caller's input, replayed above, still wins.
    layerInput = resolveTriggerPayload({ trigger: layer.trigger, triggerPayload: layerInput, triggerKind, mode: 'live' });

    // Trigger-only run on the flowlet input: synthesize a run whose single
    // recorded step IS the input (its payload is its output), mirroring the
    // root trigger path. Nothing downstream to execute. 'upTo' lands here too —
    // "run up to the input" and "run the input" are the same request, exactly
    // as runPartial treats them on the root trigger.
    if (isLayerTrigger && (mode === 'only' || mode === 'upTo')) {
        const run = await automationStore.createRun({
            automationId: automation.id,
            version: automation.version,
            userId: automation.userId,
            triggerKind,
            triggerPayload: layerInput || {},
            mode: 'live',
            parentRunId,
        });
        const output = layerInput || {};
        const nowIso = new Date().toISOString();
        try {
            await automationStore.recordRunStep({
                runId: run.id,
                // Namespaced when the canvas addressed the flowlet inline, so the
                // row carries the id the node was clicked by.
                stepId: `${recordPrefix}${stepId}`,
                parentStepId: recordPrefix ? recordPrefix.slice(0, -1) : null,
                stepType: 'trigger',
                attempts: 1,
                status: 'success',
                startedAt: nowIso,
                finishedAt: nowIso,
                input: layerInput ?? null,
                output,
                error: null,
                secretValues: [],
            });
        } catch (_) { /* best-effort */ }
        await automationStore.updateRun(run.id, {
            status: 'success',
            startedAt: nowIso,
            finishedAt: nowIso,
            output,
            summary: 'Flowlet input (no downstream execution)',
        }).catch(() => {});
        return { ...run, status: 'success', output };
    }

    // Pinned outputs on the layer's steps override historical replay.
    for (const s of (layer.steps || [])) {
        if (s?.pinnedOutput !== undefined && s?.pinnedOutput !== null) {
            replayState[s.id] = { output: s.pinnedOutput, status: 'success' };
            delete staleFrom[s.id];
        }
    }

    // The layer becomes the top-level definition; keep nested flowlets
    // resolvable and document-level vars visible.
    const syntheticAutomation = {
        ...automation,
        definition: {
            ...layer,
            layers: def.layers || {},
            // The document vars (else the layer's own), with the Solution values over them.
            vars: await runVarsFor(automation, { definition: { vars: def.vars || layer.vars || {} } }),
        },
    };

    const opts = {
        triggerKind,
        triggerPayload: layerInput || {},
        mode: 'live',
        startedByUserId,
        parentRunId,
        replayState,
        // Inline-expanded flowlet: record as '<callStepId>/<subId>' (what a full
        // run writes) instead of the layer's bare ids, so the row matches the
        // node id the canvas asked to run. Null keeps the drill-in behaviour.
        stepRecord: recordPrefix ? { prefix: recordPrefix, parentStepId: recordPrefix.slice(0, -1), suppress: false } : null,
    };
    // "From the flowlet input" → run the whole layer downstream of its trigger.
    if (isLayerTrigger && mode === 'from') {
        // No partial flags — let runDag walk the full layer DAG.
    } else if (mode === 'only') {
        opts.onlyStepId = stepId;
    } else if (mode === 'from') {
        opts.fromStepId = stepId;
    } else if (mode === 'upTo') {
        // The canvas ▶ button ALWAYS sends 'upTo', so this arm not existing
        // meant every ▶ on a node inside a flowlet answered 500 "unknown mode"
        // (W3-6). Mirrors runPartial's own upTo: run the layer from its input
        // and stop after the target, seeding NO replay — the author asking to
        // run up to here wants the steps before it to actually execute, and a
        // mix of fresh and stale data looks like a real run without being one.
        // Pinned steps still serve their pin inside dispatchStep.
        delete opts.replayState;
        opts.untilStepId = stepId;
    } else {
        throw new Error(`runPartial: unknown mode "${mode}" (expected 'only', 'from' or 'upTo')`);
    }

    return withReplayStale(await executeAutomation(syntheticAutomation, opts), opts.replayState ? staleFrom : null);
}

/**
 * Run a single step (n8n "Execute step"), or a step and everything
 * downstream of it (retry-from-step). Builds the synthetic `replayState` from
 * the recent LIVE runs' recorded step rows (see seedReplayState for what counts
 * as data) so binding expressions resolve to real upstream values, and from any
 * step's `pinnedOutput` so pinned data wins over historical output.
 *
 * mode='only' → dispatch just `stepId`, then stop.
 * mode='from' → dispatch `stepId` and walk the downstream subgraph live.
 * mode='upTo' → run the flow from the trigger and stop after `stepId`.
 *
 * 'upTo' is the odd one out and deliberately so: it seeds NO replay from
 * prior runs. The author asking to "run up to here" wants the steps before
 * this one to actually execute — otherwise the result is a mix of fresh and
 * stale data that looks like a real run. Pinned steps still serve their pin
 * (dispatchStep short-circuits on `pinnedOutput`), which is exactly the
 * escape hatch for a step you don't want re-run.
 *
 * The new run is recorded as a CHILD of the most recent run when one
 * exists so audit history threads back to the run that seeded the
 * replay. With no prior run, runs from a fresh state.
 */
/**
 * Which trigger node reaches `stepId` through the root edges — the primary
 * (returned as null, the runner's "enter at the primary") when it does, else
 * the first ADDITIONAL trigger that does. A step only wired from a secondary
 * trigger used to be seeded from the primary, whose walk never reached it, so
 * "Run up to here" on it executed nothing.
 */
function rootReaching(def, stepId) {
    const edges = Array.isArray(def.edges) ? def.edges : [];
    const reaches = (fromId) => {
        const seen = new Set([fromId]);
        const queue = [fromId];
        while (queue.length) {
            const cur = queue.shift();
            if (cur === stepId) return true;
            for (const e of edges) {
                if (e && e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
            }
        }
        return false;
    };
    if (!def.trigger?.id || reaches(def.trigger.id)) return null;
    const extra = (Array.isArray(def.triggers) ? def.triggers : []).find(t => t?.id && reaches(t.id));
    return extra ? extra.id : null;
}

/**
 * The automation a partial run works on. Unmanaged: the row as given (a partial
 * run is a builder's test of the working copy, decided by executeAutomation).
 * Managed by a Solution stage (D17): its live copy with the live settings,
 * chosen HERE because every branch below reads `automation.definition`
 * directly and builds synthetics from it; throws managed_part_not_deployed
 * (409) when there is no live copy. The result carries `runsLiveVersion`, so
 * executeAutomation keeps the synthetic definitions built from it.
 */
async function forPartialRun(automation, triggerKind) {
    if (!await isManagedAutomation(automation)) return automation;
    return automationForRun(automation, { mode: 'live', triggerKind, isTest: true, managed: true });
}

// `startedByUserId` (handoff 5): the person who pressed ▶, recorded on the run.
async function runPartial(automation, stepId, { mode = 'only', triggerKind = 'manual', triggerPayload = null, rootStepId = null, startedByUserId = null } = {}) {
    if (!stepId) throw new Error('runPartial: stepId is required');
    automation = await forPartialRun(automation, triggerKind);
    const def = automation.definition || {};
    const steps = Array.isArray(def.steps) ? def.steps : [];
    // A trigger id may name the primary OR one of the additional triggers
    // (definition.triggers[]); ▶ on either enters the run through that node.
    const triggerNode = [def.trigger, ...(Array.isArray(def.triggers) ? def.triggers : [])]
        .find(t => t && t.id && t.id === stepId) || null;
    const triggerId = triggerNode?.id || null;
    const isTrigger = !!triggerNode;
    const target = isTrigger ? triggerNode : steps.find(s => s.id === stepId);
    // The root this partial run enters through: the trigger itself when the
    // target IS a trigger, the caller's choice, else whichever root reaches the
    // step. `null` means the primary.
    const root = isTrigger
        ? (triggerId === def.trigger?.id ? null : triggerId)
        : (rootStepId || rootReaching(def, stepId));
    if (!target) {
        // The step may live inside a LOOP BODY — the canvas addresses those as
        // '<loopId>/<stepId>', and they are not nodes of the root DAG.
        const inLoop = findStepInLoopBody(def, stepId);
        if (inLoop) {
            return runPartialInLoopBody(automation, inLoop, { mode, triggerKind, triggerPayload, startedByUserId });
        }
        // The step may live inside a flowlet/layer — those aren't nodes of the
        // root DAG either, so run the layer's own sub-graph with this step as
        // target. A flowlet drawn INLINE posts the namespaced id ('cl1/s3'), so
        // the bare last segment is tried too (a layer's own steps keep their bare
        // ids), and the run is then recorded under the namespace the canvas used —
        // the same '<callStepId>/<subId>' rows a full run writes.
        const localId = stepId.includes('/') ? stepId.slice(stepId.lastIndexOf('/') + 1) : stepId;
        let inLayer = findStepInLayers(def, stepId);
        let layerTargetId = stepId;
        let recordPrefix = '';
        if (!inLayer && localId !== stepId) {
            inLayer = findStepInLayers(def, localId);
            layerTargetId = localId;
            recordPrefix = stepId.slice(0, stepId.lastIndexOf('/') + 1);
        }
        if (inLayer) {
            return runPartialInLayer(automation, inLayer, layerTargetId, { mode, triggerKind, triggerPayload, recordPrefix, startedByUserId });
        }
        throw new Error(`runPartial: step ${stepId} not found in definition`);
    }

    // "Run up to here" — a plain live run of the flow that stops once this
    // step is done. No replay seeding: the point is that the steps before it
    // actually run. Pinned steps still short-circuit to their pin inside
    // dispatchStep, so pinning is how you keep one from re-running.
    if (mode === 'upTo') {
        const opts = { triggerKind, triggerPayload, mode: 'live', rootStepId: root, startedByUserId };
        // Stopping "after the trigger" is the whole flow's first step and has
        // no meaning as a partial run; treat it as the trigger-only case.
        if (!isTrigger) opts.untilStepId = stepId;
        else return runPartial(automation, stepId, { mode: 'only', triggerKind, triggerPayload, startedByUserId });
        return executeAutomation(automation, opts);
    }

    // Trigger-only run: there's nothing to execute downstream. Synthesize a
    // run with just the trigger output so the UI's "Run step" on a trigger
    // node returns a real run record (the payload IS the output).
    if (isTrigger && mode === 'only') {
        // This branch synthesizes its own run and never reaches
        // executeAutomation, so the pinned-sample rule has to be applied HERE
        // too. It is the ▶ on the trigger node — the single gesture the whole
        // feature exists for — and missing it would leave the headline case
        // showing `{}` while every other entry point had data.
        const enteredPayload = resolveTriggerPayload({ trigger: triggerNode, triggerPayload, triggerKind, mode: 'live' });
        const run = await automationStore.createRun({
            automationId: automation.id,
            version: automation.version,
            userId: automation.userId,
            triggerKind,
            triggerPayload: enteredPayload,
            mode: 'live',
            parentRunId: null,
            rootStepId: triggerId,
            startedByUserId,
        });
        const triggerOutput = enteredPayload || {};
        const nowIso = new Date().toISOString();
        try {
            await automationStore.recordRunStep({
                runId: run.id,
                stepId: triggerId,
                stepType: 'trigger',
                attempts: 1,
                status: 'success',
                startedAt: nowIso,
                finishedAt: nowIso,
                input: enteredPayload ?? null,
                output: triggerOutput,
                error: null,
                // No runState here — a trigger-only synthetic run executes no
                // steps, so no secret bridge can have populated any secrets.
                secretValues: [],
            });
        } catch (_) { /* recordRunStep is best-effort here */ }
        await automationStore.updateRun(run.id, {
            status: 'success',
            startedAt: nowIso,
            finishedAt: nowIso,
            output: triggerOutput,
            summary: 'Trigger step (no downstream execution)',
        }).catch(() => {});
        return { ...run, status: 'success', output: triggerOutput };
    }

    // Seed replay from RECENT prior LIVE runs' persisted step rows — the most
    // recent run that has anything to say about a step decides it. Bindings
    // like {{steps.stepA.output.field}} need real values to resolve. Any
    // upstream step NOT covered here (no prior run, no pin, or only rows that
    // aren't data) is executed live by runDag (fillMissingUpstream) so the
    // target still gets real inputs rather than undefined. See seedReplayState
    // for what counts as data and why.
    const { replayState, staleFrom, parentRunId } = await deps.seedReplayState(
        automation.id,
        automation.version,
        // Layer sub-steps are recorded under namespaced ids ('cl1/out') that
        // aren't parent-graph nodes. A partial run that hits a call_layer step
        // re-runs the whole layer.
        (row) => (row.parentStepId ? null : row.stepId),
    );
    // Pinned outputs override historical replay so the user's "Pin" wins.
    for (const s of steps) {
        if (s.pinnedOutput !== undefined && s.pinnedOutput !== null) {
            replayState[s.id] = { output: s.pinnedOutput, status: 'success' };
            delete staleFrom[s.id];
        }
    }

    const opts = {
        triggerKind,
        triggerPayload,
        mode: 'live',
        // Lineage points at the most recent prior run (the replay window is
        // wider, but parentage stays single-parent).
        parentRunId,
        replayState,
        rootStepId: root,
        startedByUserId,
    };
    // "From trigger" → run the whole automation downstream of the trigger.
    // Treating it as a normal run (no fromStepId/onlyStepId) is the cleanest
    // way to do this and matches the user's intent of "execute from here".
    if (isTrigger && mode === 'from') {
        // No partial-execution flags — let runDag walk the full DAG.
    } else if (mode === 'only') {
        opts.onlyStepId = stepId;
    } else if (mode === 'from') {
        opts.fromStepId = stepId;
    } else {
        throw new Error(`runPartial: unknown mode "${mode}" (expected 'only' or 'from')`);
    }

    return withReplayStale(await executeAutomation(automation, opts), staleFrom);
}

module.exports = { runPartial, configurePartialRuns };
