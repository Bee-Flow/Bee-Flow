/**
 * The DAG walker (extracted verbatim from engine.js): fan-in gating,
 * replay/partial-run routing, brancher label resolution and per-step
 * recording. Leaf relative to the executors — dispatchStep is passed in.
 *
 * Split by phase: the graph bookkeeping (reachability, the fan-in gate,
 * ancestor/descendant sets, dequeue order) lives in runDagGraph.js and the
 * live dispatch + run-step recording in runDagRecord.js. This file holds the
 * walk itself: replay-vs-live per step, and where the walk goes next.
 */

const {
    buildAdjacency, effectiveEdgeLabel, nextEdgesFor,
    BRANCHER_TYPES, TERMINAL_STEP_TYPES, LOOP_ROOT_ID, PARALLEL_ROOT_ID,
} = require('./shared');
const { replayGapError } = require('./replayGaps');
const { reachableFrom, createFanInGate, ancestorsOf, descendantsOf, createTakeNext } = require('./runDagGraph');
const { dispatchLiveStep } = require('./runDagRecord');

/**
 * Resume / partial-execution flags:
 *   - skipUntilStepId: replay all steps up to AND INCLUDING this id,
 *     then dispatch live. Used by approval-resume.
 *   - fromStepId: replay all steps before this id, then dispatch this
 *     step and everything downstream live. Used by retry-from-step.
 *   - onlyStepId: replay all steps before this id, dispatch only this
 *     step, then stop. Used by "Execute Step" (n8n-style single-node run).
 *   - untilStepId: no replay at all — run the DAG normally from the
 *     trigger and stop once this step has been dispatched. Used by
 *     "Run up to here": the author wants everything BEFORE the step to
 *     actually execute (pinned steps still serve their pin, which
 *     dispatchStep handles), not to be replayed from an old run.
 *
 * `stillSkipping` is the one mutable field: a purely TEMPORAL flag the walk
 * flips off once it passes the resumption point.
 */
function buildPartialPlan({ skipUntilStepId, fromStepId, onlyStepId, untilStepId }, { adj, incoming, reachable }) {
    // Partial runs (Execute-step / retry-from-here) reuse a cached or pinned
    // upstream output when one exists, but EXECUTE a prerequisite live when it
    // has none — so a single-node run still gets real inputs even if that
    // upstream node has never run. Approval-resume (skipUntilStepId) keeps
    // strict replay: its runState already holds every step up to the pause.
    const fillMissingUpstream = !!(onlyStepId || fromStepId);
    const partialTargetId = onlyStepId || fromStepId || null;
    return {
        skipUntilStepId, fromStepId, onlyStepId, untilStepId,
        stillSkipping: !!(skipUntilStepId || fromStepId || onlyStepId),
        fillMissingUpstream,
        partialTargetId,
        // Which nodes may be "filled in" live (see runDagGraph.ancestorsOf).
        fillAncestors: (fillMissingUpstream && partialTargetId) ? ancestorsOf(incoming, partialTargetId, reachable) : null,
        // Which nodes the live tail of a retry-from-step may contain
        // (see runDagGraph.descendantsOf).
        fromDescendants: fromStepId ? descendantsOf(adj, fromStepId) : null,
        // Only plain forward walks reorder waits last (see runDagGraph.createTakeNext).
        deferWaits: !skipUntilStepId && !fromStepId && !onlyStepId && !untilStepId,
    };
}

/**
 * Replay vs live for a step inside the skip phase: replay (reuse runState)
 * only when there's a cached/pinned output for it. Otherwise, on a partial
 * run, fall through to live dispatch so the missing upstream actually
 * executes and feeds the target real data.
 */
function replayDecision(step, id, triggerId, runState, plan) {
    const isTargetForFrom = !!(plan.fromStepId && step.id === plan.fromStepId);
    const isTargetForOnly = !!(plan.onlyStepId && step.id === plan.onlyStepId);
    const replayedEntry = (id !== triggerId) ? runState.steps?.[step.id] : null;
    const hasReplayData = !!replayedEntry
        && (replayedEntry.output != null || replayedEntry.status === 'handled_error');
    // A node with no replay data falls through to LIVE dispatch only when
    // it is a prerequisite of the partial target (see fillAncestors). Every
    // other node stays on the replay/no-op path, where the worst it can do
    // is contribute nothing.
    const mayFillLive = plan.fillMissingUpstream && (!plan.fillAncestors || plan.fillAncestors.has(step.id));
    // Past the retry-from-step target, only its descendants are live work;
    // anything else the walk still reaches belongs to another branch and
    // stays on the replay/no-op path (see fromDescendants).
    const outsideLiveTail = !!plan.fromDescendants && !plan.stillSkipping && !plan.fromDescendants.has(step.id);
    const replaying = (plan.stillSkipping || outsideLiveTail) && !isTargetForFrom && !isTargetForOnly
        && (hasReplayData || !mayFillLive);
    return { replaying, replayedEntry, hasReplayData, isTargetForFrom, isTargetForOnly };
}

