/**
 * Builder tools — draft-graph primitives: step ids, the empty definition,
 * edge wiring (branch labels, flowlet-aware append anchors, on_error edges)
 * and step lookup. Required from within automation/builderTools/ and the
 * ../builderTools facade.
 */

const crypto = require('crypto');

function newId(prefix = 's') { return `${prefix}_${crypto.randomBytes(3).toString('hex')}`; }

function emptyDefinition() {
    return {
        schemaVersion: 1,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
        steps: [],
        edges: [],
        vars: {},
    };
}

/**
 * The step a caller-omitted `afterStepId` implicitly means: the last REAL
 * step, or the trigger if there are none yet.
 *
 * A `note` (BFSF-411) is skipped even when it is the last entry in
 * `draft.steps` — it is pushed there like any other step, but it is never
 * wired to anything, and returning its id here would make the very next
 * builder_add_* call (the common no-afterStepId path) wire FROM it, handing
 * the note an edge the moment anything is added after it.
 */
function lastStepId(def) {
    const steps = Array.isArray(def.steps) ? def.steps : [];
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i] && steps[i].type !== 'note') return steps[i].id;
    }
    return def.trigger.id;
}

/**
 * Build the edge connecting `fromId` → `toId`, labelling it correctly when
 * `fromId` is a branching step. Appending a step after a condition (the
 * documented way to grow a branch) MUST produce a labelled edge — the runner
 * routes conditions with a strict `e.label === 'then'/'else'` match
 * (automationRunner.js nextEdgesFor), so an unlabelled edge would dead-end.
 * Auto-infers the label (then first, else second) and accepts an explicit
 * `branch` override; switches use `caseName`. Non-branching predecessors get
 * a plain `{from, to}` edge — identical to the previous behaviour.
 *
 * §WS4: `branch:'error'` labels the edge 'on_error' regardless of the
 * predecessor type — the runner only follows it when the source step
 * exhausts its retries and fails. Validation enforces which step types may
 * carry an error branch (edge.error_label_invalid / _unlikely).
 */
function branchEdgeFor(draft, fromId, toId, { branch, caseName } = {}) {
    const edge = { from: fromId, to: toId };
    if (branch === 'error') {
        edge.label = 'on_error';
        return edge;
    }
    const pred = (draft.steps || []).find(s => s.id === fromId);
    if (pred && pred.type === 'condition') {
        let label = (branch === 'then' || branch === 'else') ? branch : null;
        if (!label) {
            const labels = new Set((draft.edges || []).filter(e => e.from === fromId).map(e => e.label));
            label = labels.has('then') ? 'else' : 'then';
        }
        edge.label = label;
    } else if (pred && pred.type === 'switch' && typeof caseName === 'string' && caseName) {
        edge.label = caseName === 'default' ? 'case:default' : `case:${caseName}`;
        edge.caseName = caseName;
    }
    return edge;
}

/**
 * Resolve the predecessor id a freshly-built step (id `newStepId`) should be
 * wired FROM, keeping a flowlet's `layer_output` ("Return") step terminal.
 *
 * A flowlet skeleton wires `trigger → layer_output` straight away, so the naive
 * "append after the last step" lands every new step AFTER the output — the
 * flowlet then returns nothing and does its real work as dead code. Here, when
 * the natural anchor would be the output (no explicit afterStepId, or it points
 * AT the output), we splice the new step in just before it: re-point the
 * output's incoming edge to come from the new step and return the output's old
 * predecessor as the anchor. Non-flowlet graphs (no layer_output) are unaffected.
 */
function layerAwareAnchor(graph, afterStepId, newStepId) {
    const out = Array.isArray(graph.steps) ? graph.steps.find(s => s && s.type === 'layer_output') : null;
    // No output, or an explicit anchor on a real (non-output) step → respect it.
    if (!out || (afterStepId && afterStepId !== out.id)) {
        return afterStepId || lastStepId(graph);
    }
    const feed = Array.isArray(graph.edges) ? graph.edges.find(e => e && e.to === out.id) : null;
    const anchor = feed ? feed.from : (graph.trigger?.id || lastStepId(graph));
    if (feed) feed.from = newStepId;                       // out now follows the new step
    else (graph.edges = graph.edges || []).push({ from: newStepId, to: out.id });
    return anchor;
}

