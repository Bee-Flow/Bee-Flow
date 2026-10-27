// @typecheck
/**
 * App Studio definition tree: the internal helpers (exported for the facades'
 * side-only ops) and the lookups. Part of the shared definition model; the ops
 * that build on it are in definitionOps.mjs, which re-exports everything here
 * except patchNodeKey.
 */

import { newId } from './ids.mjs';
import { SECTION_STYLE_DEFAULTS } from './sectionStyle.mjs';

// ---------------------------------------------------------------------------
// Internal helpers (exported for the facades' side-only ops)
// ---------------------------------------------------------------------------

/** newId that is guaranteed not to collide with `taken`; claims the id. */
export function uniqueId(kind, taken) {
    let id = newId(kind);
    while (taken.has(id)) id = newId(kind);
    taken.add(id);
    return id;
}

export function emptySection(taken) {
    return { id: uniqueId('section', taken), style: { ...SECTION_STYLE_DEFAULTS }, children: [] };
}

/** Clamp an insertion index into [0, len]; nullish/non-integer means append. */
export function clampIndex(index, len) {
    if (!Number.isInteger(index)) return len;
    return Math.max(0, Math.min(index, len));
}

export function insertAt(arr, index, item) {
    const next = arr.slice();
    next.splice(clampIndex(index, next.length), 0, item);
    return next;
}

/** True when a shallow patch would change nothing on `target` (Object.is). */
export function isNoopPatch(target, patch) {
    return Object.keys(patch).every((k) => Object.is(target?.[k], patch[k]));
}

/** Depth-first visit of a node subtree (containers recurse via `children`). */
export function visitTree(children, visit) {
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
export function rewriteNode(def, nodeId, fn) {
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
export function mapAllNodes(def, fn) {
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
export function patchNodeKey(def, nodeId, key, patch) {
    if (!patch || typeof patch !== 'object') return def;
    const found = findNode(def, nodeId);
    if (!found || isNoopPatch(found.node[key] || {}, patch)) return def;
    const { def: next } = rewriteNode(def, nodeId, (node) => [
        { ...node, [key]: { ...(node[key] || {}), ...patch } },
    ]);
    return next;
}

/** Detach a node without touching anything that references it. */
export function liftNode(def, nodeId) {
    const { def: removed, hit } = rewriteNode(def, nodeId, () => []);
    return hit ? removed : def;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Find a component node anywhere in the definition.
 * Returns { node, parent, screen, section, index } or null.
 * `parent` is the section (top-level nodes) or the container node.
 */
export function findNode(def, nodeId) {
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

export function findScreen(def, screenId) {
    return (def?.screens || []).find((s) => s.id === screenId) || null;
}

/** Find a section by id anywhere. Returns { section, screen, index } or null. */
export function findSection(def, sectionId) {
    for (const screen of def?.screens || []) {
        const sections = screen.sections || [];
        for (let i = 0; i < sections.length; i++) {
            if (sections[i].id === sectionId) return { section: sections[i], screen, index: i };
        }
    }
    return null;
}

export function findAction(def, actionId) {
    return (def?.actions && actionId != null && def.actions[actionId]) || null;
}

/** Every id in the definition: screens, sections, components and actions. */
export function collectIds(def) {
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