/**
 * Replay path — outputs already in runState.steps; honour condition
 * branching so the resumed traversal follows the same edge that the
 * original run did. Returns `{ nextLabel, branchOutput }`.
 */
function replayRoute(step, { replayedEntry, hasReplayData }, { adj, replayGaps, pushRunWarning }) {
    // A resume that has NO output for a step a later step reads —
    // its history row was truncated and no full copy was kept — must
    // not replay the hole: every binding on it would resolve to
    // nothing and the run would finish green (BFSF-435). It must not
    // re-dispatch the step either, so it stops here, saying why.
    if (!hasReplayData && replayGaps?.has(step.id)) {
        throw replayGapError(step.id, replayGaps.get(step.id));
    }
    const replayed = replayedEntry?.output;
    if (replayedEntry?.status === 'handled_error') {
        // The original run failed this step into its error branch —
        // the replay must keep routing along 'on_error'. Following
        // the default on_success here would walk a path the original
        // run never took (and whose bindings were never produced).
        // Except when there IS no error branch: then the original run
        // carried on past the failure (runPolicy.retry.then
        // 'continue'), and so must the replay.
        const wiredErrorBranch = (adj.get(step.id) || []).some(e => effectiveEdgeLabel(e) === 'on_error');
        return { nextLabel: wiredErrorBranch ? 'on_error' : 'on_success', branchOutput: null };
    }
    // A replay must NOT re-scan: a guard's detector is not
    // deterministic across model versions, and a replay that took
    // the other branch would rewrite history rather than reproduce
    // it. So the branch label has to come out of the recorded
    // output.
    let nextLabel = null;
    if (BRANCHER_TYPES.has(step.type)) {
        if (replayed && replayed.branch) nextLabel = replayed.branch;
        else {
            // No recorded label. This used to throw and abort the
            // whole resume — but a PINNED brancher never records
            // one (the pin IS the output), and pinning is the
            // documented escape hatch for a slow step, so an
            // approval sitting behind a pinned If could never be
            // completed (W5-14). Fall through with no label
            // instead: 'on_success' matches no then/else/case:*
            // edge, so this path simply ends here — a dead end, not
            // a dead run — and the breadcrumb says why.
            pushRunWarning(
                `${step.type} ${step.id} was replayed without a recorded branch — nothing downstream of it ran`,
            );
        }
    }
    return { nextLabel, branchOutput: replayed || null };
}

/**
 * The edges a step that ran (or was replayed) routes along for `nextLabel`,
 * including the collection-mode switch union and the switch default-port
 * rescue.
 */
function routeOutEdges(step, adj, nextLabel, branchOutput) {
    const id = step.id;
    let outEdges = nextEdgesFor(id, adj, nextLabel);
    // Collection-mode switch (user feature): every case with matching
    // rows fires — follow the UNION of all active branches' edges. The
    // fan-in gate handles multiple taken edges natively.
    if (step.type === 'switch' && Array.isArray(branchOutput?.branches) && branchOutput.branches.length) {
        const seenEdge = new Set();
        outEdges = branchOutput.branches
            .flatMap(label => nextEdgesFor(id, adj, label))
            .filter(e => {
                const k = `${e.from}->${e.to}|${e.label || ''}|${e.caseName ?? ''}`;
                if (seenEdge.has(k)) return false;
                seenEdge.add(k);
                return true;
            });
    }
    // Switch default-port rescue (A4/A5): when DEFAULT routing (nothing
    // matched, or a defaultBranch redirect) lands on a case with no
    // outgoing edge, fall back to a wired `case:default` port — that is
    // the recovery the user wired for. A MATCHED-but-unwired declared
    // case stays a deliberate dead end (n8n semantics, and what
    // `switch.partial_branches` already warns about).
    if (step.type === 'switch' && nextLabel !== 'case:default') {
        const scalarDeadEnd = outEdges.length === 0
            && (branchOutput?.viaDefault || branchOutput?.matched == null);
        // Collection mode needs its own test (W4-12): the unmatched rows
        // were redirected into `defaultBranch`, and when THAT case carries
        // no edge the rows are dropped — but other cases may have fired, so
        // the union above is non-empty and the scalar test never sees the
        // dead port.
        const redirectDeadEnd = !!branchOutput?.viaDefault && Array.isArray(branchOutput?.branches)
            && !!step.defaultBranch
            && nextEdgesFor(id, adj, `case:${step.defaultBranch}`).length === 0;
        if (scalarDeadEnd || redirectDeadEnd) {
            const dflt = nextEdgesFor(id, adj, 'case:default');
            // `case:default` can't already be in the union when viaDefault
            // is set (the rows went to the named case instead), so this
            // never double-walks an edge.
            if (dflt.length) outEdges = outEdges.length ? [...outEdges, ...dflt] : dflt;
        }
    }
    return outEdges;
}