/**
 * Splice (opt-in, `opts.splice === true`): put the new step BETWEEN the anchor
 * and its current successor(s) instead of fanning it out beside them. Without
 * this, "add after X" on a step that already has a successor leaves the old
 * edge in place, so the new step runs in PARALLEL with the old successor and
 * nothing downstream can depend on it — the only way to insert into the middle
 * of a chain used to be remove-and-re-add, which mints a new id and breaks
 * every downstream reference.
 *
 * Which of the anchor's outgoing edges move: exactly those carrying the SAME
 * label the new edge gets (plain edges for a plain anchor; the one then/else
 * or case:* edge for a branching anchor). `on_error` edges never move — they
 * are a different path, not a successor. A moved edge is relabelled for its
 * new origin: plain when the new step is not branching, `then` when the new
 * step is a condition (the old successor becomes its true-branch; the author
 * grows the else-branch afterwards). A switch cannot be spliced in — there is
 * no case to hand the old successor to — so the caller gets an error and
 * wires `nextStepIds` explicitly instead.
 */
function spliceSuccessors(draft, anchorId, step, newEdge) {
    if (step.type === 'switch') {
        throw new Error('splice is not supported when the new step is a switch — add it with nextStepIds and remove the old edge instead.');
    }
    const label = newEdge.label || null;
    let moved = 0;
    for (const e of draft.edges || []) {
        if (!e || e.from !== anchorId || e.to === step.id) continue;
        if (e.label === 'on_error') continue;
        if ((e.label || null) !== label) continue;
        e.from = step.id;
        delete e.caseName;
        if (step.type === 'condition') e.label = 'then';
        else delete e.label;
        moved++;
    }
    return moved;
}

function appendAfter(draft, afterStepId, step, opts = {}) {
    const anchor = layerAwareAnchor(draft, afterStepId, step.id);
    const edge = branchEdgeFor(draft, anchor, step.id, opts);
    if (opts.splice === true) spliceSuccessors(draft, anchor, step, edge);
    draft.steps.push(step);
    draft.edges.push(edge);
    return step;
}

/**
 * §WS4 — wire an on_error edge between two EXISTING steps of `graph` (the
 * root, or a flowlet via scope). The source-type gate mirrors validate.js's
 * edge.error_label_invalid set so the LLM gets immediate feedback instead
 * of a validation bounce on the next persist.
 */
// Mirrors validate/constants.js ON_ERROR_FORBIDDEN_SOURCE_TYPES. The terminal
// half of that set (stop_error, return_to_app) is in here for the reason the
// TERMINAL_STEP_TYPES header spells out: a step that ends the run can never
// reach the branch it promised. A terminal soort that lands in one list and
// not the other is exactly the drift automation/validate/terminalSteps.test.js
// fails on.
const ERROR_BRANCH_FORBIDDEN_SOURCES = new Set(['condition', 'switch', 'approval', 'form_page', 'stop_error', 'return_to_app']);

