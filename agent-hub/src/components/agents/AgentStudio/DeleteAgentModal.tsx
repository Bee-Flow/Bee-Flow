import { X, Loader2 } from 'lucide-react';
import { useId } from 'react';
import { blockHasFindings } from './deleteBlock';
import DeleteBlockedNotice from './DeleteBlockedNotice';
import type { DeleteBlock, DeleteTarget } from './useAgentDelete';
import Modal from '../../shared/Modal';
import type { TranslateFn } from '../../../hooks/useTranslation';

interface Props {
    t: TranslateFn;
    target: DeleteTarget;
    deleting: boolean;
    deleteBlocked: DeleteBlock | null;
    deleteError: string | null;
    /** Close the dialog (a no-op while the delete is in flight). */
    onDismiss: () => void;
    /** Cancel button: clears the error and the blocked stage, then closes. */
    onCancel: () => void;
    onConfirm: (force: boolean) => void;
}

/** The delete-confirmation dialog of the agent grid, with its "still in use" second stage. */
export default function DeleteAgentModal({ t, target, deleting, deleteBlocked, deleteError, onDismiss, onCancel, onConfirm }: Props) {
    const deleteTitleId = useId();
    return (
        <Modal
            open
            onClose={onDismiss}
            role="alertdialog"
            size="md"
            zIndex={1000}
            labelledBy={deleteTitleId}
            // A delete that already came back "still in use" must not be
            // dismissed by a click next to it.
            disableBackdropClose
            disableEscapeClose={deleting}
            title={
                <span id={deleteTitleId}>
                        {/* Three headings, not two. A 409 that found consumers
                            and a 409 that could not check are both refusals, but
                            only the first one may say "still in use" — the second
                            would be a claim about a scan that did not answer. */}
                        {!deleteBlocked
                            ? t('agent_studio.delete_title', 'Delete agent')
                            : blockHasFindings(deleteBlocked)
                                ? t('agent_studio.delete_blocked_title', 'This agent is still in use')
                                : t('agent_studio.delete_blocked_unknown_title', 'Could not check what uses this agent')}
                </span>
            }
            headerActions={
                <button
                    onClick={onDismiss}
                    className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    disabled={deleting}
                    aria-label={t('agent_studio.close', 'Close')}
                >
                    <X size={18} />
                </button>
            }
            footer={
                <>
                    <button
                        onClick={onCancel}
                        disabled={deleting}
                        className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                    >
                        {t('agent_studio.cancel', 'Cancel')}
                    </button>
                    {/* An arrow function, NOT `onClick={onConfirm}`: the handler's
                        first parameter is `force`, and a click event is truthy. Bound
                        bare, the first press would send ?confirm=1 and skip the very
                        check this dialog exists to show. */}
                    <button
                        onClick={() => onConfirm(!!deleteBlocked)}
                        disabled={deleting}
                        className="px-4 py-2 rounded-full text-sm bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                        {deleting && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                        <span>
                            {deleting
                                ? t('agent_studio.deleting', 'Deleting…')
                                : deleteBlocked
                                    ? t('agent_studio.delete_anyway', 'Delete anyway')
                                    : t('agent_studio.delete', 'Delete')}
                        </span>
                    </button>
                </>
            }
        >
            {deleteBlocked ? (
                <DeleteBlockedNotice summary={deleteBlocked} />
            ) : (
                <div className="text-sm text-[var(--text-secondary)]">
                    {t('agent_studio.delete_confirm', { name: target?.name || '' })}
                </div>
            )}
            {deleteError && (
                <div className="pt-2 text-xs text-red-500" role="alert">{deleteError}</div>
            )}
        </Modal>
    );
}
