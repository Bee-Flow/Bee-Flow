/**
 * App Studio — pure, immutable operations over an app definition (server copy).
 *
 * The frontend owns a sibling implementation at
 * agent-hub/src/components/admin/Studio/AppStudio/state/definitionOps.js;
 * the SEMANTICS here are kept identical (structural sharing, same-reference
 * returns on no-ops, container-ness = presence of a `children` array), but
 * only the ops the AI builder tools actually need are ported. Unlike the
 * frontend mirror, this copy imports the id helpers and section-style
 * defaults straight from componentSpecs.js — the authoritative source.
 *
 * Every op takes a definition and returns a NEW definition with structural
 * sharing: only the screen/section/node objects on the path to the change
 * are rebuilt. Inputs are never mutated. Ops that would change nothing
 * return the SAME definition reference so callers can `!==`-check.
 */

'use strict';

const { newId, SECTION_STYLE_DEFAULTS } = require('./componentSpecs');

// ---------------------------------------------------------------------------
// Internal helpers (mirrored from the frontend implementation)
// ---------------------------------------------------------------------------

/** newId that is guaranteed not to collide with `taken`; claims the id. */
function uniqueId(kind, taken) {
    let id = newId(kind);
    while (taken.has(id)) id = newId(kind);
    taken.add(id);
    return id;
}

function emptySection(taken) {
    return { id: uniqueId('section', taken), style: { ...SECTION_STYLE_DEFAULTS }, children: [] };
}

/** Clamp an insertion index into [0, len]; nullish/non-integer means append. */
function clampIndex(index, len) {
    if (!Number.isInteger(index)) return len;
    return Math.max(0, Math.min(index, len));
}

function insertAt(arr, index, item) {
    const next = arr.slice();
    next.splice(clampIndex(index, next.length), 0, item);
    return next;
}

/** True when a shallow patch would change nothing on `target` (Object.is). */
function isNoopPatch(target, patch) {
    return Object.keys(patch).every((k) => Object.is(target?.[k], patch[k]));
}

/** Depth-first visit of a node subtree (containers recurse via `children`). */
function visitTree(children, visit) {
    for (const node of children || []) {
        visit(node);
        if (Array.isArray(node.children)) visitTree(node.children, visit);
    }
}

/**
 * Locate `nodeId` inside `children` and splice in `fn(node)`'s replacement
 * array ([] removes, [a] replaces, [a, b] replaces-and-inserts-after).
 * Rebuilds only the ancestor chain; returns { children, hit }.
 */
function rewriteChildren(children, nodeId, fn) {
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.id === nodeId) {
            const next = [...children.slice(0, i), ...fn(child), ...children.slice(i + 1)];
            return { children: next, hit: true };
        }
        if (Array.isArray(child.children)) {
            const res = rewriteChildren(child.children, nodeId, fn);
            if (res.hit) {
                const next = children.slice();
                next[i] = { ...child, children: res.children };
                return { children: next, hit: true };
            }
        }
    }
    return { children, hit: false };
}

/** Apply rewriteChildren across the whole definition (structural sharing). */
function rewriteNode(def, nodeId, fn) {
    const screens = def.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const screen = screens[s];
        const sections = screen.sections || [];
        for (let j = 0; j < sections.length; j++) {
            const section = sections[j];
            const res = rewriteChildren(section.children || [], nodeId, fn);
            if (!res.hit) continue;
            const nextSections = sections.slice();
            nextSections[j] = { ...section, children: res.children };
            const nextScreens = screens.slice();
            nextScreens[s] = { ...screen, sections: nextSections };
            return { def: { ...def, screens: nextScreens }, hit: true };
        }
    }
    return { def, hit: false };
}

/**
 * Map every node in the tree through `fn` (same-reference return = no change);
 * children are mapped before their parent. Untouched sections/screens keep
 * reference identity; returns the same def when nothing changed.
 */
function mapAllNodes(def, fn) {
    const mapTree = (children) => {
        let dirty = false;
        const next = (children || []).map((child) => {
            let node = child;
            if (Array.isArray(node.children)) {
                const kids = mapTree(node.children);
                if (kids !== node.children) node = { ...node, children: kids };
            }
            node = fn(node);
            if (node !== child) dirty = true;
            return node;
        });
        return dirty ? next : children;
    };
    let changed = false;
    const screens = (def.screens || []).map((screen) => {
        let sectionsChanged = false;
        const sections = (screen.sections || []).map((section) => {
            const children = mapTree(section.children);
            if (children === section.children) return section;
            sectionsChanged = true;
            return { ...section, children };
        });
        if (!sectionsChanged) return screen;
        changed = true;
        return { ...screen, sections };
    });
    return changed ? { ...def, screens } : def;
}

