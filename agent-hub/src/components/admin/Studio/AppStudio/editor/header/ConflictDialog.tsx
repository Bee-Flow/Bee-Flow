import useTranslation from '../../../../../../hooks/useTranslation';
import Modal from '../../../../../shared/Modal';

interface ConflictDialogProps {
    open: boolean;
    onLoadLatest?: () => void;
    onOverwrite?: () => void;
    onDismiss?: () => void;
}

/**
 * The autosave conflict ("changed in another tab"). Two real choices, so a
 * Modal with explicit buttons: Escape/backdrop merely dismisses — the
 * conflict resurfaces on the next save attempt, and dismissal must never
 * silently overwrite someone's work. The shell owns the conflict state.
 */
export default function ConflictDialog({ open, onLoadLatest, onOverwrite, onDismiss }: ConflictDialogProps) {
    const { t } = useTranslation();
    return (
        <Modal
            open={open}
            onClose={() => onDismiss?.()}
            title={t('app_studio.header.conflict_title', 'This app changed in another tab')}
            description={t('app_studio.header.conflict_desc', 'Someone (or another tab) saved a newer version while you were editing.')}
            size="md"
            footer={(
                <>
                    <button
                        type="button"
                        onClick={onOverwrite}
                        className="rounded-lg px-4 py-2 text-sm hover:bg-[var(--bg-card-hover)] [color:var(--text-primary)]! [background:var(--bg-tertiary)]!"
                    >
                        {t('app_studio.header.conflict_overwrite', 'Overwrite with mine')}
                    </button>
                    <button
                        type="button"
                        onClick={onLoadLatest}
                        className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                    >
                        {t('app_studio.header.conflict_load_latest', 'Load latest')}
                    </button>
                </>
            )}
        >
            <p className="text-sm text-[var(--text-secondary)]">
                <strong>{t('app_studio.header.conflict_load_latest', 'Load latest')}</strong>
                {' '}
                {t('app_studio.header.conflict_load_latest_desc', 'replaces your canvas with the newer version (your unsaved changes are kept in this tab’s undo history).')}
                {' '}
                <strong>{t('app_studio.header.conflict_overwrite', 'Overwrite with mine')}</strong>
                {' '}
                {t('app_studio.header.conflict_overwrite_desc', 'saves your canvas over the newer version.')}
            </p>
        </Modal>
    );
}
