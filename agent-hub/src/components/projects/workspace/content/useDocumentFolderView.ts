// Which folder of a project's Documents tab is open, what it shows, and the
// actions on the folders (api/queries/projectDocumentFolders.ts).

import { useMemo, useState } from 'react';

import { useDocumentFolderActions, useDocumentFolders, type DocumentFolder } from '@/api/queries/projectDocumentFolders';

/** The documents in the open folder (all of them when none is open), and how many each folder holds. */
export function folderView<T extends { id: string }>(items: T[], placements: Record<string, string>, folders: DocumentFolder[], current: string | null) {
    const known = new Set(folders.map((f) => f.id));
    const counts: Record<string, number> = {};
    for (const item of items) {
        const f = placements[item.id];
        if (f && known.has(f)) counts[f] = (counts[f] || 0) + 1;
    }
    const shown = current && known.has(current) ? items.filter((item) => placements[item.id] === current) : items;
    return { shown, counts, current: current && known.has(current) ? current : null };
}

export function useDocumentFolderView<T extends { id: string }>(projectId: string, items: T[]) {
    const query = useDocumentFolders(projectId);
    const actions = useDocumentFolderActions(projectId);
    const [selected, setSelected] = useState<string | null>(null);
    const folders = useMemo(() => query.data?.folders ?? [], [query.data]);
    const placements = useMemo(() => query.data?.placements ?? {}, [query.data]);
    const view = useMemo(() => folderView(items, placements, folders, selected), [items, placements, folders, selected]);
    const busy = actions.create.isPending || actions.rename.isPending || actions.remove.isPending || actions.place.isPending;
    const failed = actions.create.isError || actions.rename.isError || actions.remove.isError || actions.place.isError;
    return {
        folders, placements, busy, failed, ...view,
        select: setSelected,
        create: (name: string) => actions.create.mutate(name, {
            onSuccess: (body) => {
                const id = (body as { folder?: { id?: unknown } } | null)?.folder?.id;
                if (typeof id === 'string') setSelected(id);
            },
        }),
        rename: (folderId: string, name: string) => actions.rename.mutate({ folderId, name }),
        remove: (folder: DocumentFolder) => actions.remove.mutate(folder.id, { onSuccess: () => setSelected(null) }),
        move: (documentId: string, folderId: string | null) => actions.place.mutate({ documentId, folderId }),
    };
}
