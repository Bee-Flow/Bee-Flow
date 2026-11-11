/** A node definition as the slot containers (accordion, carousel) read their children. */
export interface SlotChildDef {
    id?: string;
    children?: SlotChildDef[];
}

/** Depth-first: is `id` this definition or one of the nodes below it? */
export function holdsNode(def: SlotChildDef | undefined, id: string): boolean {
    if (!def) return false;
    if (def.id === id) return true;
    return (def.children ?? []).some((child) => holdsNode(child, id));
}

/** The index of the child that holds the selected node, or -1 (nothing selected, or not in here). */
export function selectedChildIndex(children: unknown, selectedNodeId: string | null | undefined): number {
    if (!selectedNodeId || !Array.isArray(children)) return -1;
    return (children as SlotChildDef[]).findIndex((def) => holdsNode(def, selectedNodeId));
}
