/**
 * App Studio — pure, immutable operations over an app definition, shared by
 * the server (AI builder tools, through server/appStudio/definitionOps.js) and
 * the editor (agent-hub/src/components/admin/Studio/AppStudio/state/
 * definitionOps.js, through the GENERATED agent-hub/src/shared/appDefinition/;
 * `npm run gen:shared` writes it, never edit that copy by hand).
 *
 * Only the ops whose behaviour is the same on both sides live here. Ops that
 * differ on purpose stay in the two facades: setNodeEvent, removeNode,
 * removeScreen and removeAction (the editor also strips modal, navigate and
 * row-action references; the server's builder tools do that through
 * canonicalize/validate), plus the side-only ops. lockstep.fixture.mjs and
 * lockstep.golden.json pin what both facades return.
 *
 * Every op takes a definition and returns a NEW definition with structural
 * sharing: only the screen/section/node objects on the path to the change are
 * rebuilt; untouched screens and sections keep reference identity. Inputs are
 * never mutated (fixtures may be deep-frozen). Ops that would change nothing
 * return the SAME definition reference so callers can `!==`-check for
 * dirtiness.
 *
 * Ops are spec-agnostic: insertNode receives an already-built node (the caller
 * builds it from the component catalog); "is this a container?" is answered
 * purely by the presence of a `children` array on the node.
 */

import {
    uniqueId,
    emptySection,
    clampIndex,
    insertAt,
    isNoopPatch,
    visitTree,
    rewriteNode,
    liftNode,
    findNode,
    collectIds,
    patchNodeKey,
} from './tree.mjs';

export {
    uniqueId,
    emptySection,
    clampIndex,
    insertAt,
    isNoopPatch,
    visitTree,
    rewriteNode,
    mapAllNodes,
    liftNode,
    findNode,
    findScreen,
    findSection,
    findAction,
    collectIds,
} from './tree.mjs';

// ---------------------------------------------------------------------------
// Node ops
// ---------------------------------------------------------------------------

export function updateNodeProps(def, nodeId, patch) {
    return patchNodeKey(def, nodeId, 'props', patch);
}

export function updateNodeStyle(def, nodeId, patch) {
    return patchNodeKey(def, nodeId, 'style', patch);
}

/**
 * Insert an already-built node under a section or container component.
 * `screenId` is an optional scope hint (ids are globally unique anyway).
 * Returns { def, nodeId }; on failure (missing/non-container parent) the
 * original def reference comes back with nodeId null.
 */
export function insertNode(def, { screenId, parentId, index, node } = {}) {
    if (!node || typeof node !== 'object') return { def, nodeId: null };
    // Keep the global-uniqueness invariant: a missing or already-taken id
    // gets a fresh one (the caller reads the real id from the return value).
    const taken = collectIds(def);
    const toInsert = node.id && !taken.has(node.id)
        ? node
        : { ...node, id: uniqueId('component', taken) };

    // Section parent?
    const screens = def.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const screen = screens[s];
        if (screenId && screen.id !== screenId) continue;
        const sections = screen.sections || [];
        for (let j = 0; j < sections.length; j++) {
            const section = sections[j];
            if (section.id !== parentId) continue;
            const nextSections = sections.slice();
            nextSections[j] = { ...section, children: insertAt(section.children || [], index, toInsert) };
            const nextScreens = screens.slice();
            nextScreens[s] = { ...screen, sections: nextSections };
            return { def: { ...def, screens: nextScreens }, nodeId: toInsert.id };
        }
    }

    // Container component parent? (container-ness = it carries a children array)
    const parent = findNode(def, parentId);
    if (!parent || !Array.isArray(parent.node.children)) return { def, nodeId: null };
    if (screenId && parent.screen.id !== screenId) return { def, nodeId: null };
    const { def: next } = rewriteNode(def, parentId, (p) => [
        { ...p, children: insertAt(p.children, index, toInsert) },
    ]);
    return { def: next, nodeId: toInsert.id };
}

/**
 * Move a node to (toParentId, index) — same-parent reorder or cross-
 * section/container reparent. `index` addresses the destination children
 * AFTER the node is lifted out. Moving a node into itself or its own
 * descendant is a no-op (same reference), as is a move that lands the node
 * where it already is.
 */
