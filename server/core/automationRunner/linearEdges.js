/**
 * The edges of a loop body / parallel branch (split out of execFlow.js).
 */
'use strict';

const { LOOP_ROOT_ID } = require('./shared');

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

module.exports = { buildLinearEdges };
