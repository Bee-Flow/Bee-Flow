/**
 * The DAG walker (extracted verbatim from engine.js): fan-in gating,
 * replay/partial-run routing, brancher label resolution and per-step
 * recording. Leaf relative to the executors — dispatchStep is passed in.
 */

const automationStore = require('../../stores/automationStore');
const { classifyUnknownError } = require('../automationErrors');
const safety = require('./safety');
const {
    cloneRunValue, secretValuesFor,
    buildAdjacency, effectiveEdgeLabel, nextEdgesFor,
    BRANCHER_TYPES, TERMINAL_STEP_TYPES, LOOP_ROOT_ID, PARALLEL_ROOT_ID, PII_RESCAN_EXEMPT_TYPES,
} = require('./shared');
const { isRunPause } = require('./execApproval');
const { replayGapError } = require('./replayGaps');
const { runWarning, pushRunWarning: pushStructuredWarning } = require('./runWarnings');

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
    // Each is a structured warning (runWarnings.js): a code the run view
    // words, the step it is about, and the English as the fallback.
    const pushRunWarning = (code, params, text) => pushStructuredWarning(runState, runWarning(code, params, text));

    const visited = new Set();
    let queue = [triggerId];
    let lastOutput = null;

    // Fan-in (join) gating: a step with multiple incoming edges must not
    // dispatch until every one of those edges has been resolved — either
    // taken (its source ran and routed here) or proven dead (its source
    // routed elsewhere, e.g. the untaken branch of a condition/switch, or
    // failed with no on_error edge to walk). Without this, a join fed by
    // branches of unequal depth fires as soon as the SHORTER branch's edge
    // lands in the queue, using only that branch's data — the longer
    // branch's remaining steps may still be several turns away in the FIFO
    // queue and haven't run yet.
    // Only edges whose SOURCE is reachable from the seeded root can ever be
    // taken or resolved. Counting every edge in the definition deadlocked any
    // step wired from BOTH the primary trigger and a secondary
    // (webhook/app-event) trigger: a run seeded from one trigger never
    // dispatches the other, so the other's edge into the shared step never
    // resolved, the count stuck at ≥1, and the run drained to a "success"
    // with zero steps executed (node-audit C2). Single-root definitions are
    // unaffected — everything is reachable from the sole root.
    const reachable = new Set([triggerId]);
    {
        const bfs = [triggerId];
        while (bfs.length) {
            const n = bfs.pop();
            for (const e of (adj.get(n) || [])) {
                if (!reachable.has(e.to)) { reachable.add(e.to); bfs.push(e.to); }
            }
        }
    }
    const pendingIncoming = new Map();
    for (const [to, edges] of incoming) {
        pendingIncoming.set(to, edges.filter(e => reachable.has(e.from)).length);
    }
    const arrivedVia = new Set(); // targets reached by at least one taken edge
    const queued = new Set([triggerId]);
    const deadNodes = new Set(); // proven-dead: every incoming edge resolved, none taken
    // Resolve every static outgoing edge of `id` — decrementing each
    // target's pending-predecessor count regardless of whether the edge
    // was actually taken this run, and enqueuing a target once it has
    // both (a) arrived via a taken edge and (b) no predecessors left
    // pending. Nodes with a single incoming edge behave exactly as
    // before (pendingIncoming starts at 1, taken edge brings it to 0
    // immediately).
    //
    // Worklist with dead-branch CASCADE: when a target's count reaches 0 and
    // no taken edge ever arrived, the target is provably dead — it will never
    // dispatch, so its own outgoing edges must resolve too, or a join two or
    // more levels below a dead branch would deadlock the same way the
    // multi-trigger case did (dead-ness has to propagate through never-
    // dispatched nodes, which otherwise never call advance).
    const advance = (id, takenEdges) => {
        const work = [[id, new Set(takenEdges)]];
        while (work.length) {
            const [nid, takenSet] = work.shift();
            const allOut = adj.get(nid) || [];
            for (const e of allOut) {
                if (pendingIncoming.has(e.to)) pendingIncoming.set(e.to, pendingIncoming.get(e.to) - 1);
                if (takenSet.has(e)) arrivedVia.add(e.to);
            }
            for (const e of allOut) {
                const to = e.to;
                if (queued.has(to) || visited.has(to) || deadNodes.has(to)) continue;
                if ((pendingIncoming.get(to) ?? 0) > 0) continue;
                if (arrivedVia.has(to)) {
                    queued.add(to);
                    queue.push(to);
                } else {
                    deadNodes.add(to);
                    work.push([to, new Set()]); // cascade: resolve ITS outgoing edges as not-taken
                }
            }
        }
    };

    // Resume / partial-execution flags:
    //   - skipUntilStepId: replay all steps up to AND INCLUDING this id,
    //     then dispatch live. Used by approval-resume.
    //   - fromStepId: replay all steps before this id, then dispatch this
    //     step and everything downstream live. Used by retry-from-step.
    //   - onlyStepId: replay all steps before this id, dispatch only this
    //     step, then stop. Used by "Execute Step" (n8n-style single-node run).
    //   - untilStepId: no replay at all — run the DAG normally from the
    //     trigger and stop once this step has been dispatched. Used by
    //     "Run up to here": the author wants everything BEFORE the step to
    //     actually execute (pinned steps still serve their pin, which
    //     dispatchStep handles), not to be replayed from an old run.
    let stillSkipping = !!(skipUntilStepId || fromStepId || onlyStepId);
    // Partial runs (Execute-step / retry-from-here) reuse a cached or pinned
    // upstream output when one exists, but EXECUTE a prerequisite live when it
    // has none — so a single-node run still gets real inputs even if that
    // upstream node has never run. Approval-resume (skipUntilStepId) keeps
    // strict replay: its runState already holds every step up to the pause.
    const fillMissingUpstream = !!(onlyStepId || fromStepId);
    const partialTargetId = onlyStepId || fromStepId || null;

    // Which nodes may be "filled in" live — the ANCESTORS of the partial
    // target, and nothing else.
    //
    // This used to have no ancestry test at all: the predicate below was built
    // from `stillSkipping`, a purely TEMPORAL flag that is true for every node
    // the FIFO walk dequeues before it reaches the target. runDag walks the
    // whole graph from the trigger, so a replay-less node on a completely
    // unrelated branch — dequeued early simply because it sits close to the
    // root — was dispatched FOR REAL, in live mode, with its full side effect.
    // Clicking ▶ Execute on one node sent an invoice email from a sibling
    // branch (W3-4). A prerequisite is an ancestor; nothing else is, so nothing
    // else may dispatch.
    const fillAncestors = (fillMissingUpstream && partialTargetId) ? new Set() : null;
    if (fillAncestors) {
        const rev = [partialTargetId];
        while (rev.length) {
            const n = rev.pop();
            for (const e of (incoming.get(n) || [])) {
                // Only nodes this run can actually reach from its seeded root:
                // an edge from an unreachable alternate trigger is not a
                // prerequisite of anything in THIS run.
                if (!reachable.has(e.from) || fillAncestors.has(e.from)) continue;
                fillAncestors.add(e.from);
                rev.push(e.from);
            }
        }
    }

    // Which nodes the LIVE TAIL of a retry-from-step may contain — the
    // DESCENDANTS of the target, and nothing else.
    //
    // The mirror image of fillAncestors, and the other half of W3-4. Once the
    // `fromStepId` target is dispatched, `stillSkipping` flips off, and from
    // that moment every node the FIFO queue yields took the LIVE branch —
    // regardless of replay data and regardless of ancestry. A sibling branch
    // that merely sits at or below the target's BFS depth (or is pushed onto
    // the queue after it) was therefore re-executed for real on every "retry
    // from step": the invoice email W3-4 fixed on the upstream side went out
    // again from the downstream side. "Everything downstream" is what the
    // button promises, so descendants — and only descendants — dispatch.
    //
    // Not applied to skipUntilStepId: an approval resume is the continuation
    // of ONE run, and everything after the gate is legitimately still to do,
    // whatever branch it sits on.
    const fromDescendants = fromStepId ? new Set() : null;
    if (fromDescendants) {
        const fwd = [fromStepId];
        while (fwd.length) {
            const n = fwd.pop();
            for (const e of (adj.get(n) || [])) {
                if (fromDescendants.has(e.to)) continue;
                fromDescendants.add(e.to);
                fwd.push(e.to);
            }
        }
    }

    // Dequeue order: runnable-first, waits LAST (BFSF-371).
    //
    // The walk has a single FIFO cursor and `dispatchStep` is awaited inline,
    // so whatever is at the head of the queue owns the runner until it
    // returns. `wait` is the one step type that is pure dead time: it produces
    // nothing any sibling branch could need, it just sleeps in-process (see
    // execControl.execWait — up to 24 hours). Put it at the head of a fan-out
    // and every other branch sits behind the sleep, one node deep. On
    //   split ─then→ a1 → a2 → a3
    //   split ─then→ w  → b2
    // the FIFO order is split, a1, w, a2, b2, a3 — exactly one node of branch A
    // gets ahead of the sleep and the rest of the workflow waits it out, which
    // is what users report as "one Wait pauses the whole routine".
    //
    // So: take any other runnable node first, and take a wait only when it is
    // the only thing left. Independent branches then drain to completion and
    // the sleep happens once, at the end, with nothing else pending.
    //
    // This is a SCHEDULING change, not a semantic one. Everything the walker
    // decides — `visited`, the fan-in counters in `pendingIncoming`, the
    // `arrivedVia`/`deadNodes` bookkeeping and its cascade, the
    // `partialTargetId` reachability check — is keyed on MEMBERSHIP, never on
    // the order nodes come off the queue. `queued` is never cleared, so the
    // queue holds no duplicates and every node is still dequeued exactly once.
    //
    // …with one exception, which is why this is gated. `stillSkipping` is a
    // purely TEMPORAL flag (see the comment at its declaration): during a
    // replay it decides, per dequeue, whether a step is re-played or dispatched
    // FOR REAL. Within a single process the reorder is self-consistent — the
    // queue evolution is a deterministic function of the graph plus the
    // recorded branch labels, so a step is never both replayed and re-run. The
    // hazard is a run that PAUSED on the old order and RESUMES on the new one:
    // mixing the two could flip a wait from "already replayed" to "dispatch
    // live" and re-sleep it, up to 24h, with a human watching. Costs nothing to
    // close, so: only plain forward walks reorder. BFSF-371 only ever shows up
    // on those anyway.
    const deferWaits = !skipUntilStepId && !fromStepId && !onlyStepId && !untilStepId;
    const takeNext = () => {
        if (!deferWaits) return queue.shift();
        // A DISABLED wait never sleeps, so there is nothing to defer — and
        // deferring it would needlessly make it the last step of the run.
        // `stepById.get()` is undefined for the synthesized roots
        // (__loop_root__/__parallel_root__); `?.type !== 'wait'` picks them up
        // harmlessly.
        const i = queue.findIndex(nid => { const s = stepById.get(nid); return !(s?.type === 'wait' && !s.disabled); });
        // -1 means every queued node is an enabled wait — take the head, which
        // is the FIFO behaviour. The `while` guard makes index 0 safe.
        return queue.splice(i === -1 ? 0 : i, 1)[0];
    };

    while (queue.length > 0) {
        const id = takeNext();
        if (visited.has(id)) continue;
        visited.add(id);
        const step = stepById.get(id);
        if (!step) continue;

        const isTargetForFrom = !!(fromStepId && step.id === fromStepId);
        const isTargetForOnly = !!(onlyStepId && step.id === onlyStepId);

        // Replay vs live for a step inside the skip phase: replay (reuse
        // runState) only when there's a cached/pinned output for it.
        // Otherwise, on a partial run, fall through to live dispatch so the
        // missing upstream actually executes and feeds the target real data.
        const replayedEntry = (id !== triggerId) ? runState.steps?.[step.id] : null;
        const hasReplayData = !!replayedEntry
            && (replayedEntry.output != null || replayedEntry.status === 'handled_error');
        // A node with no replay data falls through to LIVE dispatch only when
        // it is a prerequisite of the partial target (see fillAncestors). Every
        // other node stays on the replay/no-op path, where the worst it can do
        // is contribute nothing.
        const mayFillLive = fillMissingUpstream && (!fillAncestors || fillAncestors.has(step.id));
        // Past the retry-from-step target, only its descendants are live work;
        // anything else the walk still reaches belongs to another branch and
        // stays on the replay/no-op path (see fromDescendants).
        const outsideLiveTail = !!fromDescendants && !stillSkipping && !fromDescendants.has(step.id);
        const replaying = (stillSkipping || outsideLiveTail) && !isTargetForFrom && !isTargetForOnly
            && (hasReplayData || !mayFillLive);

        let nextLabel = null; // for condition branching
        // The brancher's own output — needed by the switch default-port
        // fallback below, which runs on the SHARED tail of both the live and
        // replay paths (`dispatched` is scoped to the live branch only).
        let branchOutput = null;
        if (id === triggerId) {
            // Trigger output is already in runState.trigger.output
            nextLabel = null;
        } else if (replaying) {
            // Replay path — outputs already in runState.steps; honour
            // condition branching so the resumed traversal follows the
            // same edge that the original run did. If a condition/switch
            // step is replayed without a `branch` marker, we'd fall back
            // to following *every* outgoing edge — fail loudly instead.
            //
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
                const wiredErrorBranch = (adj.get(id) || []).some(e => effectiveEdgeLabel(e) === 'on_error');
                nextLabel = wiredErrorBranch ? 'on_error' : 'on_success';
            } else {
                // A replay must NOT re-scan: a guard's detector is not
                // deterministic across model versions, and a replay that took
                // the other branch would rewrite history rather than reproduce
                // it. So the branch label has to come out of the recorded
                // output.
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
                            'branch_replayed_unrecorded',
                            { stepType: step.type, step: step.id },
                            `${step.type} ${step.id} was replayed without a recorded branch — nothing downstream of it ran`,
                        );
                    }
                }
                branchOutput = replayed || null;
            }
            if (step.id === skipUntilStepId) stillSkipping = false;
        } else {
            // Live dispatch. fromStepId/onlyStepId targets break us out of
            // the skip block; their dispatch is the resumption point.
            if (isTargetForFrom || isTargetForOnly) stillSkipping = false;
            let dispatched;
            if (recordSteps && ctx.runId && !ctx.stepRecord?.suppress) {
                const recordedId = (ctx.stepRecord?.prefix || '') + step.id;
                ctx.emitLifecycle?.('step.started', { stepId: recordedId, stepType: step.type });
                // A row for the step that is RUNNING, not only for the ones
                // that finished. Until now a step in flight left no trace at
                // all, so anything asking "where is this run right now" — a
                // public form page sitting on a spinner while the routine
                // works — had nothing to answer with. Upserted on
                // (run_id, step_id, attempts), so the real row replaces this
                // one the moment the step lands; a retry's attempts=1 'error'
                // row replaces it the same way. Awaited rather than
                // fire-and-forget: a step that finishes in under a
                // round-trip would otherwise land BEFORE its own start row
                // and leave a 'running' row behind it forever.
                await automationStore.recordRunStep({
                    runId: ctx.runId,
                    stepId: recordedId,
                    parentStepId: ctx.stepRecord?.parentStepId || null,
                    stepType: step.type,
                    attempts: 1,
                    status: 'running',
                    startedAt: new Date().toISOString(),
                    finishedAt: null,
                    input: null,
                    output: null,
                    error: null,
                    branchIndex,
                }).catch(() => { /* progress is a nicety; never fail a run on it */ });
            }
            try {
                dispatched = await dispatchStep(step, ctx, runState, mode);
            } catch (stepErr) {
                // §19: native error-edge routing. If the step has an
                // explicit 'on_error' outgoing edge, treat the failure
                // as a recoverable branch — record the failed step, route
                // execution along on_error, and keep walking. Otherwise
                // bubble up (preserve legacy fail-the-run behavior).
                //
                // Carve-outs (correctness-critical): a run PAUSE (approval, or
                // a form page waiting on the visitor) and a cancellation are
                // NOT step failures — swallowing them into an error branch
                // would auto-"handle" a human-in-the-loop gate or keep a
                // cancelled run walking. Both re-throw unconditionally.
                // GuardrailBlockError intentionally REMAINS routable: a policy
                // block is a real step failure the flow may want to recover
                // from (e.g. notify-and-continue).
                if (isRunPause(stepErr)) throw stepErr;
                if (stepErr.message === 'Run cancelled') throw stepErr;
                const allOut = adj.get(id) || [];
                const hasErrorBranch = allOut.some(e => effectiveEdgeLabel(e) === 'on_error');
                // runPolicy.retry.then === 'continue' (handoff 5): with no
                // error branch wired, a step that failed for good is recorded
                // as handled and the run carries on down its NORMAL path, with
                // the step's output empty. Never for a brancher: an If/Switch/
                // Guard that failed chose no branch, so there is no normal path
                // to take and walking all of them would run both sides. Nor for
                // a terminal step (Stop with error): stopping IS what it is for.
                const continuePast = !hasErrorBranch
                    && ctx.runPolicy?.retry?.then === 'continue'
                    && !BRANCHER_TYPES.has(step.type)
                    && !TERMINAL_STEP_TYPES.has(step.type);
                if (!hasErrorBranch && !continuePast) throw stepErr;
                const errorClass = stepErr.errorClass || classifyUnknownError(stepErr);
                runState.steps = runState.steps || {};
                // Handled-error payload: downstream branch steps bind
                // steps.<id>.error.message / .errorClass / .stepId via the
                // normal walkPath resolution — zero bind.js changes.
                runState.steps[step.id] = {
                    output: null,
                    status: 'handled_error',
                    error: { message: stepErr.message, errorClass, stepId: step.id },
                };
                // Run-level tally — shared by REFERENCE across layer/loop/
                // parallel sub-states so executeAutomation can report
                // "N step error(s) handled" + persist handled_error_count.
                if (Array.isArray(runState._handledErrors)) {
                    runState._handledErrors.push({ stepId: step.id, message: stepErr.message, errorClass });
                }
                if (recordSteps && ctx.runId && !ctx.stepRecord?.suppress) {
                    try {
                        // Flip the FINAL attempt row (recorded as 'error' by
                        // dispatchStep's catch / retry loop) to handled_error
                        // via the (run_id, step_id, attempts) PK upsert —
                        // intermediate attempt rows keep their 'error' status
                        // so the audit trail still shows the retries.
                        await automationStore.recordRunStep({
                            runId: ctx.runId,
                            stepId: (ctx.stepRecord?.prefix || '') + step.id,
                            parentStepId: ctx.stepRecord?.parentStepId || null,
                            stepType: step.type,
                            attempts: stepErr.finalAttempt || 1,
                            status: 'handled_error',
                            startedAt: new Date().toISOString(),
                            finishedAt: new Date().toISOString(),
                            input: null,
                            output: null,
                            error: stepErr.message,
                            errorClass,
                            branchIndex,
                            secretValues: secretValuesFor(runState),
                        });
                    } catch { /* best-effort log */ }
                    ctx.emitLifecycle?.('step.finished', {
                        stepId: (ctx.stepRecord?.prefix || '') + step.id, status: 'handled_error',
                    });
                }
                const errEdges = continuePast ? nextEdgesFor(id, adj, 'on_success') : nextEdgesFor(id, adj, 'on_error');
                advance(id, errEdges);
                continue;
            }
            // Save into runState. Clone the output so downstream steps
            // that mutate it can't corrupt the cached binding source.
            runState.steps = runState.steps || {};
            const recordedStatus = dispatched.skippedReason === 'pinned' ? 'pinned'
                : dispatched.skippedReason ? 'skipped' : 'success';
            runState.steps[step.id] = {
                output: cloneRunValue(dispatched.output),
                status: recordedStatus,
                // Dry-run taint: downstream reads that bind this step's output
                // must synthesize instead of dispatching fake data live.
                // Bindings only descend `output.*`, so the extra key is
                // invisible to them.
                ...(mode === 'dry_run' && dispatched.dryRunSynthesised ? { synthesised: true } : {}),
            };
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
            if (step.type !== 'wait') lastOutput = dispatched.output;
            if (recordSteps && ctx.runId && !ctx.stepRecord?.suppress) {
                // In dry-run, annotate the RECORDED output (only) so the UI can
                // tell a synthesized preview from ground truth. Underscore-prefixed
                // meta keys, dry_run only — the binding source (runState.steps) is
                // left untouched so downstream resolves stay clean.
                let recordedOutput = dispatched.output ?? null;
                if (mode === 'dry_run' && dispatched.dryRunSynthesised
                    && recordedOutput && typeof recordedOutput === 'object' && !Array.isArray(recordedOutput)) {
                    recordedOutput = { ...recordedOutput, _dryRunSynthesised: true, _dryRunFallback: dispatched.dryRunFallback || null };
                }
                // PII metadata for the canvas's "colour lines by PII" mode.
                // Guard-derived summaries (integration/ai steps) ride in on
                // the dispatch result for free; other step types get a scan
                // ONLY in builder-initiated runs (dry-run / ▶ Execute) — the
                // owner's decision: production runs never pay for extra
                // scanning. scanOutputForPiiSummary itself gates on the org
                // shield ("Apply to routines") and PII detection being on.
                // Pure transformation steps are exempt (BFSF-359): their output
                // is a SUBSET of upstream data that was already scanned when
                // the step that produced it was recorded, so re-scanning buys
                // no new finding and costs single-digit seconds on an 8k-row
                // window — which is most of what made ▶ Execute feel broken on
                // a Limit node.
                let piiSummary = dispatched.piiSummary || null;
                if (!piiSummary && ctx.builderRun && recordedStatus === 'success' && dispatched.output != null
                    && !PII_RESCAN_EXEMPT_TYPES.has(step.type)) {
                    try { piiSummary = await safety.scanOutputForPiiSummary(dispatched.output, ctx); } catch (_) { /* never fail a run on it */ }
                }
                // When dispatchStep returns from a retry-success path, it
                // tags the result with `attempt` + `attemptStartedAt` so
                // this row lands on attempts=N rather than overwriting the
                // attempts=1 'error' row recorded inside the catch.
                await automationStore.recordRunStep({
                    runId: ctx.runId,
                    stepId: (ctx.stepRecord?.prefix || '') + step.id,
                    parentStepId: ctx.stepRecord?.parentStepId || null,
                    stepType: step.type,
                    toolName: step.tool || null,
                    attempts: dispatched.attempt || 1,
                    status: recordedStatus,
                    startedAt: dispatched.attemptStartedAt || dispatched.startedAt,
                    finishedAt: new Date().toISOString(),
                    input: dispatched.inputSnapshot ?? null,
                    output: recordedOutput,
                    error: null,
                    branchIndex,
                    piiSummary,
                    secretValues: secretValuesFor(runState),
                    // Tools an AI step was not given, each with its reason
                    // ('permission' | 'confirm' | 'unavailable'), for the
                    // Runs tab (handoff 5). Null for every other step.
                    toolsWithheld: Array.isArray(dispatched.toolsWithheld) && dispatched.toolsWithheld.length
                        ? [...new Set(dispatched.toolsWithheld)].map((name) => ({
                            name, reason: dispatched.toolsWithheldReasons?.[name] || 'unavailable',
                        }))
                        : null,
                });
                ctx.emitLifecycle?.('step.finished', {
                    stepId: (ctx.stepRecord?.prefix || '') + step.id, status: recordedStatus,
                });
            }
            // Branchers route by the label their executor returns: then/else
            // for condition + guard ("did this contain personal data"),
            // case:<name> / case:default for switch. Driven off the shared
            // BRANCHER_TYPES set so buildLinearEdges and this block can never
            // disagree about what counts as a brancher.
            if (BRANCHER_TYPES.has(step.type) && dispatched.output?.branch) {
                nextLabel = dispatched.output.branch;
            }
            branchOutput = dispatched.output || null;
            // onlyStepId terminates the walk after dispatching the target.
            if (isTargetForOnly) break;
        }

        // untilStepId stops here too — but AFTER the replay branch as well as
        // the live one, so a pinned or replayed target still ends the walk.
        if (untilStepId && step.id === untilStepId) break;

        // ── HET TERMINAALBEGRIP VAN DE RUNNER ────────────────────────────
        // Tot P4 had de wandeling er geen. `stop_error` eindigde een run
        // alleen doordat het GOOIT, en `layer_output` alleen doordat er per
        // conventie niets achter gedraad stond — dus een stap die de run
        // SUCCESVOL moet beëindigen had helemaal geen mechanisme: gooien maakt
        // de run rood, en niets doen laat de wandeling gewoon doorlopen zodra
        // iemand een rand tekent. De validator waarschuwt daar wel over
        // (`edge.after_terminal`), maar een waarschuwing blokkeert niets en een
        // geïmporteerde of met de hand geschreven definitie komt er langs.
        //
        // Hier is het dus echt: na een terminale stap loopt de wandeling niet
        // door — in élke graaf (root, loop-body, flowlet), langs de LIVE- en de
        // REPLAY-tak, want beide vallen hierdoorheen. Hetzelfde `break` dat
        // onlyStepId/untilStepId gebruiken, zodat de nacontrole erna
        // (partialTargetId) ongewijzigd blijft draaien.
        //
        // Voor `stop_error` verandert dit niets: die gooit al voordat de
        // wandeling hier komt. Hij staat in de set omdat de set één antwoord
        // moet geven op "welke stappen beëindigen een run" — niet omdat hij
        // deze regel nodig heeft.
        if (TERMINAL_STEP_TYPES.has(step.type)) break;

        // Default success-path: when no branching override fired, treat
        // the step as having succeeded so 'on_success'-labelled edges
        // route correctly (unlabeled edges still match — see nextEdgesFor).
        if (nextLabel == null) nextLabel = 'on_success';
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
        // A step whose chosen branch has no edge while OTHER edges leave it
        // ends the walk here by design — but silently. Leave a breadcrumb the
        // run report surfaces.
        //
        // This fired for `switch` only, so the other ways to reach the same
        // dead end went unreported: a guard's 'else', and — the one that made
        // it a bug rather than a gap — a DISABLED brancher, which used to route
        // on the fallback 'on_success' label that matches none of a
        // then/else/case:* wiring, ending the run green with nothing after it
        // executed and no warning anywhere (W4-11).
        //
        // Two carve-outs keep it from crying wolf:
        //   - a synthesized linear body (loop / parallel branch), where "no
        //     edge for this label" IS the designed exit of the iteration;
        //   - a step that SUCCEEDED and whose only remaining edge is on_error,
        //     which is a flow saying "if this fails, do that" and nothing more.
        // And it is deduplicated, because a loop body would otherwise push one
        // copy per iteration.
        if (outEdges.length === 0 && !isSynthesizedBody) {
            const allOut = adj.get(id) || [];
            const relevant = nextLabel === 'on_error'
                ? allOut
                : allOut.filter(e => effectiveEdgeLabel(e) !== 'on_error');
            if (relevant.length > 0) {
                pushRunWarning(
                    'branch_no_edge',
                    { stepType: step.type, step: step.id, branch: String(nextLabel) },
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
                'guard_unwired',
                { step: step.id },
                `guard ${step.id} found personal data but nothing is wired to its "personal data" branch — no alert was sent`,
            );
        }
        advance(id, outEdges);
    }

    // The partial target was never dequeued — the walk from the trigger simply
    // never got there (the node is unwired, or it sits behind a branch this run
    // did not take). The only termination the loop has is the `break` after the
    // target dispatches, so until now that ended as a run reporting SUCCESS
    // having executed nothing at all: the user clicks ▶ Execute, gets a green
    // tick and no output, and nothing anywhere says why (W3-7). Fail loudly so
    // the route can answer 4xx instead of a green no-op.
    if (partialTargetId && !visited.has(partialTargetId)) {
        const err = new Error(
            `Step ${partialTargetId} was never reached from the trigger — connect it to the flow (or run the branch that leads to it) before executing it.`,
        );
        err.errorClass = 'partial_target_unreachable';
        throw err;
    }

    return { lastOutput };
}

module.exports = { runDag };
