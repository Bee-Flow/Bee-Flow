import { X } from 'lucide-react';
import React, { useId } from 'react';
import { IconButton } from './IconButton';
import { useTranslation } from '../../../../hooks/useTranslation';
import SharedModal from '../../../shared/Modal';

/**
 * The subscriptions console's dialog skin — header, scrolling body, optional
 * footer — drawn inside the shared Modal, which owns the backdrop, Escape,
 * the focus trap and focus restore. `onClose` may be undefined (ConfirmModal
 * passes none while it is busy); then nothing closes it, as before.
 */
export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-md' }) {
    const { t } = useTranslation();
    const titleId = useId();

    return (
        <SharedModal
            open={open}
            onClose={() => onClose?.()}
            variant="bare"
            size="auto"
            zIndex={1000}
            labelledBy={title ? titleId : undefined}
            className={`${width} bg-[var(--bg-secondary)] border border-[var(--border-default)] shadow-2xl overflow-hidden`}
        >
            <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--border-default)]">
                <div className="min-w-0">
                    {title && <h3 id={titleId} className="text-base font-bold text-[var(--text-primary)] truncate">{title}</h3>}
                    {subtitle && <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{subtitle}</p>}
                </div>
                <IconButton icon={X} size="sm" onClick={onClose} title={t('admin_subscriptions.ui_close', 'Close')} />
            </div>
            <div className="px-5 py-4 overflow-y-auto">{children}</div>
            {footer && (
                <div className="px-5 py-3 border-t border-[var(--border-default)] bg-[var(--bg-tertiary)]/40 flex justify-end gap-2">
                    {footer}
                </div>
            )}
        </SharedModal>
    );
}

export function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = undefined, confirmTone = 'danger', busy = false }) {
    const { t } = useTranslation();
    return (
        <Modal
            open={open}
            onClose={busy ? undefined : onClose}
            title={title}
            footer={
                <>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="px-3.5 py-2 rounded-lg text-[13px] font-semibold border border-[var(--border-default)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        {t('admin_subscriptions.ui_cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        className={`px-3.5 py-2 rounded-lg text-[13px] font-semibold border ${
                            confirmTone === 'danger'
                                ? 'bg-rose-600 hover:bg-rose-500 text-white border-transparent'
                                : 'bg-blue-600 hover:bg-blue-500 text-white border-transparent'
                        } disabled:opacity-50`}
                    >
                        {busy ? t('admin_subscriptions.ui_working', 'Working…') : (confirmLabel ?? t('admin_subscriptions.ui_confirm', 'Confirm'))}
                    </button>
                </>
            }
        >
            <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">{message}</p>
        </Modal>
    );
}
