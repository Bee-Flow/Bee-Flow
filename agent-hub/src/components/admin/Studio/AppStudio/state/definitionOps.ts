/**
 * App Studio — pure, immutable operations over an app definition (editor facade).
 *
 * The ops the editor shares with the server (lookups, insert/move, props and
 * style patches, theme/meta/design/nav, screens, sections, setAction) and the
 * id helpers come from @shared/appDefinition: a GENERATED copy of
 * server/shared/appDefinition/ (`npm run gen:shared`; never edit it by hand).
 * This file adds the editor's own ops, and the ones whose editor behaviour
 * differs from the server's on purpose: setNodeEvent (every NODE_EVENTS
 * event), removeNode (strips modal references), removeScreen (strips navigate
 * references) and removeAction (strips every event and row/column action).
 * definitionOps.lockstep.test.ts pins what every op returns.
 *
 * Every op takes a definition and returns a NEW definition with structural
 * sharing: only the screen/section/node objects on the path to the change are
 * rebuilt — untouched screens and sections keep reference identity. Inputs
 * are never mutated (fixtures may be deep-frozen). Ops that would change
 * nothing return the SAME definition reference so callers can `!==`-check
 * for dirtiness.
 */

import {
    uniqueId,
    emptySection,
    isNoopPatch,
    rewriteNode,
    mapAllNodes,
    findNode,
    findScreen,
    collectIds,
} from '@shared/appDefinition/definitionOps.mjs';
import { ID_RE } from '@shared/appDefinition/ids.mjs';
import type { AppAction, AppDefinition, AppNode, AppScreen, AppSection } from '../inspector/appDefinition';

export { ID_PREFIXES, ID_RE, newId } from '@shared/appDefinition/ids.mjs';
export {
    findNode,
    findScreen,
    findSection,
    findAction,
    collectIds,
    updateNodeProps,
    updateNodeStyle,
    insertNode,
    moveNode,
    updateTheme,
    updateMeta,
    updateDesign,
    updateNav,
    addScreen,
    updateScreen,
    addSection,
    setAction,
} from '@shared/appDefinition/definitionOps.mjs';
import { NODE_EVENTS, removeAction, stripModalRefs, stripScreenRefs } from './definitionRefs';
export { NODE_EVENTS, removeAction } from './definitionRefs';
export { ensureIds } from './definitionIds';
export {
    getVisibleToRoles, setVisibleToRoles, listDefinitionRoles, setDefinitionRoles,
    listVariables, setVariable, renameVariable, removeVariable, isVisibleToRole,
} from './definitionRoles';
export type { RoleRef, VariableDef } from './definitionRoles';

/** JSON-shaped deep clone (definitions are plain data by contract). */
export function deepClone<T>(value: T): T {
    if (Array.isArray(value)) return value.map(deepClone) as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
        return out as T;
    }
    return value;
}

/** Every id in a node's subtree (root included). */
export function subtreeIds(node: AppNode): Set<string> {
    const ids = new Set<string>([node.id]);
    const walk = (children: AppNode[] | undefined) => {
        for (const child of children || []) { ids.add(child.id); walk(child.children); }
    };
    walk(node.children);
    return ids;
}

// ---------------------------------------------------------------------------
// Node ops
// ---------------------------------------------------------------------------

/** Wire (or clear, with null) a node's event to an action id. */
export function setNodeEvent(def: AppDefinition, nodeId: string, event: string, actionIdOrNull: string | null | undefined): AppDefinition {
    if (!NODE_EVENTS.includes(event)) return def;
    const found = findNode(def, nodeId);
    if (!found) return def;
    const next = actionIdOrNull ?? null;
    if ((found.node[event] ?? null) === next) return def;
    const { def: out } = rewriteNode(def, nodeId, (node: AppNode) => {
        const copy: AppNode = { ...node };
        if (next === null) delete copy[event];
        else copy[event] = next;
        return [copy];
    });
    return out;
}

