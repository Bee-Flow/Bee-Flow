/**
 * The folder tree the Webpages IDE's FileExplorer renders. Folders are
 * implicit (path prefixes), so the tree is built from the extra files' paths.
 */

export interface TreeEntry {
    path: string;
    [meta: string]: unknown;
}

export interface TreeFile {
    type: 'file';
    name: string;
    path: string;
    meta: TreeEntry;
}

export interface TreeFolder {
    type: 'folder';
    name: string;
    path: string;
    children: TreeNode[];
}

export type TreeNode = TreeFile | TreeFolder;

/**
 * Build a nested folder tree from a flat list of {path, ...meta} entries plus
 * any client-only pending (empty) folder paths. Folders sort first, then files.
 */
export function buildTree(entries: TreeEntry[], pendingFolders: Iterable<string>): TreeNode[] {
    const root: TreeFolder = { type: 'folder', name: '', path: '', children: [] };
    const folderIndex = new Map<string, TreeFolder>();
    folderIndex.set('', root);

    const ensureFolder = (acc: string, name: string, parent: TreeFolder): TreeFolder => {
        let folder = folderIndex.get(acc);
        if (!folder) {
            folder = { type: 'folder', name, path: acc, children: [] };
            parent.children.push(folder);
            folderIndex.set(acc, folder);
        }
        return folder;
    };

    for (const entry of entries) {
        const segs = entry.path.split('/').filter(Boolean);
        let parent = root;
        let acc = '';
        for (let i = 0; i < segs.length - 1; i++) {
            acc = acc ? `${acc}/${segs[i]}` : segs[i];
            parent = ensureFolder(acc, segs[i], parent);
        }
        parent.children.push({ type: 'file', name: segs[segs.length - 1], path: entry.path, meta: entry });
    }

    // Materialise pending (empty) folders so the user can target them.
    for (const fp of pendingFolders) {
        const segs = fp.split('/').filter(Boolean);
        let parent = root;
        let acc = '';
        for (let i = 0; i < segs.length; i++) {
            acc = acc ? `${acc}/${segs[i]}` : segs[i];
            parent = ensureFolder(acc, segs[i], parent);
        }
    }

    const sortChildren = (node: TreeFolder) => {
        node.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        for (const c of node.children) if (c.type === 'folder') sortChildren(c);
    };
    sortChildren(root);
    return root.children;
}
