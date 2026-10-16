import { useEffect, useId } from 'react';
import Modal from '../../shared/Modal';
import type { TranslateFn } from '../../../hooks/useTranslation';

interface Props {
    t: TranslateFn;
    onCancel: () => void;
    onDiscard: () => void;
}

/** "Leaving will discard this draft" — shown while a dirty, unsaved draft would be replaced. */
export default function UnsavedChangesModal({ t, onCancel, onDiscard }: Props) {
    const unsavedTitleId = useId();
    // Escape closes the unsaved-changes modal.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);
    return (
        <Modal
            open
            onClose={onCancel}
            role="alertdialog"
            size="md"
            zIndex={1200}
            labelledBy={unsavedTitleId}
            title={<span id={unsavedTitleId}>{t('agent_studio.unsaved_title', 'Unsaved changes')}</span>}
            footer={
                <>
                    <button
                        onClick={onCancel}
                        className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {t('agent_studio.cancel', 'Cancel')}
                    </button>
                    <button
                        onClick={onDiscard}
                        className="px-4 py-2 rounded-full text-sm bg-red-500 text-white hover:bg-red-600 transition"
                    >
                        {t('agent_studio.discard', 'Discard')}
                    </button>
                </>
            }
        >
            <div className="text-sm text-[var(--text-secondary)]">
                {t('agent_studio.unsaved_body', 'Your draft agent has not been saved yet. Leaving will discard these changes.')}
            </div>
        </Modal>
    );
}
