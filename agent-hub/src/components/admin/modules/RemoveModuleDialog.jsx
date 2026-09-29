import { Loader2, Trash2, X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import Modal from '../../shared/Modal';

export default function RemoveModuleDialog({ module, busy, onCancel, onConfirm }) {
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
                    <Trash2 className="w-4 h-4" style={{ color: '#ef4444' }} aria-hidden="true" />
                    {t('modules.remove_confirm_title', { name: module.name })}
                </span>
            }
            headerActions={
                <button onClick={onCancel} disabled={busy} className="p-1 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('modules.cancel')}>
                    <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                </button>
            }
            footer={
                <>
                    <button
                        onClick={onCancel}
                        disabled={busy}
                        className="px-3 py-2 rounded-lg text-sm border disabled:opacity-50"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)', borderColor: 'var(--border-default)' }}
                    >
                        {t('modules.cancel')}
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={busy}
                        className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                        style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.35)' }}
                    >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        {t('modules.remove_confirm_cta')}
                    </button>
                </>
            }
        >
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {t('modules.remove_confirm_body')}
            </p>
        </Modal>
    );
}
