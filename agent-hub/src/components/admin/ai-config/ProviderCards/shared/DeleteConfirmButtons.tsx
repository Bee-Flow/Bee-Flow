// Two-step confirm-delete control — replaces the
//
//   const [confirmDelete, setConfirmDelete] = useState(false);
//   {hasKey && !confirmDelete && <button onClick={() => setConfirmDelete(true)}>🗑️</button>}
//   {confirmDelete && <><button onClick={handleDelete}>Confirm</button><button>✕</button></>}
//
// pattern that was copy-pasted across the provider API-key cards,
// AzureCard, GoogleVertexCard and RerankerConfig. Render it conditionally
// ({hasKey && <DeleteConfirmButtons ... />}) — unmounting after a successful
// delete resets the confirm state; on a failed delete it stays in the
// confirm state so the user can retry, matching the old behavior.
//
// `size` picks the button scale: 'sm' (the standalone 🗑️ icon button in the
// single-key cards) or 'xs' (the labelled "🗑️ Key" / "🗑️ Endpoint" buttons
// in the multi-field cards).

import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

interface DeleteConfirmButtonsProps {
    onConfirm: () => void;
    label?: React.ReactNode;
    title?: string;
    size?: 'sm' | 'xs';
}

// Danger from the theme tokens (--error / --error-ink), readable on every theme.
const DANGER_HOVER = 'hover:bg-[color-mix(in_srgb,var(--error)_12%,transparent)] hover:text-[var(--error-ink)]';
const DANGER_CONFIRM = 'font-medium border border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error-ink)] hover:bg-[color-mix(in_srgb,var(--error)_18%,transparent)]';
const CANCEL_HOVER = 'hover:bg-[var(--item-hover-bg)]';

const SIZE_CLASSES = {
    sm: {
        trigger: `px-3 py-1.5 rounded-md text-sm transition-colors ${DANGER_HOVER}`,
        confirm: `px-3 py-1.5 rounded-md text-sm transition-colors ${DANGER_CONFIRM}`,
        cancel: `px-3 py-1.5 rounded-md text-sm transition-colors ${CANCEL_HOVER}`
    },
    xs: {
        trigger: `px-2.5 py-1 rounded-md text-xs transition-colors ${DANGER_HOVER}`,
        confirm: `px-2.5 py-1 rounded-md text-xs transition-colors ${DANGER_CONFIRM}`,
        cancel: `px-2 py-1 rounded-md text-xs transition-colors ${CANCEL_HOVER}`
    }
};

const DeleteConfirmButtons = ({ onConfirm, label = '🗑️', title, size = 'sm' }: DeleteConfirmButtonsProps) => {
    const { t } = useTranslation();
    const [confirming, setConfirming] = useState(false);
    const classes = SIZE_CLASSES[size] || SIZE_CLASSES.sm;

    if (!confirming) {
        return (
            <button
                type="button"
                onClick={() => setConfirming(true)}
                className={`${classes.trigger} text-[var(--text-tertiary)]`}
                title={title}
            >
                {label}
            </button>
        );
    }

    return (
        <>
            <button type="button" onClick={onConfirm} className={classes.confirm}>
                {t('admin_ai_config.confirm', 'Confirm')}
            </button>
            <button
                type="button"
                onClick={() => setConfirming(false)}
                aria-label={t('admin_ai_config.cancel', 'Cancel')}
                className={`${classes.cancel} text-[var(--text-tertiary)]`}
            >
                ✕
            </button>
        </>
    );
};

export default DeleteConfirmButtons;
