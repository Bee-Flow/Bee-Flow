/**
 * The cards view's sections: one per folder, in the sidebar's tree order
 * (a folder before its subfolders, siblings by name), then the automations in
 * no folder. React-free, so the grouping can be tested as data.
 *
 * - A library without folders gets `null`: no headers, one plain grid.
 * - A folder with nothing (left) in it after filtering gets no section; the
 *   sidebar is where empty folders live.
 * - A folderId pointing at a folder the caller cannot see counts as loose,
 *   the same rule as the sidebar and the folder filter.
 * - The rows keep the order they arrive in (the chosen sort).
 */
import { buildFolderTree, flattenFolderTree, folderPath, type TreeFolder } from '../../../automation/folderTree';
import { NO_FOLDER, type AutomationRecord } from './overviewModel';

export interface FolderSection {
    /** The folder id, or NO_FOLDER for the loose automations. */
    id: string;
    /** "Finance / Invoices"; empty for the loose section (the view names it). */
    path: string;
    /** 0 for a top-level folder; the loose section is 0 too. */
    depth: number;
    rows: AutomationRecord[];
}

export function folderSectionsOf(rows: readonly AutomationRecord[], folders: readonly TreeFolder[] | null | undefined): FolderSection[] | null {
    if (!folders || folders.length === 0) return null;
    const byFolder = new Map<string, AutomationRecord[]>(folders.map(f => [f.id, []]));
    const loose: AutomationRecord[] = [];
    for (const a of rows) {
        const bucket = a.folderId ? byFolder.get(a.folderId) : undefined;
        if (bucket) bucket.push(a);
        else loose.push(a);
    }
    const sections: FolderSection[] = [];
    for (const node of flattenFolderTree(buildFolderTree(folders))) {
        const list = byFolder.get(node.folder.id) || [];
        if (list.length === 0) continue;
        sections.push({ id: node.folder.id, path: folderPath(folders, node.folder.id), depth: node.depth, rows: list });
    }
    if (loose.length > 0) sections.push({ id: NO_FOLDER, path: '', depth: 0, rows: loose });
    return sections;
}
