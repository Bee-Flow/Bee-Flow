import type { ReactNode } from 'react';
import { Button } from '@/components/shared/Button';
import SaveStatus from '@/components/shared/SaveStatus';
import useTranslation from '@/hooks/useTranslation';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface SaveFooterProps {
    onSave: () => void;
    /** Shows a Cancel button (put the form back) when given. */
    onCancel?: () => void;
    /** A save is in flight: Save is disabled and says "Saving…". */
    saving?: boolean;
    /** The form differs from what is stored; Save is disabled while it does not. Default true. */
    dirty?: boolean;
    /** Save cannot run (invalid form, config that did not load). */
    disabled?: boolean;
    /** The SaveStatus chip on the left; derived from `saving` when left out. */
    saveState?: SaveState;
    lastSavedAt?: Date | null;
    /** On a failed save the status chip becomes a retry button. */
    onRetry?: (() => void) | null;
    saveLabel?: ReactNode;
    cancelLabel?: ReactNode;
    /** Draw the divider above the footer. Default true. */
    divider?: boolean;
    className?: string;
}

function SaveButton({ onSave, saving, blocked, label }: { onSave: () => void; saving: boolean; blocked: boolean; label?: ReactNode }) {
    const { t } = useTranslation();
    return (
        <Button variant="primary" onClick={onSave} busy={saving} disabled={blocked}>
            {saving ? t('common.saving', 'Saving…') : (label ?? t('common.save', 'Save'))}
        </Button>
    );
}

/**
 * The footer of a text form: the save status on the left, Cancel and Save on
 * the right. The one shape for "type, then save" (toggles and list edits
 * autosave instead and show only a SaveStatus). Save is the shared Button's
 * primary, so it follows the theme accent.
 */
export default function SaveFooter({
    onSave,
    onCancel,
    saving = false,
    dirty = true,
    disabled = false,
    saveState,
    lastSavedAt = null,
    onRetry = null,
    saveLabel,
    cancelLabel,
    divider = true,
    className = '',
}: SaveFooterProps) {
    const { t } = useTranslation();
    const state: SaveState = saveState ?? (saving ? 'saving' : 'idle');
    const frame = divider ? 'border-t border-[var(--border-subtle)] pt-4' : '';
    return (
        <div className={`flex flex-wrap items-center justify-end gap-2 ${frame} ${className}`}>
            <SaveStatus saveState={state} lastSavedAt={lastSavedAt} onRetry={onRetry} showWhenIdle className="mr-auto" size={12} />
            {onCancel && (
                <Button variant="secondary" onClick={onCancel} disabled={saving}>
                    {cancelLabel ?? t('common.cancel', 'Cancel')}
                </Button>
            )}
            <SaveButton onSave={onSave} saving={saving} blocked={disabled || !dirty} label={saveLabel} />
        </div>
    );
}
