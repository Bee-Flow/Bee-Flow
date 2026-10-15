import { collectIds } from '../state/definitionOps';

/** A component (or nested container) of an app definition. */
interface DefNode {
    id?: string | null;
    children?: DefNode[];
    [key: string]: unknown;
}

interface DefSection extends DefNode {
    children?: DefNode[];
}

interface DefScreen {
    id?: string | null;
    sections?: DefSection[];
    [key: string]: unknown;
}

/** An app definition, as far as the diff reads it. */
export interface AppDefinitionLike {
    screens?: DefScreen[];
    actions?: Record<string, unknown>;
    [key: string]: unknown;
}

interface IndexEntry {
    sig: string | null;
    screenId: string | null;
}

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
export function diffDefinitions(prevDef: AppDefinitionLike | null | undefined, nextDef: AppDefinitionLike | null | undefined) {
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
function indexDefinition(def: AppDefinitionLike | null | undefined): Map<string, IndexEntry> {
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

function walk(children: DefNode[] | undefined, visit: (node: DefNode) => void): void {
    for (const node of children || []) {
        visit(node);
        if (Array.isArray(node.children)) walk(node.children, visit);
    }
}

/** JSON signature of an entity with its child collection excluded. */
function signature(obj: unknown, childKey: string | null): string | null {
    try {
        return JSON.stringify(obj, (key, value) => (childKey && key === childKey ? undefined : value));
    } catch {
        return null;
    }
}

export default diffDefinitions;