export function moveNode(def, nodeId, { toParentId, index } = {}) {
    const found = findNode(def, nodeId);
    if (!found) return def;
    const targetParentId = toParentId ?? found.parent.id;

    // Reparenting into the moved subtree would orphan it — refuse.
    const subtree = new Set([found.node.id]);
    visitTree(found.node.children, (n) => subtree.add(n.id));
    if (subtree.has(targetParentId)) return def;

    // Same-parent move that ends where it started is a no-op.
    if (targetParentId === found.parent.id) {
        const siblings = found.parent.children || [];
        if (clampIndex(index, siblings.length - 1) === found.index) return def;
    }

    // LIFT, don't DELETE. The editor's removeNode strips every open_modal/
    // close_modal reference in the subtree it takes out — correct for a
    // deletion, catastrophic for a move: relocating a dialog, or any container
    // holding one, silently unwired every button that opened it. The node is
    // coming straight back, so its references must survive the round trip.
    const without = liftNode(def, nodeId);
    if (without === def) return def;
    const { def: next, nodeId: inserted } = insertNode(without, {
        parentId: targetParentId, index, node: found.node,
    });
    return inserted ? next : def;
}

// ---------------------------------------------------------------------------
// Theme / meta / design / nav
// ---------------------------------------------------------------------------

export function updateTheme(def, patch) {
    if (!patch || typeof patch !== 'object' || isNoopPatch(def.theme || {}, patch)) return def;
    return { ...def, theme: { ...(def.theme || {}), ...patch } };
}

export function updateMeta(def, patch) {
    if (!patch || typeof patch !== 'object' || isNoopPatch(def.meta || {}, patch)) return def;
    return { ...def, meta: { ...(def.meta || {}), ...patch } };
}

// App Design v2 — design/nav are OPTIONAL keys (emit-when-present in the
// canonicalizer). A patch materializes the key; passing null removes it, which
// is the documented way back to byte-identical "no design" rendering.
export function updateDesign(def, patch) {
    if (patch === null) {
        if (!('design' in def)) return def;
        const { design: _dropped, ...rest } = def;
        return rest;
    }
    if (!patch || typeof patch !== 'object' || isNoopPatch(def.design || {}, patch)) return def;
    return { ...def, design: { ...(def.design || {}), ...patch } };
}

export function updateNav(def, patch) {
    if (patch === null) {
        if (!('nav' in def)) return def;
        const { nav: _dropped, ...rest } = def;
        return rest;
    }
    if (!patch || typeof patch !== 'object' || isNoopPatch(def.nav || {}, patch)) return def;
    return { ...def, nav: { ...(def.nav || {}), ...patch } };
}

// ---------------------------------------------------------------------------
// Screen / section ops
// ---------------------------------------------------------------------------

/** Append a new screen (with one empty section). Returns { def, screenId }. */
export function addScreen(def, { name } = {}) {
    const taken = collectIds(def);
    const screenId = uniqueId('screen', taken);
    const screen = {
        id: screenId,
        name: typeof name === 'string' && name.trim() ? name.trim() : 'Screen',
        icon: null,
        showInNav: true,
        maxWidth: 'medium',
        sections: [emptySection(taken)],
    };
    return { def: { ...def, screens: [...(def.screens || []), screen] }, screenId };
}

/** Shallow-patch screen settings (name/icon/showInNav/maxWidth). id and sections are op-managed and ignored. */
export function updateScreen(def, screenId, patch) {
    if (!patch || typeof patch !== 'object') return def;
    const screens = def.screens || [];
    const idx = screens.findIndex((s) => s.id === screenId);
    if (idx === -1) return def;
    const { id: _id, sections: _sections, ...rest } = patch;
    if (isNoopPatch(screens[idx], rest)) return def;
    const nextScreens = screens.slice();
    nextScreens[idx] = { ...screens[idx], ...rest };
    return { ...def, screens: nextScreens };
}

/** Insert an empty section into a screen at index (clamped). Returns { def, sectionId }. */
export function addSection(def, screenId, index) {
    const screens = def.screens || [];
    const idx = screens.findIndex((s) => s.id === screenId);
    if (idx === -1) return { def, sectionId: null };
    const section = emptySection(collectIds(def));
    const nextScreens = screens.slice();
    nextScreens[idx] = { ...screens[idx], sections: insertAt(screens[idx].sections || [], index, section) };
    return { def: { ...def, screens: nextScreens }, sectionId: section.id };
}

// ---------------------------------------------------------------------------
// Action ops
// ---------------------------------------------------------------------------

/** Upsert an action; a null/undefined id creates one. Returns { def, actionId }. */
export function setAction(def, actionIdOrNull, action) {
    if (!action || typeof action !== 'object') return { def, actionId: null };
    const actionId = actionIdOrNull || uniqueId('action', collectIds(def));
    return { def: { ...def, actions: { ...(def.actions || {}), [actionId]: action } }, actionId };
}
