/**
 * Node ops: props/style/logic patches, event wiring, insert, move, remove,
 * duplicate. Port of the "Node ops" block of definitionOps.js.
 *
 * Ops are spec-agnostic: insertNode receives an already-built node, and "is
 * this a container?" is answered by the presence of a `children` array.
 */

import type { AppDefinition, AppNode, AppScreen, AppSection } from '../types';
import { NODE_EVENTS, stripModalRefs } from './actions';
import { clampIndex, deepClone, insertAt, isNoopPatch, subtreeIds, uniqueId } from './ids';
import { collectIds, findNode, rewriteNode } from './tree';

type Patch = Record<string, unknown>;

/** Shallow-merge patch into node[key] (props/style); same def when a no-op. */
function patchNodeKey<D extends AppDefinition>(def: D, nodeId: string, key: 'props' | 'style', patch: unknown): D {
    if (!patch || typeof patch !== 'object') return def;
    const found = findNode(def, nodeId);
    if (!found || isNoopPatch(found.node[key] || {}, patch as Patch)) return def;
    return rewriteNode(def, nodeId, (node) => [{ ...node, [key]: { ...(node[key] || {}), ...(patch as Patch) } }]).def;
}

export function updateNodeProps<D extends AppDefinition>(def: D, nodeId: string, patch: Patch | null | undefined): D {
    return patchNodeKey(def, nodeId, 'props', patch);
}

export function updateNodeStyle<D extends AppDefinition>(def: D, nodeId: string, patch: Patch | null | undefined): D {
    return patchNodeKey(def, nodeId, 'style', patch);
}

/** Wire (or clear, with null) a node's event to an action id. */
export function setNodeEvent<D extends AppDefinition>(
    def: D,
    nodeId: string,
    event: string,
    actionIdOrNull: string | null | undefined,
): D {
    if (!(NODE_EVENTS as readonly string[]).includes(event)) return def;
    const found = findNode(def, nodeId);
    if (!found) return def;
    const next = actionIdOrNull ?? null;
    if ((found.node[event] ?? null) === next) return def;
    return rewriteNode(def, nodeId, (node) => {
        const copy: AppNode = { ...node };
        if (next === null) delete copy[event];
        else copy[event] = next;
        return [copy];
    }).def;
}

/** Node-level logic keys the inspector's Logic section edits (all optional). */
export const LOGIC_KEYS: ReadonlySet<string> = new Set([
    'visible',
    'visibleWhen',
    'enabledWhen',
    'readOnly',
    'validations',
    'computed',
    'visibleToRoles',
]);

