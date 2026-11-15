import { Loader2, Plug, X } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import Modal from '../../shared/Modal';
import Button from '@/components/shared/Button';
import { ALERT_ERROR } from '@/components/shared/adminUi';

interface ConnectHubDialogProps {
    mode?: 'connect' | 'disconnect';
    licensed?: boolean;
    busy?: boolean;
    error?: string | null;
    onConfirm: () => void;
    onCancel: () => void;
}

// Confirm-connect dialog. `licensed` picks the copy: a licensed install
// connects with its server licence; an unlicensed one connects with a free
// registration. Reused, with different copy, for the disconnect confirm.
export default function ConnectHubDialog({ mode = 'connect', licensed = true, busy, error, onConfirm, onCancel }: ConnectHubDialogProps) {
    const { t } = useTranslation();
    const isDisconnect = mode === 'disconnect';
    const title = isDisconnect ? t('modules.disconnect_confirm_title') : t('modules.connect_title');
    const body = isDisconnect
        ? t('modules.disconnect_confirm_body')
        : (licensed ? t('modules.connect_body') : t('modules.connect_body_unlicensed'));
    const cta = isDisconnect ? t('modules.disconnect') : t('modules.connect_cta');

    return (
        <Modal
            open
            onClose={onCancel}
            size="md"
            disableBackdropClose={busy}
            disableEscapeClose={busy}
            title={
                <span className="flex items-center gap-2">
                    <Plug className={`w-4 h-4 ${isDisconnect ? 'text-[var(--error-ink)]' : 'text-[var(--text-secondary)]'}`} aria-hidden="true" />
                    {title}
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
                    <Button variant={isDisconnect ? 'danger' : 'primary'} onClick={onConfirm} busy={busy}>
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                        {cta}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{body}</p>
                {error && (
                    <div className={ALERT_ERROR} role="alert">{error}</div>
                )}
            </div>
        </Modal>
    );
}
