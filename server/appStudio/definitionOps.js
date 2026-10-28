// @typecheck
/**
 * App Studio — pure, immutable operations over an app definition (server facade).
 *
 * The ops both sides share live in server/shared/appDefinition/definitionOps.mjs
 * (the editor gets a GENERATED copy of it; see scripts/shared-mirror.manifest.json).
 * This file adds the ops only the AI builder tools need, and the ones whose
 * server behaviour differs from the editor's on purpose: setNodeEvent (only
 * onClick/onSubmit), removeNode/removeScreen/removeAction (no reference
 * stripping beyond onClick/onSubmit; canonicalize/validate handle the rest).
 * server/shared/appDefinition/lockstep.golden.json pins what every op returns.
 *
 * Every op takes a definition and returns a NEW definition with structural
 * sharing: only the screen/section/node objects on the path to the change
 * are rebuilt. Inputs are never mutated. Ops that would change nothing
 * return the SAME definition reference so callers can `!==`-check.
 */

'use strict';

const shared = require('../shared/appDefinition/definitionOps.mjs');

const {
    uniqueId,
    findNode,
    findSection,
    rewriteNode,
    mapAllNodes,
    liftNode,
    isNoopPatch,
} = shared;

// ---------------------------------------------------------------------------
// Node ops (server-only)
// ---------------------------------------------------------------------------

/** Set node.visible (boolean); same def when unchanged or node missing. */
function setNodeVisible(def, nodeId, visible) {
    if (typeof visible !== 'boolean') return def;
    const found = findNode(def, nodeId);
    if (!found || found.node.visible === visible) return def;
    const { def: next } = rewriteNode(def, nodeId, (node) => [{ ...node, visible }]);
    return next;
}

/** Wire (or clear, with null) a node's onClick/onSubmit to an action id. */
function setNodeEvent(def, nodeId, event, actionIdOrNull) {
    if (event !== 'onClick' && event !== 'onSubmit') return def;
    const found = findNode(def, nodeId);
    if (!found) return def;
    const next = actionIdOrNull ?? null;
    if ((found.node[event] ?? null) === next) return def;
    const { def: out } = rewriteNode(def, nodeId, (node) => {
        const copy = { ...node };
        if (next === null) delete copy[event];
        else copy[event] = next;
        return [copy];
    });
    return out;
}

function removeNode(def, nodeId) {
    return liftNode(def, nodeId);
}

// ---------------------------------------------------------------------------
// Screen / section ops (server-only)
// ---------------------------------------------------------------------------

/**
 * Remove a screen. Refuses (same reference) when it is the last one; repoints
 * homeScreenId at the first remaining screen if it targeted the removed one.
 */
function removeScreen(def, screenId) {
    const screens = def.screens || [];
    if (screens.length <= 1 || !screens.some((s) => s.id === screenId)) return def;
    const remaining = screens.filter((s) => s.id !== screenId);
    const next = { ...def, screens: remaining };
    if (def.homeScreenId === screenId) next.homeScreenId = remaining[0].id;
    return next;
}

/** Shallow-merge a style patch onto a section. Same def when section missing. */
function updateSectionStyle(def, sectionId, patch) {
    if (!patch || typeof patch !== 'object') return def;
    const found = findSection(def, sectionId);
    if (!found || isNoopPatch(found.section.style || {}, patch)) return def;
    const screens = def.screens.slice();
    const sIdx = screens.indexOf(found.screen);
    const sections = found.screen.sections.slice();
    sections[found.index] = { ...found.section, style: { ...(found.section.style || {}), ...patch } };
    screens[sIdx] = { ...found.screen, sections };
    return { ...def, screens };
}

// ---------------------------------------------------------------------------
// Action ops (server-only)
// ---------------------------------------------------------------------------

/** Remove an action and strip every onClick/onSubmit that pointed at it. */
function removeAction(def, actionId) {
    if (!def.actions || !(actionId in def.actions)) return def;
    const actions = { ...def.actions };
    delete actions[actionId];
    return mapAllNodes({ ...def, actions }, (node) => {
        if (node.onClick !== actionId && node.onSubmit !== actionId) return node;
        const copy = { ...node };
        if (copy.onClick === actionId) delete copy.onClick;
        if (copy.onSubmit === actionId) delete copy.onSubmit;
        return copy;
    });
}

/**
 * Replace the whole declared-variable list. Whole-list, not upsert, because the
 * AI tool it backs is shaped like app_set_roles: the model sees and fixes the
 * set as a unit rather than issuing thirty calls.
 *
 * EMIT-WHEN-PRESENT: an empty list deletes the key, so an app that ends up
 * with no variables is byte-identical to one that never had any.
 */
function setVariables(def, variables) {
    const list = Array.isArray(variables) ? variables : [];
    if (!list.length) {
        const { variables: _dropped, ...rest } = def;
        return rest;
    }
    return { ...def, variables: list };
}

/**
 * Open (or close) a PUBLIC entry point on the app: the screens an anonymous
 * visitor may open at /p/<token>. Passing null closes it, and the key goes away
 * entirely — an app that never opted in must serialise byte-identically to
 * before this feature existed (the design/nav/variables precedent).
 *
 * Shape validation and screen-id resolution belong to canonicalize.js +
 * appStudio/publicAccess.js; this is only the write.
 */
function setPublicAccess(def, publicAccess) {
    if (!publicAccess) {
        const { publicAccess: _dropped, ...rest } = def;
        return rest;
    }
    return { ...def, publicAccess };
}

module.exports = {
    uniqueId,
    // Lookups
    findNode,
    findScreen: shared.findScreen,
    findSection,
    findAction: shared.findAction,
    collectIds: shared.collectIds,
    // Node ops
    insertNode: shared.insertNode,
    moveNode: shared.moveNode,
    removeNode,
    updateNodeProps: shared.updateNodeProps,
    updateNodeStyle: shared.updateNodeStyle,
    setNodeVisible,
    setNodeEvent,
    // Theme / meta / design
    updateTheme: shared.updateTheme,
    updateMeta: shared.updateMeta,
    updateDesign: shared.updateDesign,
    updateNav: shared.updateNav,
    // Screens & sections
    addScreen: shared.addScreen,
    updateScreen: shared.updateScreen,
    removeScreen,
    addSection: shared.addSection,
    updateSectionStyle,
    // Actions
    setAction: shared.setAction,
    removeAction,
    // Variables
    setVariables,
    setPublicAccess,
};

/** @typedef {import('./builderTools').AppDef} AppDef */

/** @typedef {import('./builderTools').AppNode} AppNode */
