import React from 'react';
import Modal from '../../components/shared/Modal';
import { useTranslation } from '../../hooks/useTranslation';

interface RecoveryKeyModalProps {
    recoveryKey: string;
    onSaved: () => void;
}

/** Recovery Key Modal: must be acknowledged, no backdrop/Escape exit. */
const RecoveryKeyModal = ({ recoveryKey, onSaved }: RecoveryKeyModalProps) => {
    const { t } = useTranslation();
    return (
        <Modal
            open
            onClose={() => {}}
            disableBackdropClose
            disableEscapeClose
            variant="bare"
            size="auto"
            zIndex={100}
            label={t('login.save_recovery_key')}
            className="w-full max-w-md"
            data-testid="recovery-key-modal"
        >
            <div className="w-full max-w-md p-6 rounded-2xl shadow-2xl space-y-5 bg-[var(--bg-secondary)]">
                <div className="text-center">
                    <div className="text-3xl mb-2">🔐</div>
                    <h3 className="text-lg font-bold text-[var(--text-primary)]">{t('login.save_recovery_key')}</h3>
                    <p className="text-sm mt-1 text-[var(--text-muted)]">{t('login.recovery_key_desc')}</p>
                </div>
                <div className="p-4 rounded-xl font-mono text-sm text-center break-all select-all cursor-text" data-testid="recovery-key-value" style={{ background: 'var(--bg-primary)', border: '2px dashed var(--border-default)', color: 'var(--text-primary)' }}>
                    {recoveryKey}
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={() => { navigator.clipboard.writeText(recoveryKey); }}
                        className="flex-1 py-2.5 rounded-xl font-medium text-sm border transition-colors border-[var(--border-default)] text-[var(--text-primary)]"
                    >📋 {t('common.copy')}</button>
                    <button
                        onClick={onSaved}
                        data-testid="recovery-key-saved"
                        className="flex-1 py-2.5 rounded-xl font-semibold text-sm text-white bg-[var(--accent-primary)]"
                    >{t('login.ive_saved_it')}</button>
                </div>
            </div>
        </Modal>
    );
};

export default RecoveryKeyModal;
