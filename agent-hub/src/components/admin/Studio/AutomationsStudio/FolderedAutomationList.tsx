import { FolderPlus } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import RecentlyDeletedSection from './RecentlyDeletedSection';
import AutomationRow, { type AutomationRowProps } from './AutomationRow';
import { isSharedWithMe } from './automationStatus';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import { ConfirmRemoveFolder, MoveFolderDialog } from './FolderDialogs';
import FolderHeader, { NewFolderInput } from './FolderHeader';
import type { AutomationListRow, AutomationFolder } from '../../../automation/useAutomationLibrary';
import { buildFolderTree, type FolderTreeNode } from '../../../automation/folderTree';

/**
 * The automations sidebar, grouped into folders.
 *
 * Folders nest (a folder can hold subfolders) and are shared across the
 * organisation. Four decisions worth stating, because each one is a trap avoided:
 *
 *  1. **Loose automations come FIRST, not last.** Everything is loose on day one;
 *     burying the whole list under a row of empty folders would make the
 *     feature a regression for anyone who never creates one.
 *  2. **Which folders are open is per user, per browser** — presentation, like
 *     the canvas edge-colour lens. Putting it on the server would mean one
 *     colleague collapsing a folder for everybody.
 *  3. **A search hides empty folders.** While filtering, a folder with no
 *     matches is noise: its header would announce a section that shows nothing.
 *
 * Automations somebody else owns and shared with the caller sit in their own
 * "Shared with me" group, never in the caller's folders: the folder is the
 * owner's filing, and a shared row is not the caller's to file. With
 * `onRestored` the list ends in "Recently deleted" (the trash). `afterFolders`
 * is drawn between the folders and the trash: the automations page puts its
 * "Building blocks" group there.
 *
 * Dropping a row on a folder header moves it, and dropping a folder header on
 * another folder (or on the loose list: the top level) moves the folder with
 * everything in it; the "Move folder" button is the keyboard route to the same
 * move. That uses the browser's own
 * drag-and-drop rather than @dnd-kit: this is a plain move between containers,
 * with no reordering and no sortable list, so it needs no context provider
 * wrapped around the sidebar.
 */

const OPEN_KEY = 'automationFoldersOpen';
const DRAG_TYPE = 'text/x-beeflow-automation';
const DRAG_FOLDER_TYPE = 'text/x-beeflow-folder';

interface FolderedAutomationListProps {
    automations: AutomationListRow[];
    folders: AutomationFolder[];
    filtering?: boolean;
    rowProps: (a: AutomationListRow) => AutomationRowProps;
    onCreateFolder: (name: string, parentId?: string | null) => Promise<void>;
    onMoveFolder?: ((id: string, parentId: string | null) => Promise<void>) | null;
    onRenameFolder: (id: string, name: string) => Promise<void>;
    onDeleteFolder: (folder: AutomationFolder) => Promise<void>;
    onMoveToFolder: (automationId: string, folderId: string | null) => Promise<void>;
    onRestored?: (() => Promise<void>) | null;
    afterFolders?: React.JSX.Element | null;
}