function applyWireErrorBranch(graph, args) {
    const from = typeof args.fromStepId === 'string' ? args.fromStepId : null;
    const to = typeof args.toStepId === 'string' ? args.toStepId : null;
    if (!from || !to) return { error: 'fromStepId and toStepId are both required.' };
    if (from === to) return { error: 'fromStepId and toStepId must be different steps.' };
    const stepIds = (graph.steps || []).map(s => s.id);
    if (from === graph.trigger?.id) {
        return { error: 'Triggers cannot fail — an error branch must start from a step, not the trigger.' };
    }
    const fromStep = (graph.steps || []).find(s => s.id === from);
    if (!fromStep) return { error: `Unknown fromStepId "${from}". Existing step ids: ${stepIds.join(', ') || '(none)'}.` };
    if (!stepIds.includes(to) && to !== graph.trigger?.id) {
        return { error: `Unknown toStepId "${to}". Existing step ids: ${stepIds.join(', ') || '(none)'}.` };
    }
    if (to === graph.trigger?.id) return { error: 'toStepId cannot be the trigger.' };
    if (ERROR_BRANCH_FORBIDDEN_SOURCES.has(fromStep.type)) {
        return { error: `A "${fromStep.type}" step cannot have an error branch — only failure-capable steps can (integration_action, ai_step, code, http_request, call_layer, loop, parallel, notification, wait).` };
    }
    const existing = (graph.edges || []).find(e => e.from === from && e.to === to && e.label === 'on_error');
    if (existing) return { wired: existing, note: 'edge already existed' };
    const edge = { from, to, label: 'on_error' };
    graph.edges.push(edge);
    return { wired: edge };
}

// Branching step types — they route via labelled outgoing edges
// (then/else, case:*). Used by the in-place edit/delete reconcilers.
const BRANCHING_TYPES = new Set(['condition', 'switch']);

/** Plain-text id list for "step not found" errors (mirrors applyWireErrorBranch). */
function listStepIds(graph) {
    return (graph.steps || []).map(s => s.id).join(', ') || '(none)';
}

/** Every trigger id of a graph: the primary plus definition.triggers[]. */
function allTriggerIds(graph) {
    const ids = [];
    if (graph?.trigger?.id) ids.push(graph.trigger.id);
    for (const t of (Array.isArray(graph?.triggers) ? graph.triggers : [])) if (t?.id) ids.push(t.id);
    return ids;
}

/**
 * Is `id` already taken by a trigger or a step (root, flowlet or loop body)?
 * The tempId collision check used to test the literal 'trg' plus the steps,
 * which missed a re-keyed primary and every additional trigger.
 */
function isKnownNodeId(graph, id) {
    return allTriggerIds(graph).includes(id) || !!findStepAnywhere(graph, id);
}

/**
 * Locate a step by id within a graph (the root or a flowlet — `scope` is
 * already resolved to `graph` by the dispatcher). Also finds steps nested in a
 * `loop.body[]`. Branch members (then/else/case targets) live in `graph.steps`
 * wired by edge labels, so the top-level scan already covers them.
 *
 * Returns { step, container, index, kind, graph[, parentLoop] } or null.
 *   kind 'graph' → container is graph.steps; 'loop' → container is loop.body.
 */
function findStepAnywhere(graph, stepId) {
    const steps = Array.isArray(graph.steps) ? graph.steps : [];
    const top = steps.findIndex(s => s && s.id === stepId);
    if (top >= 0) return { step: steps[top], container: steps, index: top, kind: 'graph', graph };
    for (const s of steps) {
        if (s && s.type === 'loop' && Array.isArray(s.body)) {
            const i = s.body.findIndex(b => b && b.id === stepId);
            if (i >= 0) return { step: s.body[i], container: s.body, index: i, kind: 'loop', parentLoop: s, graph };
        }
    }
    return null;
}

/**
 * After a type swap (same id), reconcile the OUTGOING edges so the runner never
 * dead-ends. Strips now-invalid branch labels, drops on_error edges from step
 * types that can't carry them, and returns a human note when the agent must
 * finish wiring (validation surfaces dead_branch/partial_branch as the signal).
 */