/** Shallow-merge patch into node[key] (props/style); same def when a no-op. */
function patchNodeKey(def, nodeId, key, patch) {
    if (!patch || typeof patch !== 'object') return def;
    const found = findNode(def, nodeId);
    if (!found || isNoopPatch(found.node[key] || {}, patch)) return def;
    const { def: next } = rewriteNode(def, nodeId, (node) => [
        { ...node, [key]: { ...(node[key] || {}), ...patch } },
    ]);
    return next;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Find a component node anywhere in the definition.
 * Returns { node, parent, screen, section, index } or null.
 * `parent` is the section (top-level nodes) or the container node.
 */
function findNode(def, nodeId) {
    for (const screen of def?.screens || []) {
        for (const section of screen.sections || []) {
            const search = (children, parent) => {
                for (let i = 0; i < (children || []).length; i++) {
                    const child = children[i];
                    if (child.id === nodeId) return { node: child, parent, screen, section, index: i };
                    if (Array.isArray(child.children)) {
                        const found = search(child.children, child);
                        if (found) return found;
                    }
                }
                return null;
            };
            const found = search(section.children, section);
            if (found) return found;
        }
    }
    return null;
}

function findScreen(def, screenId) {
    return (def?.screens || []).find((s) => s.id === screenId) || null;
}

/** Find a section by id anywhere. Returns { section, screen, index } or null. */
function findSection(def, sectionId) {
    for (const screen of def?.screens || []) {
        const sections = screen.sections || [];
        for (let i = 0; i < sections.length; i++) {
            if (sections[i].id === sectionId) return { section: sections[i], screen, index: i };
        }
    }
    return null;
}

function findAction(def, actionId) {
    return (def?.actions && actionId != null && def.actions[actionId]) || null;
}

/** Every id in the definition: screens, sections, components and actions. */
function collectIds(def) {
    const ids = new Set();
    for (const screen of def?.screens || []) {
        if (screen.id != null) ids.add(screen.id);
        for (const section of screen.sections || []) {
            if (section.id != null) ids.add(section.id);
            visitTree(section.children, (n) => { if (n.id != null) ids.add(n.id); });
        }
    }
    for (const actionId of Object.keys(def?.actions || {})) ids.add(actionId);
    return ids;
}

// ---------------------------------------------------------------------------
// Node ops
// ---------------------------------------------------------------------------

function updateNodeProps(def, nodeId, patch) {
    return patchNodeKey(def, nodeId, 'props', patch);
}

function updateNodeStyle(def, nodeId, patch) {
    return patchNodeKey(def, nodeId, 'style', patch);
}

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

/**
 * Insert an already-built node under a section or container component.
 * `screenId` is an optional scope hint (ids are globally unique anyway).
 * Returns { def, nodeId }; on failure (missing/non-container parent) the
 * original def reference comes back with nodeId null.
 */
function insertNode(def, { screenId, parentId, index, node } = {}) {
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
function moveNode(def, nodeId, { toParentId, index } = {}) {
    const found = findNode(def, nodeId);
    if (!found) return def;
    const targetParentId = toParentId ?? found.parent.id;

    // Reparenting into the moved subtree would orphan it — refuse.
    const subtreeIds = new Set([found.node.id]);
    visitTree(found.node.children, (n) => subtreeIds.add(n.id));
    if (subtreeIds.has(targetParentId)) return def;

    // Same-parent move that ends where it started is a no-op.
    if (targetParentId === found.parent.id) {
        const siblings = found.parent.children || [];
        if (clampIndex(index, siblings.length - 1) === found.index) return def;
    }

    const without = removeNode(def, nodeId);
    const { def: next, nodeId: inserted } = insertNode(without, {
        parentId: targetParentId, index, node: found.node,
    });
    return inserted ? next : def;
}

function removeNode(def, nodeId) {
    const { def: next, hit } = rewriteNode(def, nodeId, () => []);
    return hit ? next : def;
}

// ---------------------------------------------------------------------------
// Theme / meta
// ---------------------------------------------------------------------------

function updateTheme(def, patch) {
    if (!patch || typeof patch !== 'object' || isNoopPatch(def.theme || {}, patch)) return def;
    return { ...def, theme: { ...(def.theme || {}), ...patch } };
}

function updateMeta(def, patch) {
    if (!patch || typeof patch !== 'object' || isNoopPatch(def.meta || {}, patch)) return def;
    return { ...def, meta: { ...(def.meta || {}), ...patch } };
}

// App Design v2 — design/nav are OPTIONAL keys (emit-when-present in the
// canonicalizer). A patch materializes the key; passing null removes it, which
// is the documented way back to byte-identical "no design" rendering.
function updateDesign(def, patch) {
    if (patch === null) {
        if (!('design' in def)) return def;
        const { design: _dropped, ...rest } = def;
        return rest;
    }
    if (!patch || typeof patch !== 'object' || isNoopPatch(def.design || {}, patch)) return def;
    return { ...def, design: { ...(def.design || {}), ...patch } };
}

function updateNav(def, patch) {
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
function addScreen(def, { name } = {}) {
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

/** Shallow-patch screen settings (name/icon/showInNav/maxWidth). id and sections are op-managed and ignored. */
function updateScreen(def, screenId, patch) {
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
function addSection(def, screenId, index) {
    const screens = def.screens || [];
    const idx = screens.findIndex((s) => s.id === screenId);
    if (idx === -1) return { def, sectionId: null };
    const section = emptySection(collectIds(def));
    const nextScreens = screens.slice();
    nextScreens[idx] = { ...screens[idx], sections: insertAt(screens[idx].sections || [], index, section) };
    return { def: { ...def, screens: nextScreens }, sectionId: section.id };
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
// Action ops
// ---------------------------------------------------------------------------

/** Upsert an action; a null/undefined id creates one. Returns { def, actionId }. */
function setAction(def, actionIdOrNull, action) {
    if (!action || typeof action !== 'object') return { def, actionId: null };
    const actionId = actionIdOrNull || uniqueId('action', collectIds(def));
    return { def: { ...def, actions: { ...(def.actions || {}), [actionId]: action } }, actionId };
}

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
    findScreen,
    findSection,
    findAction,
    collectIds,
    // Node ops
    insertNode,
    moveNode,
    removeNode,
    updateNodeProps,
    updateNodeStyle,
    setNodeVisible,
    setNodeEvent,
    // Theme / meta / design
    updateTheme,
    updateMeta,
    updateDesign,
    updateNav,
    // Screens & sections
    addScreen,
    updateScreen,
    removeScreen,
    addSection,
    updateSectionStyle,
    // Actions
    setAction,
    removeAction,
    // Variables
    setVariables,
    setPublicAccess,
};