// Node-level logic keys the inspector's Logic section edits (all v2 additive,
// all optional). An "empty" value clears the key rather than persisting noise.
const LOGIC_KEYS = new Set(['visible', 'visibleWhen', 'enabledWhen', 'readOnly', 'validations', 'computed', 'visibleToRoles']);

function isEmptyLogicValue(key: string, value: unknown): boolean {
    if (value == null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (key === 'computed' && typeof value === 'object') return Object.keys(value as object).length === 0;
    return false;
}

/**
 * Merge node-level logic keys (visible/visibleWhen/enabledWhen/readOnly/
 * validations/computed/visibleToRoles). An empty value (null, blank string,
 * empty array, empty computed map) DELETES the key. Structural sharing: an
 * effective no-op returns the same def reference.
 */
export function updateNodeLogic(def: AppDefinition, nodeId: string, patch: Record<string, unknown> | null | undefined): AppDefinition {
    if (!patch || typeof patch !== 'object') return def;
    const found = findNode(def, nodeId);
    if (!found) return def;
    const node = found.node;
    const next: AppNode = { ...node };
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (!LOGIC_KEYS.has(key)) continue;
        if (isEmptyLogicValue(key, value)) {
            if (key in next) { delete next[key]; changed = true; }
        } else if (next[key] !== value) {
            next[key] = value;
            changed = true;
        }
    }
    if (!changed) return def;
    const { def: out } = rewriteNode(def, nodeId, () => [next]);
    return out;
}

/** Set (or clear, with an empty map) a node's computed-prop formulas. */
export function setNodeComputed(def: AppDefinition, nodeId: string, computed: Record<string, unknown> | null | undefined): AppDefinition {
    return updateNodeLogic(def, nodeId, { computed: computed ?? {} });
}

/**
 * Remove a component (and everything inside it).
 *
 * A `modal` node is also an ACTION TARGET: open_modal/close_modal name it by
 * id. Deleting one used to leave those references behind, and a dangling
 * modalId is a hard validation error server-side (validate.js checkModalRef) —
 * so PUT /:id/definition 422s, useAppAutosave records the failure without
 * advancing its baseline, and every later keystroke re-fires the same rejected
 * save. The editor then refuses to close, because closing flushes. Deleting a
 * dialog jammed the whole editor on an error about a component that no longer
 * existed.
 *
 * So the modal references go with it, exactly as removeScreen already does for
 * screens: an open/close_modal ACTION aimed at a removed dialog is removed
 * (taking its event wiring with it), and modal steps inside sequences are
 * stripped. Deleting a container removes the dialogs INSIDE it too, so the
 * whole subtree is what gets cleaned up, not just the node named.
 */
export function removeNode(def: AppDefinition, nodeId: string): AppDefinition {
    const found = findNode(def, nodeId);
    const modalIds = found ? modalIdsIn(found.node) : [];
    const { def: removed, hit } = rewriteNode(def, nodeId, () => []);
    if (!hit) return def;
    let next: AppDefinition = removed;
    for (const modalId of modalIds) next = stripModalRefs(next, modalId);
    return next;
}

/** Every `modal` node id in this subtree — the node itself included. */
function modalIdsIn(node: AppNode): string[] {
    const ids: string[] = [];
    const walk = (n: AppNode | null | undefined) => {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'modal' && typeof n.id === 'string') ids.push(n.id);
        for (const child of n.children || []) walk(child);
    };
    walk(node);
    return ids;
}

/**
 * Deep-clone a node subtree, assigning a fresh, collision-free component id to
 * every node in it. `taken` is a live Set of ids already in use (mutated as new
 * ids are claimed) so many subtrees can be re-id'd against one definition
 * without colliding with each other. Props are deep-cloned; style is shallow-
 * copied; onClick/onSubmit action references are preserved (both copies fire the
 * same action). Pure — the input node is never mutated.
 */