function reconcileOutgoingEdges(graph, oldStep, newStep) {
    const id = newStep.id;
    const wasBranching = BRANCHING_TYPES.has(oldStep.type);
    const nowBranching = BRANCHING_TYPES.has(newStep.type);
    const out = (graph.edges || []).filter(e => e.from === id);
    const stripped = [];
    const dropIdx = new Set();
    for (const e of out) {
        const lbl = e.label;
        if (lbl === 'on_error') {
            if (ERROR_BRANCH_FORBIDDEN_SOURCES.has(newStep.type)) dropIdx.add(e);
            continue;
        }
        const isBranchLabel = lbl === 'then' || lbl === 'else' || (typeof lbl === 'string' && lbl.startsWith('case:'));
        if (!isBranchLabel) continue;
        // Labels are invalid when the step is no longer branching, or when the
        // branch class changed (condition then/else ↔ switch case:*).
        if (!nowBranching || (wasBranching && oldStep.type !== newStep.type)) {
            delete e.label; delete e.caseName; stripped.push(`${lbl}→${e.to}`);
        }
    }
    if (dropIdx.size) graph.edges = graph.edges.filter(e => !dropIdx.has(e));
    const notes = [];
    if (stripped.length) notes.push(`Stripped now-invalid branch labels on outgoing edges: ${stripped.join(', ')}.`);
    if (dropIdx.size) notes.push(`Dropped on_error edge(s) — a ${newStep.type} step cannot carry one.`);
    if (!wasBranching && nowBranching) {
        notes.push(`This step is now branching (${newStep.type}) but its outgoing edge(s) are unlabelled — set branch targets so they don't dead-end (re-wire with builder_add_* branch/caseName, or builder_remove_step + re-add).`);
    }
    return notes.length ? notes.join(' ') : null;
}

/**
 * Move an existing step so it runs after `afterStepId` — WITHOUT deleting it.
 *
 * WHY THIS EXISTS. Measured on the demo box (2026-09-11), the biggest single
 * source of wasted builder rounds was a step in the wrong place. The model's
 * FIRST repair attempt was right in spirit every time — `builder_update_step`
 * with `{afterStepId}` on a loop it had appended at the tail, `{elseStepId}`
 * on a condition whose else-branch it had just filled wrongly — and both were
 * refused as "not patchable". With no way to move a step it deleted and
 * re-added, the re-add landed at the tail again (no afterStepId), and it did
 * that seven times in one build. A move keeps the id, so every downstream
 * `steps.<id>.output.*` ref survives — the whole reason remove-and-re-add is
 * forbidden in the first place.
 *
 * Semantics:
 * - DETACH: the step's predecessors are bridged to its plain successors,
 *   exactly as builder_remove_step does, so the chain it leaves closes up. A
 *   branching step (condition/switch) takes its branch edges WITH it — the
 *   branches are part of what it is. An on_error edge FROM the step travels
 *   too (its own failure path). An on_error edge INTO the step is dropped: it
 *   is no longer that source's handler, and bridging it would silently make
 *   the successor one.
 * - ATTACH with splice semantics: the anchor's same-label successors now
 *   follow the moved step. "Move B after A" means A→B→(what followed A), not
 *   a fan-out beside it. A branching step is the exception — it already has
 *   its successors, so whatever followed the anchor stays beside it and the
 *   result says so.
 * - `graph.steps` order follows the move, so the default "append at the tail"
 *   keeps meaning the chain's real end rather than "after the step I moved".
 */
