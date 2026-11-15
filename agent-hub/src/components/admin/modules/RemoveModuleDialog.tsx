import { Loader2, Trash2, X } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import Modal from '../../shared/Modal';
import Button from '@/components/shared/Button';

interface RemoveModuleDialogProps {
    module: { id?: string; name: string };
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

export default function RemoveModuleDialog({ module, busy, onCancel, onConfirm }: RemoveModuleDialogProps) {
    const { t } = useTranslation();
    return (
        <Modal
            open
            onClose={onCancel}
            size="md"
            // A removal is not something to lose to a stray click on the
            // backdrop, and mid-removal there is nothing to cancel.
            disableBackdropClose
            disableEscapeClose={busy}
            title={
                <span className="flex items-center gap-2">
                    <Trash2 className="w-4 h-4 text-[var(--error-ink)]" aria-hidden="true" />
                    {t('modules.remove_confirm_title', { name: module.name })}
                </span>
            }
            headerActions={
                <button onClick={onCancel} disabled={busy} className="p-1 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('modules.cancel')}>
                    <X className="w-4 h-4 text-[var(--text-muted)]" />
                </button>
            }
            footer={
                <>
                    <Button variant="secondary" onClick={onCancel} disabled={busy}>
                        {t('modules.cancel')}
                    </Button>
                    <Button variant="danger" onClick={onConfirm} busy={busy}>
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        {t('modules.remove_confirm_cta')}
                    </Button>
                </>
            }
        >
            <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                {t('modules.remove_confirm_body')}
            </p>
        </Modal>
    );
}
