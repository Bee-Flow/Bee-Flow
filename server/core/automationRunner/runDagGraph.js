// @typecheck
/**
 * Graph bookkeeping for the DAG walker (runDag.js): which nodes a run can
 * reach, the fan-in (join) gate that decides when a node may be queued, the
 * ancestor/descendant sets a partial run is confined to, and the dequeue
 * order. Pure functions of the adjacency built by shared.buildAdjacency; no
 * I/O, no step execution.
 */

/** Every node reachable from `rootId` along forward edges (root included). */
function reachableFrom(adj, rootId) {
    const reachable = new Set([rootId]);
    const bfs = [rootId];
    while (bfs.length) {
        const n = bfs.pop();
        for (const e of (adj.get(n) || [])) {
            if (!reachable.has(e.to)) { reachable.add(e.to); bfs.push(e.to); }
        }
    }
    return reachable;
}

/**
 * Fan-in (join) gating: a step with multiple incoming edges must not
 * dispatch until every one of those edges has been resolved — either
 * taken (its source ran and routed here) or proven dead (its source
 * routed elsewhere, e.g. the untaken branch of a condition/switch, or
 * failed with no on_error edge to walk). Without this, a join fed by
 * branches of unequal depth fires as soon as the SHORTER branch's edge
 * lands in the queue, using only that branch's data — the longer
 * branch's remaining steps may still be several turns away in the FIFO
 * queue and haven't run yet.
 *
 * Only edges whose SOURCE is reachable from the seeded root can ever be
 * taken or resolved. Counting every edge in the definition deadlocked any
 * step wired from BOTH the primary trigger and a secondary
 * (webhook/app-event) trigger: a run seeded from one trigger never
 * dispatches the other, so the other's edge into the shared step never
 * resolved, the count stuck at ≥1, and the run drained to a "success"
 * with zero steps executed (node-audit C2). Single-root definitions are
 * unaffected — everything is reachable from the sole root.
 *
 * Returns the walk's queue and membership sets plus `advance`.
 */
function createFanInGate(adj, incoming, reachable, triggerId) {
    const pendingIncoming = new Map();
    for (const [to, edges] of incoming) {
        pendingIncoming.set(to, edges.filter(e => reachable.has(e.from)).length);
    }
    const visited = new Set();
    const queue = [triggerId];
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
    return { queue, visited, advance };
}

/**
 * Which nodes may be "filled in" live on a partial run — the ANCESTORS of the
 * partial target, and nothing else.
 *
 * This used to have no ancestry test at all: the predicate was built from
 * `stillSkipping`, a purely TEMPORAL flag that is true for every node the
 * FIFO walk dequeues before it reaches the target. runDag walks the whole
 * graph from the trigger, so a replay-less node on a completely unrelated
 * branch — dequeued early simply because it sits close to the root — was
 * dispatched FOR REAL, in live mode, with its full side effect. Clicking
 * ▶ Execute on one node sent an invoice email from a sibling branch (W3-4).
 * A prerequisite is an ancestor; nothing else is, so nothing else may
 * dispatch.
 */
function ancestorsOf(incoming, targetId, reachable) {
    const ancestors = new Set();
    const rev = [targetId];
    while (rev.length) {
        const n = rev.pop();
        for (const e of (incoming.get(n) || [])) {
            // Only nodes this run can actually reach from its seeded root:
            // an edge from an unreachable alternate trigger is not a
            // prerequisite of anything in THIS run.
            if (!reachable.has(e.from) || ancestors.has(e.from)) continue;
            ancestors.add(e.from);
            rev.push(e.from);
        }
    }
    return ancestors;
}

/**
 * Which nodes the LIVE TAIL of a retry-from-step may contain — the
 * DESCENDANTS of the target, and nothing else.
 *
 * The mirror image of ancestorsOf, and the other half of W3-4. Once the
 * `fromStepId` target is dispatched, `stillSkipping` flips off, and from
 * that moment every node the FIFO queue yields took the LIVE branch —
 * regardless of replay data and regardless of ancestry. A sibling branch
 * that merely sits at or below the target's BFS depth (or is pushed onto
 * the queue after it) was therefore re-executed for real on every "retry
 * from step": the invoice email W3-4 fixed on the upstream side went out
 * again from the downstream side. "Everything downstream" is what the
 * button promises, so descendants — and only descendants — dispatch.
 *
 * Not applied to skipUntilStepId: an approval resume is the continuation
 * of ONE run, and everything after the gate is legitimately still to do,
 * whatever branch it sits on.
 */