/**
 * A step whose chosen branch has no edge while OTHER edges leave it ends
 * the walk here by design — but silently. Leave a breadcrumb the run report
 * surfaces.
 *
 * This fired for `switch` only, so the other ways to reach the same dead end
 * went unreported: a guard's 'else', and — the one that made it a bug rather
 * than a gap — a DISABLED brancher, which used to route on the fallback
 * 'on_success' label that matches none of a then/else/case:* wiring, ending
 * the run green with nothing after it executed and no warning anywhere
 * (W4-11).
 *
 * Two carve-outs keep it from crying wolf:
 *   - a synthesized linear body (loop / parallel branch), where "no edge for
 *     this label" IS the designed exit of the iteration;
 *   - a step that SUCCEEDED and whose only remaining edge is on_error, which
 *     is a flow saying "if this fails, do that" and nothing more.
 * And it is deduplicated, because a loop body would otherwise push one copy
 * per iteration.
 */
function warnDeadEnds(step, adj, nextLabel, outEdges, { isSynthesizedBody, pushRunWarning }) {
    if (outEdges.length === 0 && !isSynthesizedBody) {
        const allOut = adj.get(step.id) || [];
        const relevant = nextLabel === 'on_error'
            ? allOut
            : allOut.filter(e => effectiveEdgeLabel(e) !== 'on_error');
        if (relevant.length > 0) {
            pushRunWarning(
                `${step.type} ${step.id} routed to "${nextLabel}" but no edge carries that branch — downstream steps did not run`,
            );
        }
    }
    // A guard that FOUND something and has nowhere to send it is the one
    // silent ending worth calling out: the whole point of the step is the
    // alert on the other end of that branch, and the run would otherwise
    // finish green having quietly dropped the finding.
    if (step.type === 'guard' && outEdges.length === 0 && nextLabel === 'then') {
        pushRunWarning(
            `guard ${step.id} found personal data but nothing is wired to its "personal data" branch — no alert was sent`,
        );
    }
}

// The partial target was never dequeued — the walk from the trigger simply
// never got there (the node is unwired, or it sits behind a branch this run
// did not take). The only termination the loop has is the `break` after the
// target dispatches, so until now that ended as a run reporting SUCCESS
// having executed nothing at all: the user clicks ▶ Execute, gets a green
// tick and no output, and nothing anywhere says why (W3-7). Fail loudly so
// the route can answer 4xx instead of a green no-op.
function assertPartialTargetReached(partialTargetId, visited) {
    if (partialTargetId && !visited.has(partialTargetId)) {
        const err = new Error(
            `Step ${partialTargetId} was never reached from the trigger — connect it to the flow (or run the branch that leads to it) before executing it.`,
        );
        Object.assign(err, { errorClass: 'partial_target_unreachable' });
        throw err;
    }
}

// ── Core DAG run ────────────────────────────────────────

