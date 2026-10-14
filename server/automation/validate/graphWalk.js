/**
 * The step walk of validateGraph (./graph.js): run the per-type step rules
 * over the top-level steps in topological order and, recursively, every step
 * in a loop body or parallel branch; and the form-page ending check.
 */

const { VALID_STEP_TYPES } = require('./constants');
const { isObject } = require('./helpers');
const { checkBindableStepId } = require('./fieldChecks');
const { createStepChecker } = require('./stepRules');

/**
 * @param {object} ctx   validateGraph's context
 * @param {object} walk  { ids, stepById, order } plus the step-rule catalogues
 *                      (availableTools, toolRequiredParams, knownConnectionIds,
 *                      availableAgents, topicClassifier).
 */
function walkGraphSteps(ctx, walk) {
    const { graph, trigger, p, pushE, pushW, isContractScope } = ctx;
    const { ids, stepById, order, availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier } = walk;
    const seenSoFar = new Set([trigger.id]); // outputs available
    const checkStep = createStepChecker({
        graph, trigger, ids, seenSoFar, pushE, pushW,
        availableTools, toolRequiredParams, knownConnectionIds, availableAgents, topicClassifier, isContractScope,
    });

    // Nested walker — validates every step inside a loop body / parallel
    // branch with the SAME per-type rules as top-level steps, recursively.
    // The graph-size ceilings in validateDefinition already bound the total
    // node count, so recursion depth/width can't blow up here.
    //
    // `allKnownIds` spans top-level AND nested ids: at run time every body
    // step writes runState.steps[<id>] in its iteration's sub-state, so an id
    // collision silently clobbers real state (C3/C4).
    const allKnownIds = new Set(ids);
    // Known-id base for nested ref checks: all TOP-LEVEL ids plus the chain
    // of container/sibling ids accumulated on the way down.
    const refIdsFor = (chainIds) => new Set([...ids, ...chainIds]);
    const walkNested = (container, atContainer, chainIds, seenAtContainer) => {
        const groupsToWalk = container.type === 'loop'
            ? [{ items: Array.isArray(container.body) ? container.body : [], mkPath: (child) => `${atContainer}.body.steps[${child?.id ?? '?'}]`, missCode: 'loop.body_item_id_missing', typeCode: 'loop.body_item_type', where: 'loop body' }]
            : (Array.isArray(container.branches) ? container.branches : []).map((branch, bi) => ({
                items: Array.isArray(branch) ? branch : [],
                mkPath: (child) => `${atContainer}.branches[${bi}].steps[${child?.id ?? '?'}]`,
                missCode: 'parallel.branch_item_id_missing', typeCode: 'parallel.branch_item_type', where: `parallel branch ${bi}`,
            }));

        for (const group of groupsToWalk) {
            // Earlier siblings' outputs become available in document order —
            // the runtime chains the body linearly.
            const localSeen = new Set(seenAtContainer);
            for (const child of group.items) {
                if (!isObject(child) || !child.id) { pushE({ code: group.missCode, severity: 'error', path: atContainer, message: `Step ${container.id}: ${group.where} item missing id.`, hint: 'Re-add the nested step via the relevant builder_add_* tool.' }); continue; }
                const childAt = group.mkPath(child);
                if (!VALID_STEP_TYPES.has(child.type)) { pushE({ code: group.typeCode, severity: 'error', path: childAt, message: `Step ${container.id}: ${group.where} step "${child.id}" has unknown type "${child.type}".`, hint: `Use one of: ${[...VALID_STEP_TYPES].join(', ')}.` }); continue; }
                if (allKnownIds.has(child.id)) {
                    pushE({ code: 'loop.body_item_id_duplicate', severity: 'error', path: childAt + '.id', message: `Step ${container.id}: nested step id "${child.id}" collides with another step in this automation.`, hint: 'Every step id must be unique across the whole flow — nested steps write runState.steps[<id>] too, so a collision silently overwrites real data.' });
                    continue;
                }
                checkBindableStepId(child, childAt, pushW);
                allKnownIds.add(child.id);
                const childChain = new Set(chainIds);
                childChain.add(child.id);
                // call_layer / call_block children are validated by the
                // dedicated collect* passes above — running the generic rules
                // too would double-report them.
                if (child.type !== 'call_layer' && child.type !== 'call_block') {
                    // Known ids for refs: top-level ∪ container chain ∪ earlier
                    // siblings (localSeen) ∪ the child itself — a body step
                    // may read its predecessor in the same body.
                    checkStep(child, childAt, { nested: true, idsForRefs: new Set([...refIdsFor(childChain), ...localSeen]), seen: localSeen });
                }
                localSeen.add(child.id);
                if (child.type === 'loop' || child.type === 'parallel') {
                    walkNested(child, childAt, childChain, localSeen);
                }
            }
        }
    };
    for (const id of order) {
        const step = stepById.get(id);
        if (!step) continue;
        if (step.id === trigger.id) continue;
        const at = p(`steps[${id}]`);
        checkStep(step, at);
        if (step.type === 'loop' || step.type === 'parallel') {
            walkNested(step, at, new Set([step.id]), new Set([...seenSoFar, step.id]));
        }
        seenSoFar.add(step.id);
    }
}

/** A form page asked after the closing page (warning). */
function checkFormEndings({ graph, p, pushW }, stepById) {
    // An 'ending' page is the visitor's last screen. Asking another question
    // after it means they see "thanks, we're done" and are then handed a form —
    // almost always a wiring mistake, so warn rather than block.
    const endings = graph.steps.filter(s => isObject(s) && s.type === 'form_page' && s.mode === 'ending');
    if (endings.length) {
        const out = new Map();
        for (const e of (Array.isArray(graph.edges) ? graph.edges : [])) {
            if (!isObject(e) || !e.from) continue;
            if (!out.has(e.from)) out.set(e.from, []);
            out.get(e.from).push(e.to);
        }
        for (const end of endings) {
            const seen = new Set([end.id]);
            const queue = [...(out.get(end.id) || [])];
            while (queue.length) {
                const id = queue.shift();
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const node = stepById.get(id);
                if (isObject(node) && node.type === 'form_page' && node.mode !== 'ending') {
                    pushW({ code: 'form_page.input_after_ending', severity: 'warning', path: p(`steps[${node.id}]`), message: `Step ${node.id}: this form page asks a question after the closing page "${end.id}" has already been shown.`, hint: 'Move the closing page to the end of the flow.' });
                    continue;
                }
                queue.push(...(out.get(id) || []));
            }
        }
    }
}

module.exports = { walkGraphSteps, checkFormEndings };
