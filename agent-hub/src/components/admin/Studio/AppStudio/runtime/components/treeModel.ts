/**
 * App Studio runtime: the pure part of the tree (AppTree.tsx, schema 3). Rows become nodes
 * nested by their parent field; what is drawn is bounded by depth and by count.
 */

export type TreeRow = Record<string, unknown>;

export interface TreeNode {
    key: string;
    row: TreeRow;
    level: number;
    children: TreeNode[];
    /** Rows below this node that are deeper than maxDepth (not drawn, counted). */
    hiddenBelow: number;
}

export interface TreeOptions {
    idKey: string;
    parentKey: string;
    maxDepth: number;
    maxNodes: number;
}

export interface TreeModel {
    roots: TreeNode[];
    /** Items left out because maxNodes was reached. */
    cut: number;
}

/** An id as a key: a plain value, or a relation's `{ id }` (or the first of a list of them). */
export function idOf(value: unknown): string | null {
    const v = Array.isArray(value) ? value[0] : value;
    if (v && typeof v === 'object') return idOf((v as { id?: unknown }).id);
    if (typeof v === 'string') return v || null;
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

/** The rows grouped under their parent's key ('' for the top level), in source order. */
function byParent(rows: readonly TreeRow[], opts: TreeOptions): Map<string, TreeRow[]> {
    const ids = new Set(rows.map((row) => idOf(row[opts.idKey])).filter((id): id is string => id !== null));
    const out = new Map<string, TreeRow[]>();
    for (const row of rows) {
        const own = idOf(row[opts.idKey]);
        const parent = idOf(row[opts.parentKey]);
        // A row whose parent is not among the rows (filtered away, or itself) is a top-level item.
        const at = parent !== null && parent !== own && ids.has(parent) ? parent : '';
        const list = out.get(at);
        if (list) list.push(row); else out.set(at, [row]);
    }
    return out;
}

/** Build the tree. A row is placed once; a cycle never reaches the top level and is left out. */
export function buildTree(rows: readonly TreeRow[], opts: TreeOptions): TreeModel {
    const groups = byParent(rows, opts);
    const placed = new Set<string>();
    let budget = Math.max(1, opts.maxNodes);
    let cut = 0;
    const countBelow = (key: string, seen: Set<string>): number => {
        let n = 0;
        for (const row of groups.get(key) ?? []) {
            const id = idOf(row[opts.idKey]);
            if (id === null || seen.has(id)) continue;
            seen.add(id);
            n += 1 + countBelow(id, seen);
        }
        return n;
    };
    const place = (row: TreeRow, level: number, index: number): TreeNode | null => {
        const id = idOf(row[opts.idKey]);
        const key = id ?? `row:${level}:${index}`;
        if (id !== null && placed.has(id)) return null;
        if (budget <= 0) {
            cut += 1;
            return null;
        }
        budget -= 1;
        if (id !== null) placed.add(id);
        const node: TreeNode = { key, row, level, children: [], hiddenBelow: 0 };
        if (id === null) return node;
        if (level >= opts.maxDepth) {
            node.hiddenBelow = countBelow(id, new Set(placed));
            return node;
        }
        (groups.get(id) ?? []).forEach((child, i) => {
            const built = place(child, level + 1, i);
            if (built) node.children.push(built);
        });
        return node;
    };
    const roots: TreeNode[] = [];
    (groups.get('') ?? []).forEach((row, i) => {
        const built = place(row, 1, i);
        if (built) roots.push(built);
    });
    return { roots, cut };
}

/** The items a keyboard moves through: the expanded part of the tree, top to bottom. */
export function visibleNodes(roots: readonly TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
    const out: TreeNode[] = [];
    const walk = (list: readonly TreeNode[]) => {
        for (const node of list) {
            out.push(node);
            if (node.children.length && expanded.has(node.key)) walk(node.children);
        }
    };
    walk(roots);
    return out;
}

/** The parent of `key` among `roots`, or null at the top level. */
export function parentOf(roots: readonly TreeNode[], key: string): TreeNode | null {
    for (const node of roots) {
        if (node.children.some((child) => child.key === key)) return node;
        const deeper = parentOf(node.children, key);
        if (deeper) return deeper;
    }
    return null;
}
