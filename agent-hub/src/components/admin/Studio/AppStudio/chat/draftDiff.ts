import { collectIds } from '../state/definitionOps';

/**
 * App Studio AI builder — cheap, pure diff between two app definitions.
 *
 * diffDefinitions(prevDef, nextDef) → {
 *   addedIds        Set — ids present in next but not in prev (screens,
 *                         sections, components and actions)
 *   changedIds      Set — ids present in both whose OWN shape changed
 *                         (shallow: a container is not "changed" just
 *                         because a descendant changed)
 *   addedOnScreens  Set — screen ids where at least one addition landed
 *                         (a brand-new screen counts as its own addition)
 * }
 *
 * Used per `draft` SSE event to pulse just-added nodes and follow the AI to
 * the screen it is editing. Signatures are JSON-based (definitions are plain
 * JSON by contract and small), with child collections excluded so identity
 * stays shallow.
 */

/** A node of the definition tree (component); only `id` and `children` matter here. */
interface DefNode {
    id?: string | null;
    children?: DefNode[] | null;
    [key: string]: unknown;
}

interface DefSection extends DefNode {
    children?: DefNode[] | null;
}

interface DefScreen {
    id?: string | null;
    sections?: DefSection[] | null;
    [key: string]: unknown;
}

/** An app definition as far as the diff reads it. */
export interface DiffDefinition {
    screens?: DefScreen[] | null;
    actions?: Record<string, unknown> | null;
    [key: string]: unknown;
}

export interface DefinitionDiff {
    addedIds: Set<string>;
    changedIds: Set<string>;
    addedOnScreens: Set<string>;
    [key: string]: unknown;
}

/** One indexed entity: its shallow signature and the screen it sits on. */
interface IndexEntry {
    sig: string | null;
    screenId: string | null;
}

export function diffDefinitions(prevDef: DiffDefinition | null | undefined, nextDef: DiffDefinition | null | undefined): DefinitionDiff {
    const addedIds = new Set<string>();
    const changedIds = new Set<string>();
    const addedOnScreens = new Set<string>();
    if (!nextDef) return { addedIds, changedIds, addedOnScreens };

    const prevIds = collectIds(prevDef || {});
    const prevIndex = indexDefinition(prevDef);

    for (const [id, entry] of indexDefinition(nextDef)) {
        if (!prevIds.has(id)) {
            addedIds.add(id);
            if (entry.screenId) addedOnScreens.add(entry.screenId);
        } else {
            const before = prevIndex.get(id);
            if (before && before.sig !== entry.sig) changedIds.add(id);
        }
    }
    return { addedIds, changedIds, addedOnScreens };
}

/** id → { sig, screenId } for every screen/section/component/action. */
function indexDefinition(def: DiffDefinition | null | undefined): Map<string, IndexEntry> {
    const map = new Map<string, IndexEntry>();
    for (const screen of def?.screens || []) {
        const screenId = screen.id ?? null;
        if (screenId != null) {
            map.set(screenId, { sig: signature(screen, 'sections'), screenId });
        }
        for (const section of screen.sections || []) {
            if (section.id != null) {
                map.set(section.id, { sig: signature(section, 'children'), screenId });
            }
            walk(section.children, (node) => {
                if (node.id != null) {
                    map.set(node.id, { sig: signature(node, 'children'), screenId });
                }
            });
        }
    }
    for (const [actionId, action] of Object.entries(def?.actions || {})) {
        map.set(actionId, { sig: signature(action, null), screenId: null });
    }
    return map;
}

function walk(children: DefNode[] | null | undefined, visit: (node: DefNode) => void): void {
    for (const node of children || []) {
        visit(node);
        if (Array.isArray(node.children)) walk(node.children, visit);
    }
}

/** JSON signature of an entity with its child collection excluded. */
function signature(obj: unknown, childKey: string | null): string | null {
    try {
        return JSON.stringify(obj, (key, value: unknown) => (childKey && key === childKey ? undefined : value));
    } catch {
        return null;
    }
}

export default diffDefinitions;
