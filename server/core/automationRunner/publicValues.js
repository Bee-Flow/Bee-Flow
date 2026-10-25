// @typecheck strict
'use strict';
/**
 * Public identifiers a run has seen, for the run-log redactor.
 *
 * A Talk room `token` is a room id, not a credential, but run-log redaction
 * masks any field called `token`. nextcloud_talk_* steps are exempt by tool
 * name; this covers the same token once it travels on in the output of a step
 * with no Talk tool name (loop, filter, set, call_layer, ...). The values are
 * collected from what Talk steps really emitted in THIS run, so a `token` of
 * any other origin stays masked. Held on runState under a Symbol key (like the
 * credential mask needles), so no template, expression or code step can reach
 * it; sub-states share the same Set by reference.
 */

const { MASK_VALUES } = require('./httpAuth');

const PUBLIC_VALUES = Symbol.for('beeflow.automation.publicValues');
const MAX_DEPTH = 8;

/** @param {any} node @param {Set<string>} into @param {number} depth */
function collectTokens(node, into, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
        for (const v of node) collectTokens(v, into, depth + 1);
        return;
    }
    for (const [k, v] of Object.entries(node)) {
        if (k === 'token' && typeof v === 'string' && v) into.add(v);
        else collectTokens(v, into, depth + 1);
    }
}

/**
 * Remember the room tokens a finished nextcloud_talk_* step emitted.
 * @param {any} runState @param {{ tool?: string }} step @param {any} output
 */
function notePublicValues(runState, step, output) {
    if (!runState || typeof step?.tool !== 'string' || !step.tool.startsWith('nextcloud_talk_')) return;
    collectTokens(output, (runState[PUBLIC_VALUES] ||= new Set()), 0);
}

/** @param {any} runState @returns {string[]} */
function publicValuesFor(runState) {
    return [...(runState?.[PUBLIC_VALUES] || [])];
}

/**
 * The Symbol-keyed run markers a layer sub-state must share BY REFERENCE with
 * its parent (credential mask needles and public values).
 * @param {any} runState
 */
function sharedRunMarkers(runState) {
    return { [MASK_VALUES]: runState[MASK_VALUES], [PUBLIC_VALUES]: runState[PUBLIC_VALUES] };
}

module.exports = { sharedRunMarkers, PUBLIC_VALUES, notePublicValues, publicValuesFor };
