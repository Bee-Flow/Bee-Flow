/**
 * The run, paced so a person can see it happen — pure half.
 *
 * The server is polled every 1.5 s and a small chain finishes faster than
 * that, so the first frame the canvas ever gets already has three nodes done
 * (owner, 2026-09-16: "it's almost instant for the first nodes… it isn't
 * clear that the automation is being triggered and goes from node to node").
 * The film walks the same run one node at a time: the trigger fires, then
 * each step lights up as running before it lands.
 *
 * It never LIES: a node is only shown as finished once the server says so, and
 * the walk stops at whatever the run has really reached. It only holds a node
 * on screen long enough to be seen, and shortens that hold when it is falling
 * behind a genuinely fast run.
 */

/** Statuses a step does not come back from — the run has moved on. */
export const TERMINAL = new Set(['success', 'error', 'skipped', 'nothing_to_do', 'handled_error', 'cancelled', 'pinned']);
const RUN_OVER = new Set(['success', 'error', 'cancelled', 'failed', 'skipped']);

/** The order the film walks: the trigger, then the steps as the definition lists them. */
export function filmOrder(definition) {
    const out = [];
    if (definition?.trigger?.id) out.push(definition.trigger.id);
    for (const s of (definition?.steps || [])) if (s?.id) out.push(s.id);
    return out;
}

/** The latest record per step id. */
export function recordsById(steps) {
    const m = new Map();
    for (const r of (Array.isArray(steps) ? steps : [])) {
        if (r && r.stepId && !r.parentStepId) m.set(r.stepId, r);
    }
    return m;
}

/**
 * How far the film MAY walk: up to the first node the run has not finished.
 * The trigger has no record of its own — it counts as fired the moment any
 * step has one, or the run is over. A finished run releases the whole chain,
 * so a step that never ran (a branch not taken) cannot stall the film.
 */
export function serverHead(order, byId, { runStatus = null, hasTrigger = false } = {}) {
    if (runStatus && RUN_OVER.has(runStatus)) return order.length;
    for (let i = 0; i < order.length; i++) {
        const rec = byId.get(order[i]);
        if (i === 0 && hasTrigger && !rec) {
            if (byId.size > 0) continue;   // something ran → the trigger fired
            return 0;
        }
        if (!rec || !TERMINAL.has(rec.status)) return i;
    }
    return order.length;
}

/**
 * The run as the canvas should see it at `head`: everything before it exactly
 * as the server recorded it, the node AT it running, everything after it
 * absent (the canvas draws an untouched node for a step with no record).
 */
export function frameAt(order, byId, head, { hasTrigger = false } = {}) {
    const out = [];
    for (let i = 0; i < order.length; i++) {
        const id = order[i];
        const rec = byId.get(id);
        if (i < head) {
            if (rec) out.push(rec);
            else if (i === 0 && hasTrigger) out.push({ stepId: id, status: 'success' });
            continue;
        }
        if (i === head) {
            if (rec && rec.status === 'error') out.push(rec);
            else out.push({ ...(rec || {}), stepId: id, status: 'running' });
        }
        break;
    }
    return out;
}

/** How long the node at the head stays on screen — shorter when the run has run ahead. */
export function dwellMs(behind, { stepMs = 620, catchUpMs = 240 } = {}) {
    return behind > 2 ? catchUpMs : stepMs;
}
