/**
 * The folder tree of the automations sidebar, from the flat list the server
 * answers (each folder with a `parentId`). Pure functions, no React.
 *
 * A folder whose parent is not in the list (one the caller cannot see, or one
 * just deleted elsewhere) is shown at the top level rather than lost.
 */

export interface TreeFolder {
    id: string;
    name?: string;
    parentId?: string | null;
}

export interface FolderTreeNode<F extends TreeFolder> {
    folder: F;
    depth: number;
    children: FolderTreeNode<F>[];
}

const nameOf = (f: TreeFolder) => String(f.name ?? '').toLowerCase();

/** The forest, siblings sorted by name, each node with its depth (0 = top level). */
export function buildFolderTree<F extends TreeFolder>(folders: readonly F[]): FolderTreeNode<F>[] {
    const nodes = new Map<string, FolderTreeNode<F>>(folders.map((folder) => [folder.id, { folder, depth: 0, children: [] }]));
    const roots: FolderTreeNode<F>[] = [];
    for (const node of nodes.values()) {
        const parent = node.folder.parentId ? nodes.get(node.folder.parentId) : undefined;
        // A parent that is the folder itself (bad data) must not hide it.
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
    }
    const settle = (list: FolderTreeNode<F>[], depth: number, seen: Set<string>) => {
        list.sort((a, b) => nameOf(a.folder).localeCompare(nameOf(b.folder)));
        for (const node of list) {
            node.depth = depth;
            if (seen.has(node.folder.id)) { node.children = []; continue; }
            seen.add(node.folder.id);
            settle(node.children, depth + 1, seen);
        }
    };
    settle(roots, 0, new Set());
    return roots;
}

/** Every node in display order (a folder before its children). */
export function flattenFolderTree<F extends TreeFolder>(roots: readonly FolderTreeNode<F>[]): FolderTreeNode<F>[] {
    const out: FolderTreeNode<F>[] = [];
    const walk = (list: readonly FolderTreeNode<F>[]) => { for (const n of list) { out.push(n); walk(n.children); } };
    walk(roots);
    return out;
}

/** The ids of everything below `id`, itself not included. */
export function descendantIds(folders: readonly TreeFolder[], id: string): Set<string> {
    const children = new Map<string, string[]>();
    for (const f of folders) {
        if (!f.parentId) continue;
        children.set(f.parentId, [...(children.get(f.parentId) ?? []), f.id]);
    }
    const out = new Set<string>();
    const stack = [...(children.get(id) ?? [])];
    while (stack.length) {
        const next = stack.pop() as string;
        if (out.has(next) || next === id) continue;
        out.add(next);
        stack.push(...(children.get(next) ?? []));
    }
    return out;
}

/** "Finance / Invoices": the names from the top level down. */
export function folderPath(folders: readonly TreeFolder[], id: string): string {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const names: string[] = [];
    const seen = new Set<string>();
    for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        seen.add(cur.id);
        names.unshift(cur.name ?? '');
    }
    return names.join(' / ');
}

/** The folders a folder may be moved under: not itself, not anything below it. Null parent (the top level) is always offered by the caller. */
export function moveTargets<F extends TreeFolder>(folders: readonly F[], id: string): F[] {
    const blocked = descendantIds(folders, id);
    blocked.add(id);
    return folders.filter((f) => !blocked.has(f.id));
}
