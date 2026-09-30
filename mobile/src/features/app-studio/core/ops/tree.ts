/**
 * Lookups and structural-sharing rewrites over the node tree.
 *
 * Port of the lookup and tree-rewrite helpers of definitionOps.js. Every
 * rewrite rebuilds only the screen/section/node objects on the path to the
 * change; untouched screens and sections keep reference identity.
 */

import type { AppAction, AppDefinition, AppNode, AppScreen, AppSection } from '../types';

/** Where a node sits. The first five fields are the web's findNode; the rest are the phone's. */
export interface NodeLocation {
    node: AppNode;
    /** The section (top-level nodes) or the container node. */
    parent: AppSection | AppNode;
    screen: AppScreen;
    section: AppSection;
    index: number;
    screenId: string;
    sectionId: string;
    parentId: string;
    /** Container node ids from the section down to the node's parent (outermost first). */
    ancestors: string[];
    /** The definition path, as the server's validation notices spell it. */
    path: string;
}

/** Depth-first visit of a node subtree (containers recurse via `children`). */
export function visitTree(children: readonly AppNode[] | undefined, visit: (node: AppNode) => void): void {
    for (const node of children || []) {
        visit(node);
        if (Array.isArray(node.children)) visitTree(node.children, visit);
    }
}

export interface WalkEntry {
    node: AppNode;
    screen: AppScreen;
    section: AppSection;
    parent: AppSection | AppNode;
    depth: number;
    path: string;
}

/** Every node in the definition, in canvas (pre-)order, with where it sits. */
export function walkNodes(def: AppDefinition | null | undefined, visit: (entry: WalkEntry) => void): void {
    (def?.screens || []).forEach((screen, s) => {
        (screen.sections || []).forEach((section, j) => {
            const walk = (children: AppNode[] | undefined, parent: AppSection | AppNode, depth: number, base: string) => {
                (children || []).forEach((node, i) => {
                    const path = `${base}.children[${i}]`;
                    visit({ node, screen, section, parent, depth, path });
                    if (Array.isArray(node.children)) walk(node.children, node, depth + 1, path);
                });
            };
            walk(section.children, section, 0, `screens[${s}].sections[${j}]`);
        });
    });
}

type Found = Pick<NodeLocation, 'node' | 'parent' | 'index' | 'ancestors' | 'path'>;

function searchChildren(
    children: AppNode[] | undefined,
    parent: AppSection | AppNode,
    nodeId: string,
    trail: { ancestors: string[]; path: string },
): Found | null {
    const list = children || [];
    for (let i = 0; i < list.length; i++) {
        const child = list[i] as AppNode;
        const path = `${trail.path}.children[${i}]`;
        if (child.id === nodeId) return { node: child, parent, index: i, ancestors: trail.ancestors, path };
        if (Array.isArray(child.children)) {
            const found = searchChildren(child.children, child, nodeId, {
                ancestors: [...trail.ancestors, child.id],
                path,
            });
            if (found) return found;
        }
    }
    return null;
}

/** Find a component node anywhere in the definition, or null. */
export function findNode(def: AppDefinition | null | undefined, nodeId: unknown): NodeLocation | null {
    const screens = def?.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const screen = screens[s] as AppScreen;
        const sections = screen.sections || [];
        for (let j = 0; j < sections.length; j++) {
            const section = sections[j] as AppSection;
            const found = searchChildren(section.children, section, nodeId as string, {
                ancestors: [],
                path: `screens[${s}].sections[${j}]`,
            });
            if (found) {
                return {
                    ...found,
                    screen,
                    section,
                    screenId: screen.id,
                    sectionId: section.id,
                    parentId: found.parent.id,
                };
            }
        }
    }
    return null;
}

export function findScreen(def: AppDefinition | null | undefined, screenId: unknown): AppScreen | null {
    return (def?.screens || []).find((s) => s.id === screenId) || null;
}

/** Find a section by id anywhere: { section, screen, index } or null (mirrors the server's). */
export function findSection(
    def: AppDefinition | null | undefined,
    sectionId: unknown,
): { section: AppSection; screen: AppScreen; index: number } | null {
    for (const screen of def?.screens || []) {
        const sections = screen.sections || [];
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i] as AppSection;
            if (section.id === sectionId) return { section, screen, index: i };
        }
    }
    return null;
}

export function findAction(def: AppDefinition | null | undefined, actionId: unknown): AppAction | null {
    return (def?.actions && actionId != null && def.actions[actionId as string]) || null;
}

/** Every id in the definition: screens, sections, components and actions. */
export function collectIds(def: AppDefinition | null | undefined): Set<string> {
    const ids = new Set<string>();
    for (const screen of def?.screens || []) {
        if (screen.id != null) ids.add(screen.id);
        for (const section of screen.sections || []) {
            if (section.id != null) ids.add(section.id);
            visitTree(section.children, (n) => {
                if (n.id != null) ids.add(n.id);
            });
        }
    }
    for (const actionId of Object.keys(def?.actions || {})) ids.add(actionId);
    return ids;
}

/** Replacement array for a found node: [] removes, [a] replaces, [a, b] inserts after. */
export type Rewrite = (node: AppNode) => AppNode[];

/** Locate `nodeId` inside `children` and splice in `fn(node)`; rebuilds only the ancestor chain. */
export function rewriteChildren(
    children: AppNode[],
    nodeId: string,
    fn: Rewrite,
): { children: AppNode[]; hit: boolean } {
    for (let i = 0; i < children.length; i++) {
        const child = children[i] as AppNode;
        if (child.id === nodeId) {
            return { children: [...children.slice(0, i), ...fn(child), ...children.slice(i + 1)], hit: true };
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
export function rewriteNode<D extends AppDefinition>(def: D, nodeId: string, fn: Rewrite): { def: D; hit: boolean } {
    const screens = def.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const screen = screens[s] as AppScreen;
        const sections = screen.sections || [];
        for (let j = 0; j < sections.length; j++) {
            const section = sections[j] as AppSection;
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

function mapTree(children: AppNode[], fn: (node: AppNode) => AppNode): AppNode[] {
    let dirty = false;
    const next = (children || []).map((child) => {
        let node = child;
        if (Array.isArray(node.children)) {
            const kids = mapTree(node.children, fn);
            if (kids !== node.children) node = { ...node, children: kids };
        }
        node = fn(node);
        if (node !== child) dirty = true;
        return node;
    });
    return dirty ? next : children;
}

/**
 * Map every node through `fn` (same-reference return = no change); children
 * are mapped before their parent. Returns the same def when nothing changed.
 */
export function mapAllNodes<D extends AppDefinition>(def: D, fn: (node: AppNode) => AppNode): D {
    let changed = false;
    const screens = (def.screens || []).map((screen) => {
        let sectionsChanged = false;
        const sections = (screen.sections || []).map((section) => {
            const children = mapTree(section.children, fn);
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
