/**
 * App Studio canonicalizer — pass 2 over the rebuilt definition: rewrite the
 * references that pass 1 renamed, drop the ones that resolve to nothing.
 */

'use strict';

const { EVENT_NAMES } = require('../componentSpecs');
const { isObject } = require('./shared');

// ---------------------------------------------------------------------------
// Pass 2 — reference rewriting + dangling cleanup over the REBUILT tree
// (safe to mutate: everything in it is ours).
// ---------------------------------------------------------------------------

function walkNodes(def, cb) {
    const visit = (node, path) => {
        cb(node, path);
        if (Array.isArray(node.children)) node.children.forEach((c, i) => visit(c, `${path}.children[${i}]`));
    };
    def.screens.forEach((screen, si) => {
        screen.sections.forEach((section, ci) => {
            section.children.forEach((n, ni) => visit(n, `screens[${si}].sections[${ci}].children[${ni}]`));
        });
    });
}

// Rewrite {kind:'actionResult'} actionIds anywhere inside a value tree.
function rewriteActionResults(value, renameMap) {
    if (Array.isArray(value)) { value.forEach((v) => rewriteActionResults(v, renameMap)); return; }
    if (!isObject(value)) return;
    if (value.kind === 'actionResult' && typeof value.actionId === 'string' && renameMap.has(value.actionId)) {
        value.actionId = renameMap.get(value.actionId);
    }
    for (const v of Object.values(value)) rewriteActionResults(v, renameMap);
}

// Rewrite renamed screen ids inside a sequence's navigate steps (recursing
// condition/loop/switch branches).
function rewriteStepScreenRefs(steps, ren) {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
        if (!isObject(step)) continue;
        if (step.kind === 'navigate') { const to = ren(step.screenId); if (to) step.screenId = to; }
        for (const key of ['then', 'else', 'steps', 'default']) if (Array.isArray(step[key])) rewriteStepScreenRefs(step[key], ren);
        if (Array.isArray(step.cases)) for (const c of step.cases) if (isObject(c)) rewriteStepScreenRefs(c.steps, ren);
    }
}

function rewriteAndResolve(def, renameMap, push) {
    const ren = (id) => (typeof id === 'string' && renameMap.has(id) ? renameMap.get(id) : null);

    if (renameMap.size) {
        const home = ren(def.homeScreenId);
        if (home) def.homeScreenId = home;
        walkNodes(def, (node) => {
            for (const ev of EVENT_NAMES) {
                const to = ren(node[ev]);
                if (to) node[ev] = to;
            }
            rewriteActionResults(node.props, renameMap);
        });
        // actionResult bindings can also live inside action steps/effects/mappings.
        rewriteActionResults(def.actions, renameMap);
        for (const action of Object.values(def.actions)) {
            if (action.kind === 'navigate') {
                const to = ren(action.screenId);
                if (to) action.screenId = to;
            }
            if (action.kind === 'sequence') rewriteStepScreenRefs(action.steps, ren);
            for (const evKey of ['onSuccess', 'onError']) {
                if (isObject(action[evKey])) {
                    const to = ren(action[evKey].navigateTo);
                    if (to) action[evKey].navigateTo = to;
                }
            }
        }
    }

    // Dangling onClick/onSubmit/onRow* → remove, so saved drafts stay self-consistent.
    const actionIds = new Set(Object.keys(def.actions));
    walkNodes(def, (node, path) => {
        for (const ev of EVENT_NAMES) {
            if (typeof node[ev] === 'string' && !actionIds.has(node[ev])) {
                push('event.dangling', `${path}.${ev}`, `${ev} referenced unknown action "${node[ev]}" — removed. Add the action first, then wire the event.`);
                delete node[ev];
            }
        }
    });

    // homeScreenId must resolve; default to the first screen.
    const screenIds = new Set(def.screens.map((s) => s.id));
    if (!screenIds.has(def.homeScreenId)) {
        if (def.screens.length) {
            push('home.defaulted', 'homeScreenId', `homeScreenId ${def.homeScreenId === undefined ? 'was missing' : JSON.stringify(def.homeScreenId) + ' did not resolve'} — set to the first screen ("${def.screens[0].id}").`);
            def.homeScreenId = def.screens[0].id;
        } else if (typeof def.homeScreenId !== 'string') {
            def.homeScreenId = null;
        }
    }
}

module.exports = { walkNodes, rewriteActionResults, rewriteStepScreenRefs, rewriteAndResolve };
