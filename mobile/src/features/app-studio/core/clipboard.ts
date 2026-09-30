/**
 * Copy/paste over the app definition. Port of agent-hub AppStudio/state/
 * clipboard.js, pinned by clipboard.lockstep.test.ts.
 *
 *   serializeNodes(def, ids)                               -> a portable payload
 *   pasteNodes(def, payload, { screenId, sectionId, index }) -> { def, newIds }
 *
 * A copy captures the FULL subtree of each selected node, deep-cloned. An id
 * that is a descendant of another selected id is dropped, so a card and a
 * button inside it paste as ONE card. A paste re-ids every node against the
 * live definition, so ids never collide, and inserts in order.
 *
 * The in-memory buffer backs copy -> paste inside one editor session; it is
 * deterministic where the system clipboard is async and permission-gated.
 */

import { collectIds, deepClone, findNode, insertNode, reIdSubtree, subtreeIds } from './ops';
import type { AppDefinition, AppNode } from './types';

export const CLIPBOARD_KIND = 'appstudio/nodes';

export interface ClipboardPayload {
    kind: string;
    version?: number;
    nodes: AppNode[];
}

let buffer: ClipboardPayload | null = null;

export function setClipboard(payload: ClipboardPayload | null | undefined): void {
    buffer = payload && Array.isArray(payload.nodes) && payload.nodes.length ? payload : null;
}

export function getClipboard(): ClipboardPayload | null {
    return buffer;
}

export function hasClipboard(): boolean {
    return !!(buffer && Array.isArray(buffer.nodes) && buffer.nodes.length);
}

/** The top-level ids of a selection, in input order: descendants of another selected id go. */
function topLevelIds(def: AppDefinition, ids: Iterable<string> | readonly string[] | null | undefined): string[] {
    const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? (ids as string[]) : [];
    const found = list
        .map((id) => ({ id, node: findNode(def, id)?.node }))
        .filter((x): x is { id: string; node: AppNode } => !!x.node);
    const subtrees = found.map((x) => subtreeIds(x.node));
    return found
        .filter((x, i) => !found.some((_y, j) => j !== i && (subtrees[j] as Set<string>).has(x.id)))
        .map((x) => x.id);
}

export interface PasteTarget {
    screenId?: string | null;
    sectionId?: string | null;
    index?: number | null;
}

function sectionExists(def: AppDefinition, sectionId: string): boolean {
    return (def?.screens || []).some((screen) => (screen.sections || []).some((s) => s.id === sectionId));
}

function resolveTargetSection(def: AppDefinition, { screenId, sectionId }: PasteTarget = {}): string | null {
    const screens = def?.screens || [];
    if (sectionId && sectionExists(def, sectionId)) return sectionId;
    if (screenId) {
        const screen = screens.find((s) => s.id === screenId);
        if (screen?.sections?.length) return (screen.sections[0] as { id: string }).id;
    }
    return screens[0]?.sections?.[0]?.id || null;
}

function payloadNodes(payload: unknown): AppNode[] {
    const p = payload as ClipboardPayload | null | undefined;
    if (!p || p.kind !== CLIPBOARD_KIND || !Array.isArray(p.nodes)) return [];
    return p.nodes.filter((n) => n && typeof n === 'object' && typeof n.type === 'string');
}

/** Capture the selected nodes (top-level subtrees) into a portable payload. */
export function serializeNodes(
    def: AppDefinition,
    ids: Iterable<string> | readonly string[] | null | undefined,
): ClipboardPayload {
    const nodes = topLevelIds(def, ids)
        .map((id) => findNode(def, id)?.node)
        .filter((n): n is AppNode => !!n)
        .map((n) => deepClone(n));
    return { kind: CLIPBOARD_KIND, version: 1, nodes };
}

/**
 * Paste a payload into a section. Returns { def, newIds }; the same def and no
 * ids when nothing valid was pasted. Never throws.
 */
export function pasteNodes<D extends AppDefinition>(
    def: D,
    payload: unknown,
    { screenId, sectionId, index }: PasteTarget = {},
): { def: D; newIds: string[] } {
    const nodes = payloadNodes(payload);
    if (!nodes.length) return { def, newIds: [] };
    const target = resolveTargetSection(def, { screenId, sectionId });
    if (!target) return { def, newIds: [] };

    // Re-id every subtree up front against one growing set, so two pasted
    // subtrees cannot collide with each other or with the definition.
    const taken = collectIds(def);
    const clones = nodes.map((node) => reIdSubtree(node, taken));

    let out = def;
    let at = Number.isInteger(index) ? (index as number) : undefined;
    const newIds: string[] = [];
    for (const clone of clones) {
        const res = insertNode(out, { parentId: target, index: at, node: clone });
        if (res.nodeId) {
            out = res.def;
            newIds.push(res.nodeId);
            if (at != null) at += 1;
        }
    }
    return { def: out, newIds };
}
