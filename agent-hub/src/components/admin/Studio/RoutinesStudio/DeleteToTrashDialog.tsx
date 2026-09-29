import { X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';

/**
 * Confirm deleting an automation. A delete is no longer final: the routine
 * waits in the trash for 30 days with its runs, and "Recently deleted" at the
 * foot of the library brings it back. The copy says so, because "cannot be
 * undone" used to make people keep routines they no longer wanted.
 */
export default function DeleteToTrashDialog({
    routine,
    onConfirm,
    onCancel,
}: {
    routine: { title?: string | null } | null;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    const titleId = useId();
    if (!routine) return null;
    const title = routine.title || t('routines.library.untitled', 'Untitled automation');
    return (
        <Modal
            open
            onClose={onCancel}
            variant="bare"
            size="md"
            zIndex={1000}
            labelledBy={titleId}
            className="bg-[var(--bg-primary)] shadow-xl border border-[var(--border-default)]"
        >
            <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--border-default)]">
                <div id={titleId} className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('routines.library.deleteTitle', 'Delete "{title}"?', { title })}
                </div>
                <button
                    type="button"
                    onClick={onCancel}
                    aria-label={t('routines.library.close', 'Close')}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                    <X size={18} />
                </button>
            </div>
            <div className="px-5 py-4 text-sm text-[var(--text-secondary)]">
                {t('routines.library.deleteBody', 'Moves to the trash for 30 days; runs are kept. You can restore it from "Recently deleted".')}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-default)]">
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                >
                    {t('routines.library.cancel', 'Cancel')}
                </button>
                <button
                    type="button"
                    onClick={onConfirm}
                    className="px-4 py-2 rounded-full text-sm bg-[var(--error)] text-white hover:opacity-90"
                >
                    {t('routines.library.moveToTrash', 'Move to trash')}
                </button>
            </div>
        </Modal>
    );
}