async function runDag(def, ctx, runStateInit, mode, dispatchStep, { recordSteps = true, branchIndex = null, skipUntilStepId = null, onlyStepId = null, fromStepId = null, untilStepId = null, rootStepId = null, replayGaps = null } = {}) {
    const { adj, incoming, stepById } = buildAdjacency(def);
    const runState = runStateInit;
    // rootStepId lets a caller seed the walk from a SPECIFIC trigger id
    // (webhook/app-event dispatch targeting one of definition.triggers[])
    // instead of the primary def.trigger.id — every existing call site omits
    // it and gets today's exact behavior.
    const triggerId = rootStepId || def.trigger?.id;
    if (!triggerId) throw new Error('Definition has no trigger.');
    // A loop body / parallel branch is a synthesized LINEAR chain, not a graph
    // the author drew: "this label has no edge" is how an iteration is meant to
    // end there, so the dead-end breadcrumbs below stay quiet for it.
    const isSynthesizedBody = triggerId === LOOP_ROOT_ID || triggerId === PARALLEL_ROOT_ID;
    // Deduplicated: loop bodies share the parent's `_templateWarnings` array by
    // reference, so an un-deduped push would append one copy per iteration.
    const pushRunWarning = (msg) => {
        const list = runState._templateWarnings;
        if (Array.isArray(list) && !list.includes(msg)) list.push(msg);
    };

    const reachable = reachableFrom(adj, triggerId);
    const { queue, visited, advance } = createFanInGate(adj, incoming, reachable, triggerId);
    const plan = buildPartialPlan({ skipUntilStepId, fromStepId, onlyStepId, untilStepId }, { adj, incoming, reachable });
    const takeNext = createTakeNext(queue, stepById, plan.deferWaits);
    const live = { ctx, runState, mode, dispatchStep, adj, recordSteps, branchIndex };
    let lastOutput = null;

    while (queue.length > 0) {
        const id = takeNext();
        if (visited.has(id)) continue;
        visited.add(id);
        const step = stepById.get(id);
        if (!step) continue;

        const decision = replayDecision(step, id, triggerId, runState, plan);
        // nextLabel: for condition branching. branchOutput: the brancher's own
        // output — needed by the switch default-port fallback, which runs on
        // the SHARED tail of both the live and replay paths.
        let route;
        if (id === triggerId) {
            // Trigger output is already in runState.trigger.output
            route = { nextLabel: null, branchOutput: null };
        } else if (decision.replaying) {
            route = replayRoute(step, decision, { adj, replayGaps, pushRunWarning });
            if (step.id === skipUntilStepId) plan.stillSkipping = false;
        } else {
            // Live dispatch. fromStepId/onlyStepId targets break us out of
            // the skip block; their dispatch is the resumption point.
            if (decision.isTargetForFrom || decision.isTargetForOnly) plan.stillSkipping = false;
            route = await dispatchLiveStep(step, live);
            if (route.handledEdges) {
                advance(id, route.handledEdges);
                continue;
            }
            // A Wait is never a run's answer — `{ waitedSeconds: 120 }` is
            // bookkeeping, not a result. It only became a candidate for
            // "last output" because deferring it (above) makes it the last
            // thing dispatched in a fan-out, so skip it here and keep this in
            // step with the three consumers that derive the same value from
            // the persisted rows (appStudio/actionExecutor/automationBridge's
            // deriveFinalOutput and core/tools/skillInjection), which skip it
            // too. A loop body or layer whose ONLY step is a wait now yields
            // null instead of `{ waitedSeconds }` — that is the intended
            // reading of "this iteration produced nothing".
            if (step.type !== 'wait') lastOutput = route.dispatched.output;
            // onlyStepId terminates the walk after dispatching the target.
            if (decision.isTargetForOnly) break;
        }

        // untilStepId stops here too — but AFTER the replay branch as well as
        // the live one, so a pinned or replayed target still ends the walk.
        if (untilStepId && step.id === untilStepId) break;

        // ── THE RUNNER'S NOTION OF "TERMINAL" ────────────────────────────
        // Until P4 the walk had none. `stop_error` ended a run only because it
        // THROWS, and `layer_output` only because by convention nothing was
        // wired after it — so a step that must end the run SUCCESSFULLY had no
        // mechanism at all: throwing turns the run red, and doing nothing lets
        // the walk carry on as soon as someone draws an edge. The validator
        // does warn about that (`edge.after_terminal`), but a warning blocks
        // nothing and an imported or hand-written definition gets past it.
        //
        // So here it is real: after a terminal step the walk does not go on —
        // in every graph (root, loop body, flowlet), along the LIVE and the
        // REPLAY path, since both fall through here. The same `break` that
        // onlyStepId/untilStepId use, so the check after the loop
        // (partialTargetId) keeps running unchanged.
        //
        // For `stop_error` this changes nothing: it already throws before the
        // walk gets here. It is in the set because the set must give one
        // answer to "which steps end a run" — not because it needs this line.
        if (TERMINAL_STEP_TYPES.has(step.type)) break;

        // Default success-path: when no branching override fired, treat
        // the step as having succeeded so 'on_success'-labelled edges
        // route correctly (unlabeled edges still match — see nextEdgesFor).
        const nextLabel = route.nextLabel ?? 'on_success';
        const outEdges = routeOutEdges(step, adj, nextLabel, route.branchOutput);
        warnDeadEnds(step, adj, nextLabel, outEdges, { isSynthesizedBody, pushRunWarning });
        advance(id, outEdges);
    }

    assertPartialTargetReached(plan.partialTargetId, visited);
    return { lastOutput };
}

module.exports = { runDag };

/** @typedef {import('./runDagGraph').DagEdge} DagEdge */

/** @typedef {import('./runDagGraph').EdgeMap} EdgeMap */

/** @typedef {import('./runDagRecord').DagStep} DagStep */

/** @typedef {import('./runDagRecord').DagCtx} DagCtx */

/** @typedef {import('./runDagRecord').DagRunState} DagRunState */

/** @typedef {import('./runDagRecord').DagStepEntry} DagStepEntry */

/** @typedef {import('./runDagRecord').StepOutput} StepOutput */

/** @typedef {import('./runDagRecord').DispatchStep} DispatchStep */

/** @typedef {ReturnType<typeof buildPartialPlan>} PartialPlan */

/** @typedef {(msg: string) => void} PushRunWarning */
