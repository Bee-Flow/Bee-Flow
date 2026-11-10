// @typecheck strict
/**
 * App Studio definition model: the ops that rearrange a screen's sections and an app's screens.
 * Part of the shared definition model (definitionOps.mjs re-exports every op here); the editor
 * reaches them through state/structureOps.ts, the server through appStudio/definitionOps.js.
 *
 *   updateSection(def, sectionId, patch)          set or (null) remove the keys beside id, style, children
 *   moveSection(def, sectionId, index)            reorder within the section's own screen
 *   duplicateSection(def, sectionId)              a copy right after it → { def, sectionId }
 *   moveScreen(def, screenId, index)              reorder the screens (the nav order)
 *   duplicateScreen(def, screenId, { name })      a copy right after it → { def, screenId }
 *
 * The rules of definitionOps.mjs hold: a new definition with structural sharing, inputs never
 * mutated, the SAME reference back when nothing changes. Spec-agnostic: limits (sections per
 * screen, screens per app) are the caller's check.
 *
 * A copy gets a fresh id for the screen or section and for every component inside it, and keeps
 * everything else, action references included: a copied button runs the same action as the
 * original (as duplicating one component does). An open_modal action therefore still opens the
 * ORIGINAL modal; on a duplicated screen that modal is on the other screen.
 */

import { uniqueId, collectIds, clampIndex, insertAt, findSection } from './tree.mjs';

// Structural shapes only (no index signatures), so the editor's own AppDefinition types fit them.
/** @typedef {{ id?: string, children?: AnyNode[] }} AnyNode */
/** @typedef {{ id?: string, children?: AnyNode[] }} Section */
/** @typedef {{ id?: string, name?: string, sections?: Section[] }} Screen */
/** @typedef {{ screens?: Screen[] }} Definition */
/** @typedef {Set<string>} TakenIds */

/** The section keys the op-managed patch never touches. */
const BASE_SECTION_KEYS = Object.freeze(['id', 'style', 'children']);

/**
 * JSON-shaped deep copy (definitions are plain data by contract).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneData(value) {
    if (Array.isArray(value)) return /** @type {T} */ (value.map(cloneData));
    if (value && typeof value === 'object') {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = cloneData(v);
        return /** @type {T} */ (out);
    }
    return value;
}

/**
 * Equal as stored data: the same primitive, or the same JSON.
 * @param {unknown} a
 * @param {unknown} b
 */
function sameData(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A node list copied with a fresh component id on every node; claims the ids in `taken`.
 * @param {AnyNode[] | undefined} nodes
 * @param {TakenIds} taken
 * @returns {AnyNode[]}
 */
function reIdNodes(nodes, taken) {
    return (Array.isArray(nodes) ? nodes : []).map((node) => {
        /** @type {AnyNode} */
        const copy = { ...cloneData(node), id: uniqueId('component', taken) };
        if (Array.isArray(node.children)) copy.children = reIdNodes(node.children, taken);
        return copy;
    });
}

/**
 * @param {Section} section
 * @param {TakenIds} taken
 * @returns {Section}
 */
function copySection(section, taken) {
    return { ...cloneData(section), id: uniqueId('section', taken), children: reIdNodes(section.children, taken) };
}

/**
 * `def` with the sections of `screen` replaced by `sections` (a new list).
 * @param {Definition} def
 * @param {Screen} screen
 * @param {Section[]} sections
 * @returns {Definition}
 */
function withSections(def, screen, sections) {
    const screens = (def.screens || []).slice();
    screens[screens.indexOf(screen)] = { ...screen, sections };
    return { ...def, screens };
}

/**
 * Set the keys of `patch` on a section; a null or undefined value removes the key. id, style
 * and children are ignored (style has its own op). Same def when nothing changes.
 * @template {Definition} D
 * @param {D} def
 * @param {string} sectionId
 * @param {Record<string, unknown> | null | undefined} patch
 * @returns {D}
 */
export function updateSection(def, sectionId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return def;
    const found = findSection(def, sectionId);
    if (!found) return def;
    /** @type {Record<string, unknown>} */
    const next = { ...found.section };
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (BASE_SECTION_KEYS.includes(key)) continue;
        if (value === null || value === undefined) {
            if (Object.hasOwn(next, key)) { delete next[key]; changed = true; }
        } else if (!sameData(next[key], value)) {
            next[key] = value;
            changed = true;
        }
    }
    if (!changed) return def;
    const sections = found.screen.sections.slice();
    sections[found.index] = next;
    return /** @type {D} */ (withSections(def, found.screen, sections));
}

/**
 * Move a section to `index` among its screen's sections (counted without it).
 * @template {Definition} D
 * @param {D} def
 * @param {string} sectionId
 * @param {number} index
 * @returns {D}
 */
export function moveSection(def, sectionId, index) {
    const found = findSection(def, sectionId);
    if (!found) return def;
    const rest = found.screen.sections.filter((/** @type {Section} */ _, /** @type {number} */ i) => i !== found.index);
    const to = clampIndex(index, rest.length);
    if (to === found.index) return def;
    return /** @type {D} */ (withSections(def, found.screen, insertAt(rest, to, found.section)));
}

/**
 * Copy a section, components included, right after itself. Returns { def, sectionId }.
 * @template {Definition} D
 * @param {D} def
 * @param {string} sectionId
 * @returns {{ def: D, sectionId: string | null }}
 */
export function duplicateSection(def, sectionId) {
    const found = findSection(def, sectionId);
    if (!found) return { def, sectionId: null };
    const copy = copySection(found.section, collectIds(def));
    const next = withSections(def, found.screen, insertAt(found.screen.sections, found.index + 1, copy));
    return { def: /** @type {D} */ (next), sectionId: copy.id ?? null };
}

/**
 * Move a screen to `index` among the screens (counted without it).
 * @template {Definition} D
 * @param {D} def
 * @param {string} screenId
 * @param {number} index
 * @returns {D}
 */
export function moveScreen(def, screenId, index) {
    /** @type {Screen[]} */
    const screens = def.screens || [];
    const from = screens.findIndex((s) => s.id === screenId);
    if (from === -1) return def;
    const rest = screens.filter((_, i) => i !== from);
    const to = clampIndex(index, rest.length);
    if (to === from) return def;
    return { ...def, screens: insertAt(rest, to, screens[from]) };
}

/**
 * Copy a screen, sections and components included, right after itself. `name` (trimmed) names
 * the copy; without one it keeps the original's name. Returns { def, screenId }.
 * @template {Definition} D
 * @param {D} def
 * @param {string} screenId
 * @param {{ name?: string | null }} [options]
 * @returns {{ def: D, screenId: string | null }}
 */
export function duplicateScreen(def, screenId, { name } = {}) {
    /** @type {Screen[]} */
    const screens = def.screens || [];
    const from = screens.findIndex((s) => s.id === screenId);
    if (from === -1) return { def, screenId: null };
    const taken = collectIds(def);
    const original = screens[from];
    /** @type {Screen} */
    const copy = {
        ...cloneData(original),
        id: uniqueId('screen', taken),
        sections: (original.sections || []).map((section) => copySection(section, taken)),
    };
    if (typeof name === 'string' && name.trim()) copy.name = name.trim();
    return { def: { ...def, screens: insertAt(screens, from + 1, copy) }, screenId: copy.id ?? null };
}
