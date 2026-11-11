// @typecheck strict
/**
 * app_bind_action with a LIST of action ids (schema 3): the event runs them one after the
 * other and stops at the first that fails. A list of one is stored as the plain id, exactly
 * like a single binding; every id must name an action of the draft.
 */

'use strict';

const { LIMITS } = require('../../componentSpecs');
const ops = require('../../definitionOps');
const { pickClosestId } = require('../../validate/shared');
const { adoptCanonical } = require('../shared');
const { slotFromIds } = require('../../../shared/appDefinition/clientTriggers.mjs');

/**
 * @param {{ def: Record<string, any> }} draftWrap
 * @param {Record<string, unknown>} node  the node as found in the draft
 * @param {{ nodeId: string, event: string, actionIds: unknown[] }} args
 */
function bindActionList(draftWrap, node, { nodeId, event, actionIds }) {
    if (actionIds.length < 1 || actionIds.length > LIMITS.MAX_ACTIONS_PER_EVENT) {
        return {
            error: `An event runs 1 to ${LIMITS.MAX_ACTIONS_PER_EVENT} actions (got ${actionIds.length}).`,
            _fixHint: 'Pass the action ids in the order they must run, or one sequence action that holds the steps.',
        };
    }
    const known = Object.keys(draftWrap.def.actions || {});
    for (const id of actionIds) {
        if (typeof id === 'string' && ops.findAction(draftWrap.def, id)) continue;
        const suggestion = pickClosestId(String(id), known);
        return {
            error: `Unknown actionId ${JSON.stringify(id)}.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
            _fixHint: 'Create every action with app_set_action first, then bind the returned ids.',
        };
    }
    const slot = slotFromIds(/** @type {string[]} */ (actionIds));
    if (JSON.stringify(node[event] ?? null) === JSON.stringify(slot ?? null)) return adoptCanonical(draftWrap, draftWrap.def, { nodeId, event, actionId: slot });
    const next = structuredClone(draftWrap.def);
    ops.findNode(next, nodeId).node[event] = slot;
    return adoptCanonical(draftWrap, next, { nodeId, event, actionId: slot });
}

module.exports = { bindActionList };
