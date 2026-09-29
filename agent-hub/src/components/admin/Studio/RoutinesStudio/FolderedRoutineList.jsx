import { ChevronDown, ChevronRight, FolderPlus, Pencil, Trash2, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import RecentlyDeletedSection from './RecentlyDeletedSection';
import RoutineRow from './RoutineRow';
import { isSharedWithMe } from './routineStatus';
import { useTranslation } from '../../../../hooks/useTranslation';
import scopedStorage from '../../../../utils/scopedStorage';
import Modal from '../../../shared/Modal';

/**
 * The automations sidebar, grouped into folders.
 *
 * One flat level, shared across the organisation. Three decisions worth
 * stating, because each one is a trap avoided:
 *
 *  1. **Loose routines come FIRST, not last.** Everything is loose on day one;
 *     burying the whole list under a row of empty folders would make the
 *     feature a regression for anyone who never creates one.
 *  2. **Which folders are open is per user, per browser** — presentation, like
 *     the canvas edge-colour lens. Putting it on the server would mean one
 *     colleague collapsing a folder for everybody.
 *  3. **A search hides empty folders.** While filtering, a folder with no
 *     matches is noise: its header would announce a section that shows nothing.
 *
 * Routines somebody else owns and shared with the caller sit in their own
 * "Shared with me" group, never in the caller's folders: the folder is the
 * owner's filing, and a shared row is not the caller's to file. With
 * `onRestored` the list ends in "Recently deleted" (the trash). `afterFolders`
 * is drawn between the folders and the trash: the automations page puts its
 * "Building blocks" group there.
 *
 * Dropping a row on a folder header moves it. That uses the browser's own
 * drag-and-drop rather than @dnd-kit: this is a plain move between containers,
 * with no reordering and no sortable list, so it needs no context provider
 * wrapped around the sidebar.
 */

const OPEN_KEY = 'routineFoldersOpen';
const DRAG_TYPE = 'text/x-beeflow-routine';

export default function FolderedRoutineList({
    automations,
    folders,
    filtering = false,
    rowProps,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onMoveToFolder,
    onRestored = null,
    afterFolders = null,
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(() => {
        const stored = scopedStorage.getJSON(OPEN_KEY, null);
        return new Set(Array.isArray(stored) ? stored.filter(v => typeof v === 'string') : []);
    });
    const [dragOver, setDragOver] = useState(undefined);
    const [renaming, setRenaming] = useState(null);
    const [draftName, setDraftName] = useState('');
    // Creating and deleting both happen inline, in the sidebar. A
    // window.prompt/confirm would be the browser's chrome sitting on top of
    // the app, styled by the OS and unthemed — and it blocks the page while
    // it is up.
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [pendingDelete, setPendingDelete] = useState(null);

    const toggle = (id) => {
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
        const groups = new Map((folders || []).map(f => [f.id, []]));
        const rest = [];
        const sharedRows = [];
        for (const a of automations) {
            if (isSharedWithMe(a)) { sharedRows.push(a); continue; }
            // A folderId pointing at a folder this user cannot see — or one just
            // deleted elsewhere — must never make the routine disappear.
            if (a.folderId && known.has(a.folderId)) groups.get(a.folderId).push(a);
            else rest.push(a);
        }
        return { loose: rest, byFolder: groups, shared: sharedRows };
    }, [automations, folders]);

    const dropHandlers = (folderId) => ({
        onDragOver: (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDragOver(folderId);
        },
        onDragLeave: () => setDragOver(cur => (cur === folderId ? undefined : cur)),
        onDrop: (e) => {
            e.preventDefault();
            setDragOver(undefined);
            const id = e.dataTransfer.getData(DRAG_TYPE);
            if (id) onMoveToFolder?.(id, folderId);
        },
    });

    const renderRow = (a) => (
        <div
            key={a.id}
            draggable
            onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, a.id);
                e.dataTransfer.effectAllowed = 'move';
            }}
        >
            <RoutineRow {...rowProps(a)} />
        </div>
    );

    const startRename = (f) => { setRenaming(f.id); setDraftName(f.name); };
    const commitCreate = () => {
        const name = newName.trim();
        setCreating(false);
        setNewName('');
        if (name) onCreateFolder?.(name);
    };
    const commitRename = () => {
        const name = draftName.trim();
        if (renaming && name) onRenameFolder?.(renaming, name);
        setRenaming(null);
    };

    const looseTarget = dragOver === null;

    return (
        <>
            {/* Loose routines first — see the header note. Also a drop target,
                so a row can be taken back out of a folder. */}
            <div
                {...dropHandlers(null)}
                data-testid="folder-loose"
                className={looseTarget ? 'rounded-md ring-1 ring-[var(--accent)] bg-[var(--accent)]/10' : ''}
            >
                {loose.map(renderRow)}
                {looseTarget && loose.length === 0 && (
                    <div className="text-[10px] text-[var(--text-tertiary)] italic px-2 py-2">Drop here to take it out of its folder.</div>
                )}
            </div>

            {(folders || []).map((f) => {
                const rows = byFolder.get(f.id) || [];
                if (filtering && rows.length === 0) return null;
                const isOpen = open.has(f.id);
                const isTarget = dragOver === f.id;
                return (
                    <div key={f.id} className="mt-1" data-testid={`folder-${f.id}`}>
                        <div
                            {...dropHandlers(f.id)}
                            className={`group flex items-center gap-1 px-1.5 py-1 rounded-md transition ${
                                isTarget
                                    ? 'bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]'
                                    : 'hover:bg-[var(--bg-secondary)]'
                            }`}
                        >
                            <button
                                type="button"
                                onClick={() => toggle(f.id)}
                                aria-expanded={isOpen}
                                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${f.name}`}
                                className="flex items-center gap-1 flex-1 min-w-0 text-left text-[var(--text-secondary)]"
                            >
                                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                <span aria-hidden="true">{f.icon || '📁'}</span>
                                {renaming === f.id ? (
                                    <input
                                        autoFocus
                                        value={draftName}
                                        aria-label="Folder name"
                                        onChange={(e) => setDraftName(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') commitRename();
                                            if (e.key === 'Escape') setRenaming(null);
                                        }}
                                        onBlur={commitRename}
                                        className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-1 py-0.5 text-xs outline-none"
                                    />
                                ) : (
                                    <span className="truncate text-xs font-medium" title={f.name}>{f.name}</span>
                                )}
                                <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">{rows.length}</span>
                            </button>
                            <button
                                type="button"
                                title="Rename this folder"
                                aria-label={`Rename ${f.name}`}
                                onClick={() => startRename(f)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                            >
                                <Pencil size={11} />
                            </button>
                            <button
                                type="button"
                                title="Remove this folder — the automations in it stay"
                                aria-label={`Delete ${f.name}`}
                                onClick={() => setPendingDelete(f)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--text-tertiary)] hover:text-red-500"
                            >
                                <Trash2 size={11} />
                            </button>
                        </div>
                        {isOpen && (
                            <div className="ml-3 border-l border-[var(--border-default)] pl-1">
                                {rows.length === 0
                                    ? <div className="text-[10px] text-[var(--text-tertiary)] italic px-2 py-1">Empty — drag an automation here.</div>
                                    : rows.map(renderRow)}
                            </div>
                        )}
                    </div>
                );
            })}

            {shared.length > 0 && (
                <div className="mt-2" data-testid="folder-shared">
                    <div className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-tertiary)]">
                        <span className="flex-1 truncate">{t('routines.library.sharedWithMe', 'Shared with me')}</span>
                        <span className="shrink-0">{shared.length}</span>
                    </div>
                    {shared.map(a => <RoutineRow key={a.id} {...rowProps(a)} />)}
                </div>
            )}

            {!filtering && (creating ? (
                <div className="mt-1 flex items-center gap-1 px-1.5 py-1">
                    <span aria-hidden="true">📁</span>
                    <input
                        autoFocus
                        value={newName}
                        aria-label="New folder name"
                        placeholder="Folder name"
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') commitCreate();
                            if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                        }}
                        onBlur={commitCreate}
                        className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded px-1 py-0.5 text-xs outline-none"
                    />
                </div>
            ) : (
                <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="mt-1 flex items-center gap-1 w-full text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] px-2 py-1 rounded transition"
                >
                    <FolderPlus size={12} /> New folder
                </button>
            ))}

            {afterFolders}

            {!filtering && onRestored && <RecentlyDeletedSection onRestored={onRestored} />}

            {pendingDelete && (
                <ConfirmRemoveFolder
                    folder={pendingDelete}
                    count={(byFolder.get(pendingDelete.id) || []).length}
                    onCancel={() => setPendingDelete(null)}
                    onConfirm={() => { onDeleteFolder?.(pendingDelete); setPendingDelete(null); }}
                />
            )}
        </>
    );
}

/**
 * Removing a folder needs one sentence, and it is a reassuring one: the
 * automations inside are not going anywhere. Said plainly here so nobody has to
 * find out by trying it.
 */
function ConfirmRemoveFolder({ folder, count, onConfirm, onCancel }) {
    return (
        <Modal
            open
            onClose={onCancel}
            size="sm"
            label="Remove folder"
            // A removal confirm must not vanish on a click beside it.
            disableBackdropClose
            footer={
                <>
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition"
                    >
                        Remove folder
                    </button>
                </>
            }
        >
            <p className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                Remove “{folder.name}”?
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
                {count > 0
                    ? `The ${count} automation${count === 1 ? '' : 's'} in it will stay — they move back to the top of the list.`
                    : 'The folder is empty.'}
            </p>
        </Modal>
    );
}

/**
 * "Move to folder…" — the keyboard route to the same move.
 *
 * A small dialog rather than a nested submenu: the context menu is dismissed by
 * the very click that opens this, so a submenu would have to outlive its own
 * parent closing.
 */
export function MoveToFolderDialog({ routine, folders, onPick, onClose }) {
    if (!routine) return null;
    const itemClass = (active) => `w-full text-left px-2 py-1.5 rounded text-xs transition hover:bg-[var(--bg-secondary)] ${
        active ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-primary)]'
    }`;
    return (
        <Modal
            open
            onClose={onClose}
            size="sm"
            label="Move to folder"
            className="max-h-[60vh]"
        >
            <div className="p-1.5">
                <div className="flex items-center justify-between px-1.5 py-1">
                    <span className="text-xs font-semibold text-[var(--text-primary)]">Move to folder</span>
                    <button type="button" aria-label="Close" onClick={onClose} className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                        <X size={12} />
                    </button>
                </div>
                <button type="button" onClick={() => onPick(null)} className={itemClass(!routine.folderId)}>
                    No folder
                </button>
                {(folders || []).map(f => (
                    <button key={f.id} type="button" onClick={() => onPick(f.id)} className={itemClass(routine.folderId === f.id)}>
                        <span aria-hidden="true" className="mr-1.5">{f.icon || '📁'}</span>{f.name}
                    </button>
                ))}
                {(folders || []).length === 0 && (
                    <div className="text-[11px] text-[var(--text-tertiary)] italic px-2 py-2">
                        No folders yet — make one in the sidebar.
                    </div>
                )}
            </div>
        </Modal>
    );
}
