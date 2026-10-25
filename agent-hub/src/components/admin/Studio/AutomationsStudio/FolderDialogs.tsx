import { X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import type { AutomationListRow, AutomationFolder } from '../../../automation/useAutomationLibrary';
import { buildFolderTree, flattenFolderTree, moveTargets } from '../../../automation/folderTree';

// Left padding per nesting level, as whole Tailwind classes (a class built from
// a number is not generated). Deeper than the table stays at the last step.
const INDENT = ['pl-2', 'pl-5', 'pl-8', 'pl-11', 'pl-14', 'pl-16', 'pl-20', 'pl-24'];
const indentClass = (depth: number) => INDENT[Math.min(depth, INDENT.length - 1)];

/**
 * Removing a folder needs one sentence, and it is a reassuring one: the
 * automations inside are not going anywhere. Said plainly here so nobody has to
 * find out by trying it.
 */
interface ConfirmRemoveFolderProps {
    folder: AutomationFolder;
    count: number;
    /** Folders directly inside it: they move up one level. */
    subfolders: number;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmRemoveFolder({ folder, count, subfolders, onConfirm, onCancel }: ConfirmRemoveFolderProps) {
    const { t } = useTranslation();
    return (
        <Modal
            open
            onClose={onCancel}
            size="sm"
            label={t('studio_misc.folders.remove_folder', 'Remove folder')}
            // A removal confirm must not vanish on a click beside it.
            disableBackdropClose
            footer={
                <>
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {t('studio_misc.folders.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500 text-white hover:bg-red-600 transition"
                    >
                        {t('studio_misc.folders.remove_folder', 'Remove folder')}
                    </button>
                </>
            }
        >
            <p className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                {t('studio_misc.folders.remove_named', 'Remove “{name}”?', { name: folder.name })}
            </p>
            <p className="text-xs text-[var(--text-secondary)]">
                {count > 0
                    ? (count === 1
                        ? t('studio_misc.folders.stay_one', 'The 1 automation in it will stay — they move back to the top of the list.')
                        : t('studio_misc.folders.stay_many', 'The {n} automations in it will stay — they move back to the top of the list.', { n: count }))
                    : (subfolders > 0 ? null : t('studio_misc.folders.folder_empty', 'The folder is empty.'))}
            </p>
            {subfolders > 0 && (
                <p className="text-xs text-[var(--text-secondary)] mt-1">
                    {subfolders === 1
                        ? t('studio_misc.folders.subfolders_one', 'Its 1 subfolder moves up one level.')
                        : t('studio_misc.folders.subfolders_many', 'Its {n} subfolders move up one level.', { n: subfolders })}
                </p>
            )}
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
interface MoveToFolderDialogProps {
    automation: AutomationListRow | null;
    folders: AutomationFolder[];
    onPick: (folderId: string | null) => void;
    onClose: () => void;
}

export function MoveToFolderDialog({ automation, folders, onPick, onClose }: MoveToFolderDialogProps) {
    const { t } = useTranslation();
    if (!automation) return null;
    const itemClass = (active: boolean) => `w-full text-left px-2 py-1.5 rounded text-xs transition hover:bg-[var(--bg-secondary)] ${
        active ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-primary)]'
    }`;
    return (
        <Modal
            open
            onClose={onClose}
            size="sm"
            label={t('studio_misc.folders.move_to_folder', 'Move to folder')}
            className="max-h-[60vh]"
        >
            <div className="p-1.5">
                <div className="flex items-center justify-between px-1.5 py-1">
                    <span className="text-xs font-semibold text-[var(--text-primary)]">{t('studio_misc.folders.move_to_folder', 'Move to folder')}</span>
                    <button type="button" aria-label={t('studio_misc.folders.close', 'Close')} onClick={onClose} className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                        <X size={12} />
                    </button>
                </div>
                <button type="button" onClick={() => onPick(null)} className={itemClass(!automation.folderId)}>
                    {t('studio_misc.folders.no_folder', 'No folder')}
                </button>
                {flattenFolderTree(buildFolderTree(folders || [])).map(({ folder: f, depth }) => (
                    <button
                        key={f.id}
                        type="button"
                        onClick={() => onPick(f.id)}
                        className={`${itemClass(automation.folderId === f.id)} ${indentClass(depth)}`}
                    >
                        <span aria-hidden="true" className="mr-1.5">{String(f.icon || '📁')}</span>{f.name}
                    </button>
                ))}
                {(folders || []).length === 0 && (
                    <div className="text-[11px] text-[var(--text-tertiary)] italic px-2 py-2">
                        {t('studio_misc.folders.none_yet', 'No folders yet — make one in the sidebar.')}
                    </div>
                )}
            </div>
        </Modal>
    );
}

/**
 * "Move folder": pick the folder it goes under, or the top level. Itself and
 * what is below it are not offered (that would be a loop); depth and a taken
 * name are the server's to judge, and its sentence is shown if it refuses.
 */
interface MoveFolderDialogProps {
    folder: AutomationFolder | null;
    folders: AutomationFolder[];
    onPick: (parentId: string | null) => void;
    onClose: () => void;
}

export function MoveFolderDialog({ folder, folders, onPick, onClose }: MoveFolderDialogProps) {
    const { t } = useTranslation();
    if (!folder) return null;
    const allowed = new Set(moveTargets(folders || [], folder.id).map(f => f.id));
    const itemClass = (active: boolean) => `w-full text-left px-2 py-1.5 rounded text-xs transition hover:bg-[var(--bg-secondary)] ${
        active ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-primary)]'
    }`;
    return (
        <Modal
            open
            onClose={onClose}
            size="sm"
            label={t('studio_misc.folders.move_folder', 'Move folder')}
            className="max-h-[60vh]"
        >
            <div className="p-1.5">
                <div className="flex items-center justify-between px-1.5 py-1">
                    <span className="text-xs font-semibold text-[var(--text-primary)]">{t('studio_misc.folders.move_folder_named', 'Move {name}', { name: folder.name })}</span>
                    <button type="button" aria-label={t('studio_misc.folders.close', 'Close')} onClick={onClose} className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                        <X size={12} />
                    </button>
                </div>
                <button type="button" onClick={() => onPick(null)} className={itemClass(!folder.parentId)}>
                    {t('studio_misc.folders.top_level', 'Top level')}
                </button>
                {flattenFolderTree(buildFolderTree(folders || [])).filter(({ folder: f }) => allowed.has(f.id)).map(({ folder: f, depth }) => (
                    <button
                        key={f.id}
                        type="button"
                        onClick={() => onPick(f.id)}
                        className={`${itemClass(folder.parentId === f.id)} ${indentClass(depth)}`}
                    >
                        <span aria-hidden="true" className="mr-1.5">{String(f.icon || '📁')}</span>{f.name}
                    </button>
                ))}
            </div>
        </Modal>
    );
}