export default function FolderedAutomationList({
    automations,
    folders,
    filtering = false,
    rowProps,
    onCreateFolder,
    onMoveFolder = null,
    onRenameFolder,
    onDeleteFolder,
    onMoveToFolder,
    onRestored = null,
    afterFolders = null,
}: FolderedAutomationListProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(() => {
        const stored = scopedStorage.getJSON<unknown>(OPEN_KEY, null);
        return new Set<string>(Array.isArray(stored) ? stored.filter(v => typeof v === 'string') : []);
    });
    const [dragOver, setDragOver] = useState<string | null | undefined>(undefined);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [draftName, setDraftName] = useState('');
    // Creating and deleting both happen inline, in the sidebar. A
    // window.prompt/confirm would be the browser's chrome sitting on top of
    // the app, styled by the OS and unthemed — and it blocks the page while
    // it is up.
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [pendingDelete, setPendingDelete] = useState<AutomationFolder | null>(null);
    // A subfolder being named (the id of the folder it goes into), and a folder being moved by the dialog.
    const [creatingIn, setCreatingIn] = useState<string | null>(null);
    const [newSubName, setNewSubName] = useState('');
    const [movingFolder, setMovingFolder] = useState<AutomationFolder | null>(null);

    const toggle = (id: string) => {
        setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            scopedStorage.setJSON(OPEN_KEY, [...next]);
            return next;
        });
    };

    const { loose, byFolder, shared } = useMemo(() => {
        const known = new Set((folders || []).map(f => f.id));
        const groups = new Map<string, AutomationListRow[]>((folders || []).map(f => [f.id, []]));
        const rest: AutomationListRow[] = [];
        const sharedRows: AutomationListRow[] = [];
        for (const a of automations) {
            if (isSharedWithMe(a)) { sharedRows.push(a); continue; }
            // A folderId pointing at a folder this user cannot see — or one just
            // deleted elsewhere — must never make the automation disappear.
            if (a.folderId && known.has(a.folderId)) groups.get(a.folderId)?.push(a);
            else rest.push(a);
        }
        return { loose: rest, byFolder: groups, shared: sharedRows };
    }, [automations, folders]);

    const tree = useMemo(() => buildFolderTree(folders || []), [folders]);
    // Automations in a folder and everything below it: what a closed folder shows, and what a search keeps.
    const totals = useMemo(() => {
        const out = new Map<string, number>();
        const count = (node: FolderTreeNode<AutomationFolder>): number => {
            const n = (byFolder.get(node.folder.id) || []).length + node.children.reduce((sum, c) => sum + count(c), 0);
            out.set(node.folder.id, n);
            return n;
        };
        tree.forEach(count);
        return out;
    }, [tree, byFolder]);

    const dropHandlers = (folderId: string | null) => ({
        onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDragOver(folderId);
        },
        onDragLeave: () => setDragOver(cur => (cur === folderId ? undefined : cur)),
        onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(undefined);
            const id = e.dataTransfer.getData(DRAG_TYPE);
            if (id) { onMoveToFolder?.(id, folderId); return; }
            // A folder dropped on a folder (or on the loose list: the top level). The server refuses a loop.
            const dragged = e.dataTransfer.getData(DRAG_FOLDER_TYPE);
            if (dragged && dragged !== folderId) onMoveFolder?.(dragged, folderId);
        },
    });

    const renderRow = (a: AutomationListRow) => (
        <div
            key={a.id}
            draggable
            onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, a.id);
                e.dataTransfer.effectAllowed = 'move';
            }}
        >
            <AutomationRow {...rowProps(a)} />
        </div>
    );

    const startRename = (f: AutomationFolder) => { setRenaming(f.id); setDraftName(f.name as string); };
    const commitCreate = () => {
        const name = newName.trim();
        setCreating(false);
        setNewName('');
        if (name) onCreateFolder?.(name);
    };
    const commitCreateSub = () => {
        const name = newSubName.trim();
        const parentId = creatingIn;
        setCreatingIn(null);
        setNewSubName('');
        if (name && parentId) onCreateFolder?.(name, parentId);
    };
    const startSub = (f: AutomationFolder) => {
        // The new folder must be visible where it lands.
        setOpen((prev) => {
            if (prev.has(f.id)) return prev;
            const next = new Set(prev).add(f.id);
            scopedStorage.setJSON(OPEN_KEY, [...next]);
            return next;
        });
        setNewSubName('');
        setCreatingIn(f.id);
    };
    const commitRename = () => {
        const name = draftName.trim();
        if (renaming && name) onRenameFolder?.(renaming, name);
        setRenaming(null);
    };

    const renderFolder = (node: FolderTreeNode<AutomationFolder>): React.JSX.Element | null => {
        const f = node.folder;
        const rows = byFolder.get(f.id) || [];
        const total = totals.get(f.id) ?? rows.length;
        if (filtering && total === 0) return null;
        const isOpen = open.has(f.id);
        const isTarget = dragOver === f.id;
        return (
            <div key={f.id} className="mt-1" data-testid={`folder-${f.id}`}>
                <FolderHeader
                    folder={f}
                    total={total}
                    isOpen={isOpen}
                    isTarget={isTarget}
                    filtering={filtering}
                    canMove={onMoveFolder != null}
                    renaming={renaming === f.id}
                    draftName={draftName}
                    dropProps={dropHandlers(f.id)}
                    onDragStart={(e) => {
                        e.stopPropagation();
                        e.dataTransfer.setData(DRAG_FOLDER_TYPE, f.id);
                        e.dataTransfer.effectAllowed = 'move';
                    }}
                    onToggle={() => toggle(f.id)}
                    onDraftChange={setDraftName}
                    onCommitRename={commitRename}
                    onCancelRename={() => setRenaming(null)}
                    onStartSub={() => startSub(f)}
                    onMove={() => setMovingFolder(f)}
                    onRename={() => startRename(f)}
                    onDelete={() => setPendingDelete(f)}
                />
                {isOpen && (
                    <div className="ml-3 border-l border-[var(--border-default)] pl-1">
                        {creatingIn === f.id && (
                            <NewFolderInput
                                value={newSubName}
                                label={t('studio_misc.folders.subfolder_name', 'Subfolder name')}
                                onChange={setNewSubName}
                                onCommit={commitCreateSub}
                                onCancel={() => { setCreatingIn(null); setNewSubName(''); }}
                            />
                        )}
                        {node.children.map((child) => renderFolder(child))}
                        {rows.length === 0 && node.children.length === 0 && creatingIn !== f.id
                            ? <div className="text-[10px] text-[var(--text-tertiary)] italic px-2 py-1">{t('studio_misc.folders.empty', 'Empty — drag an automation here.')}</div>
                            : rows.map(renderRow)}
                    </div>
                )}
            </div>
        );
    };

    const looseTarget = dragOver === null;

    return (
        <>
            {/* Loose automations first — see the header note. Also a drop target,
                so a row can be taken back out of a folder. */}
            <div
                {...dropHandlers(null)}
                data-testid="folder-loose"
                className={looseTarget ? 'rounded-md ring-1 ring-[var(--accent)] bg-[var(--accent)]/10' : ''}
            >
                {loose.map(renderRow)}
                {looseTarget && loose.length === 0 && (
                    <div className="text-[10px] text-[var(--text-tertiary)] italic px-2 py-2">{t('studio_misc.folders.drop_here', 'Drop here to take it out of its folder.')}</div>
                )}
            </div>

            {tree.map((node) => renderFolder(node))}

            {shared.length > 0 && (
                <div className="mt-2" data-testid="folder-shared">
                    <div className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]">
                        <span className="flex-1 truncate">{t('automations.library.sharedWithMe', 'Shared with me')}</span>
                        <span className="shrink-0">{shared.length}</span>
                    </div>
                    {shared.map(a => <AutomationRow key={a.id} {...rowProps(a)} />)}
                </div>
            )}

            {!filtering && (creating ? (
                <NewFolderInput
                    value={newName}
                    label={t('studio_misc.folders.new_folder_name', 'New folder name')}
                    onChange={setNewName}
                    onCommit={commitCreate}
                    onCancel={() => { setCreating(false); setNewName(''); }}
                />
            ) : (
                <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="mt-1 flex items-center gap-1 w-full text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] px-2 py-1 rounded transition"
                >
                    <FolderPlus size={12} /> {t('studio_misc.folders.new_folder', 'New folder')}
                </button>
            ))}

            {afterFolders}

            {!filtering && onRestored && <RecentlyDeletedSection onRestored={onRestored} />}

            <MoveFolderDialog
                folder={movingFolder}
                folders={folders}
                onPick={(parentId) => { const id = movingFolder?.id; setMovingFolder(null); if (id) onMoveFolder?.(id, parentId); }}
                onClose={() => setMovingFolder(null)}
            />

            {pendingDelete && (
                <ConfirmRemoveFolder
                    folder={pendingDelete}
                    count={(byFolder.get(pendingDelete.id) || []).length}
                    subfolders={folders.filter(x => x.parentId === pendingDelete.id).length}
                    onCancel={() => setPendingDelete(null)}
                    onConfirm={() => { onDeleteFolder?.(pendingDelete); setPendingDelete(null); }}
                />
            )}
        </>
    );
}

// The dialogs live in FolderDialogs.tsx; this is where the rest of the app imports the move dialog from.
export { MoveToFolderDialog } from './FolderDialogs';