export function reIdSubtree(node: AppNode, taken: Set<string> = new Set<string>()): AppNode {
    const copy: AppNode = { ...node, id: uniqueId('component', taken) };
    if (node.props) copy.props = deepClone(node.props);
    if (node.style) copy.style = { ...(node.style as object) };
    if (Array.isArray(node.children)) copy.children = node.children.map((child) => reIdSubtree(child, taken));
    return copy;
}

/**
 * Duplicate a node (and its whole subtree) with fresh ids everywhere and
 * insert the copy right after the original. Returns { def, nodeId } where
 * nodeId is the duplicate's root id (null when the node doesn't exist).
 */
export function duplicateNode(def: AppDefinition, nodeId: string): { def: AppDefinition; nodeId: string | null } {
    const found = findNode(def, nodeId);
    if (!found) return { def, nodeId: null };
    const dup = reIdSubtree(found.node, collectIds(def));
    const { def: next } = rewriteNode(def, nodeId, (node: AppNode) => [node, dup]);
    return { def: next, nodeId: dup.id };
}

// ---------------------------------------------------------------------------
// AI browsing (theme/meta/design/nav are shared, see the header)
// ---------------------------------------------------------------------------

/**
 * Turn AI browsing on or off for the app, and set the domains it may reach.
 *
 * Deliberately NOT reachable from the builder tool surface (see
 * server/appStudio/builderTools/schemas.js): the AI that writes an app's steps
 * must never be able to grant itself a browser. This is the human owner's
 * switch, and it lives in App settings for that reason.
 *
 * Passing null removes the key entirely, so an app that never wanted browsing
 * canonicalizes exactly as it did before the feature existed.
 */
export function updateAiBrowsing(def: AppDefinition, patch: Record<string, unknown> | null): AppDefinition {
    if (patch === null) {
        if (!('aiBrowsing' in def)) return def;
        const { aiBrowsing: _dropped, ...rest } = def;
        return rest;
    }
    if (!patch || typeof patch !== 'object' || isNoopPatch((def.aiBrowsing as object) || {}, patch)) return def;
    return { ...def, aiBrowsing: { ...((def.aiBrowsing as object) || {}), ...patch } };
}

/**
 * Remove a screen. Refuses (same reference) when it is the last one; repoints
 * homeScreenId at the first remaining screen if it targeted the removed one,
 * and strips every navigate reference to it — a navigate ACTION aimed at the
 * screen goes (taking its event wiring with it, via removeAction), as do
 * onSuccess/onError navigateTo and navigate steps inside sequences. A dangling
 * screen reference is a hard validation error server-side, so leaving one
 * behind makes every later save fail.
 */
export function removeScreen(def: AppDefinition, screenId: string): AppDefinition {
    const screens: AppScreen[] = def.screens || [];
    if (screens.length <= 1 || !screens.some((s) => s.id === screenId)) return def;
    const remaining = screens.filter((s) => s.id !== screenId);
    let next: AppDefinition = { ...def, screens: remaining };
    if (def.homeScreenId === screenId) next.homeScreenId = remaining[0].id;
    for (const [actionId, action] of Object.entries(next.actions || {})) {
        if (action && action.kind === 'navigate' && action.screenId === screenId) {
            next = removeAction(next, actionId);
        }
    }
    const actions = stripScreenRefs(next.actions, screenId);
    return actions === next.actions ? next : { ...next, actions };
}

/**
 * Remove a section. Screens always keep at least one section: removing the
 * only section replaces it with a fresh empty one instead.
 */
export function removeSection(def: AppDefinition, sectionId: string): AppDefinition {
    const screens: AppScreen[] = def.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const screen = screens[s];
        const sections: AppSection[] = screen.sections || [];
        if (!sections.some((sec) => sec.id === sectionId)) continue;
        const remaining = sections.filter((sec) => sec.id !== sectionId);
        const nextScreens = screens.slice();
        nextScreens[s] = {
            ...screen,
            sections: remaining.length ? remaining : [emptySection(collectIds(def))],
        };
        return { ...def, screens: nextScreens };
    }
    return def;
}

