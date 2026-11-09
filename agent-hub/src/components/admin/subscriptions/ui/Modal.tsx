import { X } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';
import IconButton from '@/components/shared/IconButton';
import { useTranslation } from '@/hooks/useTranslation';
import SharedModal from '@/components/shared/Modal';
import { DANGER_BTN, PRIMARY_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';

/**
 * The subscriptions console's dialog skin — header, scrolling body, optional
 * footer — drawn inside the shared Modal, which owns the backdrop, Escape,
 * the focus trap and focus restore. `onClose` may be undefined (ConfirmModal
 * passes none while it is busy); then nothing closes it.
 *
 * Kept local rather than replaced by the shared ConfirmDialog: callers lean on
 * the header-with-subtitle / footer slots, and ConfirmModal's busy state must
 * lock Escape and the backdrop (admin/modalOverlays.test.tsx pins that).
 */
interface ModalProps {
    open: boolean;
    onClose?: () => void;
    title?: ReactNode;
    subtitle?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    width?: string;
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-md' }: ModalProps) {
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
            className={`${width} overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-2xl`}
        >
            <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--border-default)]">
                <div className="min-w-0">
                    {title && <h3 id={titleId} className="m-0 truncate text-[15px] font-semibold text-[var(--text-primary)]">{title}</h3>}
                    {subtitle && <p className="m-0 mt-0.5 text-xs text-[var(--text-tertiary)]">{subtitle}</p>}
                </div>
                <IconButton size="sm" onClick={onClose} ariaLabel={t('admin_subscriptions.ui_close', 'Close')}><X /></IconButton>
            </div>
            <div className="px-5 py-4 overflow-y-auto">{children}</div>
            {footer && (
                <div className="flex justify-end gap-2 border-t border-[var(--border-default)] bg-[var(--bg-secondary)] px-5 py-3">
                    {footer}
                </div>
            )}
        </SharedModal>
    );
}

interface ConfirmModalProps {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title?: ReactNode;
    message?: ReactNode;
    confirmLabel?: string;
    confirmTone?: 'danger' | 'primary';
    busy?: boolean;
}

export function ConfirmModal({ open, onClose, onConfirm, title, message, confirmLabel = undefined, confirmTone = 'danger', busy = false }: ConfirmModalProps) {
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
                        className={SECONDARY_BTN}
                    >
                        {t('admin_subscriptions.ui_cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        className={confirmTone === 'danger' ? DANGER_BTN : PRIMARY_BTN}
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