function moveStepAfter(graph, stepId, { afterStepId, branch, caseName } = {}) {
    const found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Existing step ids: ${listStepIds(graph)}.` };
    if (found.kind === 'loop') {
        return { error: `"${stepId}" is inside loop "${found.parentLoop.id}" — body steps run in body order and are not moved with afterStepId. Re-send the body in the order you want with builder_replace_step({stepId:"${found.parentLoop.id}", newType:"loop", spec:{overRef, itemVar, maxIterations, body:[…]}}), which keeps the loop's id.` };
    }
    if (typeof afterStepId !== 'string' || !afterStepId) return { error: 'afterStepId is required to move a step.' };
    if (afterStepId === stepId) return { error: `"${stepId}" cannot be moved after itself.` };
    const step = found.step;
    if (step.type === 'layer_output') return { error: 'A flowlet\'s Return step is always last — move the other steps instead.' };

    const anchorIsTrigger = afterStepId === graph.trigger?.id || allTriggerIds(graph).includes(afterStepId);
    const anchorStep = anchorIsTrigger ? null : (graph.steps || []).find(s => s && s.id === afterStepId);
    if (!anchorIsTrigger && !anchorStep) {
        const inBody = findStepAnywhere(graph, afterStepId);
        if (inBody && inBody.kind === 'loop') {
            return { error: `afterStepId "${afterStepId}" is a step INSIDE loop "${inBody.parentLoop.id}" — a root step cannot run inside a loop body. Anchor on the loop itself: afterStepId:"${inBody.parentLoop.id}".` };
        }
        return { error: `Unknown afterStepId "${afterStepId}". Existing step ids: ${listStepIds(graph)}.` };
    }
    if (anchorStep && anchorStep.type === 'layer_output') return { error: 'Nothing runs after a flowlet\'s Return step — anchor on the step before it.' };

    const edges = Array.isArray(graph.edges) ? graph.edges : (graph.edges = []);
    const branching = BRANCHING_TYPES.has(step.type);
    if (branching) {
        // Its branches travel with it, so the anchor must not sit on one of them.
        const seen = new Set([stepId]);
        const stack = [stepId];
        while (stack.length) {
            const cur = stack.pop();
            for (const e of edges) if (e && e.from === cur && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
        }
        if (seen.has(afterStepId)) {
            return { error: `Cannot move "${stepId}" after "${afterStepId}": that step sits on one of its own branches, so the move would make a cycle. Move the branch step instead.` };
        }
    }

    // ── Detach ──
    const incoming = edges.filter(e => e && e.to === stepId);
    const outgoing = edges.filter(e => e && e.from === stepId);
    const travels = new Set(branching ? outgoing : outgoing.filter(e => e.label === 'on_error'));
    const successors = branching ? [] : outgoing.filter(e => e.label !== 'on_error').map(e => e.to);
    const kept = edges.filter(e => e && e.to !== stepId && (e.from !== stepId || travels.has(e)));
    const bridged = [];
    const droppedHandlers = [];
    for (const inc of incoming) {
        if (inc.label === 'on_error') { droppedHandlers.push(inc.from); continue; }
        for (const to of successors) {
            if (inc.from === to) continue;
            if (kept.some(x => x.from === inc.from && x.to === to && (x.label || null) === (inc.label || null))) continue;
            const e = { from: inc.from, to };
            if (inc.label) { e.label = inc.label; if (inc.caseName) e.caseName = inc.caseName; }
            kept.push(e);
            bridged.push(`${e.from}→${to}`);
        }
    }

    // ── Attach ──
    graph.edges = kept;
    const edge = branchEdgeFor(graph, afterStepId, stepId, { branch, caseName });
    if (!branching) {
        try { spliceSuccessors(graph, afterStepId, step, edge); }
        catch (e) { graph.edges = edges; return { error: e.message }; }
    }
    graph.edges.push(edge);

    found.container.splice(found.container.indexOf(step), 1);
    const at = anchorStep ? found.container.indexOf(anchorStep) + 1 : 0;
    found.container.splice(at, 0, step);

    const notes = [];
    if (bridged.length) notes.push(`re-joined ${bridged.join(', ')} where it used to be`);
    if (droppedHandlers.length) notes.push(`dropped its on_error edge from ${droppedHandlers.join(', ')} — it no longer handles that failure`);
    if (branching) notes.push(`a ${step.type} keeps its own branches; whatever already followed ${afterStepId} now runs beside it — move that onto a branch if it should follow the ${step.type}`);
    return {
        moved: stepId,
        now: `${afterStepId}→${stepId}${edge.label ? `(${edge.label})` : ''}`,
        ...(notes.length ? { note: notes.join('; ') } : {}),
    };
}

module.exports = {
    newId,
    emptyDefinition,
    lastStepId,
    branchEdgeFor,
    layerAwareAnchor,
    appendAfter,
    spliceSuccessors,
    moveStepAfter,
    applyWireErrorBranch,
    ERROR_BRANCH_FORBIDDEN_SOURCES,
    BRANCHING_TYPES,
    listStepIds,
    allTriggerIds,
    isKnownNodeId,
    findStepAnywhere,
    reconcileOutgoingEdges,
};