function descendantsOf(adj, fromId) {
    const descendants = new Set();
    const fwd = [fromId];
    while (fwd.length) {
        const n = fwd.pop();
        for (const e of (adj.get(n) || [])) {
            if (descendants.has(e.to)) continue;
            descendants.add(e.to);
            fwd.push(e.to);
        }
    }
    return descendants;
}

/**
 * Dequeue order: runnable-first, waits LAST (BFSF-371).
 *
 * The walk has a single FIFO cursor and `dispatchStep` is awaited inline,
 * so whatever is at the head of the queue owns the runner until it
 * returns. `wait` is the one step type that is pure dead time: it produces
 * nothing any sibling branch could need, it just sleeps in-process (see
 * execControl.execWait — up to 24 hours). Put it at the head of a fan-out
 * and every other branch sits behind the sleep, one node deep. On
 *   split ─then→ a1 → a2 → a3
 *   split ─then→ w  → b2
 * the FIFO order is split, a1, w, a2, b2, a3 — exactly one node of branch A
 * gets ahead of the sleep and the rest of the workflow waits it out, which
 * is what users report as "one Wait pauses the whole automation".
 *
 * So: take any other runnable node first, and take a wait only when it is
 * the only thing left. Independent branches then drain to completion and
 * the sleep happens once, at the end, with nothing else pending.
 *
 * This is a SCHEDULING change, not a semantic one. Everything the walker
 * decides — `visited`, the fan-in counters in `pendingIncoming`, the
 * `arrivedVia`/`deadNodes` bookkeeping and its cascade, the
 * `partialTargetId` reachability check — is keyed on MEMBERSHIP, never on
 * the order nodes come off the queue. `queued` is never cleared, so the
 * queue holds no duplicates and every node is still dequeued exactly once.
 *
 * …with one exception, which is why this is gated. `stillSkipping` is a
 * purely TEMPORAL flag (see runDag): during a replay it decides, per
 * dequeue, whether a step is re-played or dispatched FOR REAL. Within a
 * single process the reorder is self-consistent — the queue evolution is a
 * deterministic function of the graph plus the recorded branch labels, so a
 * step is never both replayed and re-run. The hazard is a run that PAUSED on
 * the old order and RESUMES on the new one: mixing the two could flip a wait
 * from "already replayed" to "dispatch live" and re-sleep it, up to 24h,
 * with a human watching. Costs nothing to close, so: only plain forward
 * walks reorder (`deferWaits`). BFSF-371 only ever shows up on those anyway.
 *
 * A flowlet's Return (`layer_output`) goes after even the waits. It reads
 * what the flowlet's other steps produced and hands it to the caller, so
 * it has to be the last thing the flowlet does. A Return wired straight
 * from a step that ALSO starts the real work (`trg → out` beside
 * `trg → http → code`, what the AI builder made of "add after the
 * trigger" until draftGraph.layerAwareAnchor kept the Return last) used
 * to run second, find nothing, and return an empty record while the work
 * ran after it for nobody. Nothing in a flowlet can read the Return, so
 * taking it last changes no other step's input.
 */
function createTakeNext(queue, stepById, deferWaits) {
    // 0 = runnable now, 1 = an enabled wait, 2 = the Return. A DISABLED wait
    // never sleeps, so there is nothing to defer — and deferring it would
    // needlessly make it the last step of the run. `stepById.get()` is
    // undefined for the synthesized roots (__loop_root__/__parallel_root__),
    // which rank 0 harmlessly.
    const deferRank = (nid) => {
        const s = stepById.get(nid);
        if (s?.type === 'layer_output') return 2;
        return s?.type === 'wait' && !s.disabled ? 1 : 0;
    };
    return () => {
        if (!deferWaits) return queue.shift();
        // The first node of the lowest rank: FIFO within a rank, and the
        // head when everything is ranked alike. The caller's `while` guard
        // makes index 0 safe.
        let best = 0;
        let bestRank = deferRank(queue[0]);
        for (let i = 1; i < queue.length && bestRank > 0; i++) {
            const r = deferRank(queue[i]);
            if (r < bestRank) { best = i; bestRank = r; }
        }
        return queue.splice(best, 1)[0];
    };
}

module.exports = { reachableFrom, createFanInGate, ancestorsOf, descendantsOf, createTakeNext };

/**
 * @typedef {{ from: string, to: string, label?: string, caseName?: string }} DagEdge
 * @typedef {Map<string, DagEdge[]>} EdgeMap
 */