function isEmptyLogicValue(key: string, value: unknown): boolean {
    if (value == null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (key === 'computed' && typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

/**
 * Merge node-level logic keys. An empty value (null, blank string, empty
 * array, empty computed map) DELETES the key; an effective no-op returns the
 * same def.
 */
export function updateNodeLogic<D extends AppDefinition>(def: D, nodeId: string, patch: Patch | null | undefined): D {
    if (!patch || typeof patch !== 'object') return def;
    const found = findNode(def, nodeId);
    if (!found) return def;
    const next: AppNode = { ...found.node };
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
        if (!LOGIC_KEYS.has(key)) continue;
        if (isEmptyLogicValue(key, value)) {
            if (key in next) {
                delete next[key];
                changed = true;
            }
        } else if (next[key] !== value) {
            next[key] = value;
            changed = true;
        }
    }
    if (!changed) return def;
    return rewriteNode(def, nodeId, () => [next]).def;
}

/** Set (or clear, with an empty map) a node's computed-prop formulas. */
export function setNodeComputed<D extends AppDefinition>(
    def: D,
    nodeId: string,
    computed: Record<string, string> | null | undefined,
): D {
    return updateNodeLogic(def, nodeId, { computed: computed ?? {} });
}

export interface InsertNodeArgs {
    screenId?: string | null;
    parentId?: string | null;
    index?: number | null;
    node?: AppNode | null;
}

function insertIntoSection<D extends AppDefinition>(
    def: D,
    { screenId, parentId, index }: InsertNodeArgs,
    toInsert: AppNode,
): D | null {
    const screens = def.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const screen = screens[s] as AppScreen;
        if (screenId && screen.id !== screenId) continue;
        const sections = screen.sections || [];
        const j = sections.findIndex((sec) => sec.id === parentId);
        if (j === -1) continue;
        const section = sections[j] as AppSection;
        const nextSections = sections.slice();
        nextSections[j] = { ...section, children: insertAt(section.children || [], index, toInsert) };
        const nextScreens = screens.slice();
        nextScreens[s] = { ...screen, sections: nextSections };
        return { ...def, screens: nextScreens };
    }
    return null;
}

/**
 * Insert an already-built node under a section or container component.
 * Returns { def, nodeId }; on failure the original def with nodeId null.
 * A missing or already-taken id gets a fresh one.
 */
export function insertNode<D extends AppDefinition>(
    def: D,
    args: InsertNodeArgs = {},
): { def: D; nodeId: string | null } {
    const { screenId, parentId, index, node } = args;
    if (!node || typeof node !== 'object') return { def, nodeId: null };
    const taken = collectIds(def);
    const toInsert = node.id && !taken.has(node.id) ? node : { ...node, id: uniqueId('component', taken) };

    const inSection = insertIntoSection(def, args, toInsert);
    if (inSection) return { def: inSection, nodeId: toInsert.id };

    const parent = findNode(def, parentId);
    if (!parent || !Array.isArray(parent.node.children)) return { def, nodeId: null };
    if (screenId && parent.screen.id !== screenId) return { def, nodeId: null };
    const next = rewriteNode(def, parentId as string, (p) => [
        { ...p, children: insertAt(p.children as AppNode[], index, toInsert) },
    ]).def;
    return { def: next, nodeId: toInsert.id };
}

/**
 * Move a node to (toParentId, index): a same-parent reorder or a reparent.
 * `index` addresses the destination children AFTER the node is lifted out.
 * Moving into its own subtree, or to where it already is, is a no-op.
 * The node is LIFTED, not removed: its dialog references survive the move.
 */
export function moveNode<D extends AppDefinition>(
    def: D,
    nodeId: string,
    { toParentId, index }: { toParentId?: string | null; index?: number | null } = {},
): D {
    const found = findNode(def, nodeId);
    if (!found) return def;
    const targetParentId = toParentId ?? found.parent.id;
    if (subtreeIds(found.node).has(targetParentId)) return def;
    if (targetParentId === found.parent.id) {
        const siblings = (found.parent.children || []) as AppNode[];
        if (clampIndex(index, siblings.length - 1) === found.index) return def;
    }
    const { def: without, hit } = rewriteNode(def, nodeId, () => []);
    if (!hit) return def;
    const { def: next, nodeId: inserted } = insertNode(without, { parentId: targetParentId, index, node: found.node });
    return inserted ? next : def;
}

/** Every `modal` node id in this subtree, the node itself included. */
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
 * Remove a component and everything inside it. Dialogs in the removed subtree
 * take their open/close_modal references with them (a dangling modalId jams
 * every later save).
 */
export function removeNode<D extends AppDefinition>(def: D, nodeId: string): D {
    const found = findNode(def, nodeId);
    const modalIds = found ? modalIdsIn(found.node) : [];
    const { def: removed, hit } = rewriteNode(def, nodeId, () => []);
    if (!hit) return def;
    let next = removed;
    for (const modalId of modalIds) next = stripModalRefs(next, modalId);
    return next;
}

/**
 * Deep-clone a subtree with a fresh, collision-free id on every node. `taken`
 * is a live set, mutated as ids are claimed. Props deep, style shallow; event
 * references are kept (both copies fire the same action).
 */
export function reIdSubtree(node: AppNode, taken: Set<string> = new Set()): AppNode {
    const copy: AppNode = { ...node, id: uniqueId('component', taken) };
    if (node.props) copy.props = deepClone(node.props);
    if (node.style) copy.style = { ...node.style };
    if (Array.isArray(node.children)) copy.children = node.children.map((child) => reIdSubtree(child, taken));
    return copy;
}

/** Duplicate a node (fresh ids everywhere) right after the original. */
export function duplicateNode<D extends AppDefinition>(def: D, nodeId: string): { def: D; nodeId: string | null } {
    const found = findNode(def, nodeId);
    if (!found) return { def, nodeId: null };
    const dup = reIdSubtree(found.node, collectIds(def));
    return { def: rewriteNode(def, nodeId, (node) => [node, dup]).def, nodeId: dup.id };
}
