/**
 * The backward walk over the definition's edge list.
 *
 * No samples, no catalog, no describing: just "which nodes can flow data into
 * `currentStepId`, in the order a reader of the canvas would meet them".
 * computeUpstreamGroups (groups.js) is what turns that order into variables.
 */

/**
 * BFS backward through edges to find every node that can flow data into
 * `currentStepId`. Trigger is always included (it's the root of the DAG).
 * Returns nodes in topological order (trigger first, then steps in the
 * order they were visited) so the variable tree renders top-to-bottom
 * matching execution order, and so auto-map can prefer the NEAREST node
 * (last in the returned array).
 */
export function collectUpstream(definition, currentStepId) {
    const trigger = definition.trigger;
    // Additional triggers (definition.triggers[] — webhook/app_event only,
    // scoped multi-trigger slice). Every trigger — primary or additional —
    // writes into the SAME runtime `trigger.output` (only whichever one
    // actually fired populates it for a given run), so each surfaces as its
    // own upstream group sharing that one base path — "any of N possible
    // shapes, one path", no new ref-root needed.
    const additionalTriggers = Array.isArray(definition.triggers) ? definition.triggers : [];
    const steps = definition.steps || [];
    const edges = definition.edges || [];
    const byId = new Map();
    if (trigger) byId.set(trigger.id, { ...trigger, __isTrigger: true });
    for (const t of additionalTriggers) byId.set(t.id, { ...t, __isTrigger: true });
    for (const s of steps) byId.set(s.id, s);

    // Build reverse adjacency (target -> [source]).
    const incoming = new Map();
    for (const e of edges) {
        if (!e.from || !e.to) continue;
        if (!incoming.has(e.to)) incoming.set(e.to, []);
        incoming.get(e.to).push(e.from);
    }

    // BFS from currentStepId backward.
    const visited = new Set();
    const order = [];
    const stack = [currentStepId];
    while (stack.length) {
        const cur = stack.pop();
        const sources = incoming.get(cur) || [];
        for (const src of sources) {
            if (visited.has(src)) continue;
            visited.add(src);
            order.push(src);
            stack.push(src);
        }
    }

    // Every trigger is always implicitly upstream — include even if there's
    // no edge yet, so the user can wire from trigger.output.* before
    // connecting their first step manually.
    const allTriggerIds = [trigger?.id, ...additionalTriggers.map(t => t.id)].filter(Boolean);
    for (const id of allTriggerIds) {
        if (!visited.has(id)) { visited.add(id); order.push(id); }
    }

    // Render in topological order: triggers first, then upstream steps in
    // execution order (reverse of BFS pop order = order of dependency). The
    // BFS pops nearest-first, so we iterate `order` in REVERSE to get
    // execution order — which puts the NEAREST upstream node last (highest
    // index). chooseNearest / nearestArrayRef rely on that: in a 3+ step
    // chain the immediate predecessor must win over a farther one (e.g.
    // gmail_read's attachments over gmail_search's results).
    const result = [];
    for (const id of allTriggerIds) {
        if (visited.has(id) && byId.has(id)) result.push(byId.get(id));
    }
    for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i];
        if (allTriggerIds.includes(id)) continue;
        const n = byId.get(id);
        if (n) result.push(n);
    }
    return result;
}
