import type { ReactNode } from 'react';
import { Button } from '@/components/shared/Button';
import useLeaveGuard from '@/components/shared/useLeaveGuard';
import type { LeaveGuardTexts, SetLeaveGuard } from '@/components/shared/useLeaveGuard';
import useTranslation from '@/hooks/useTranslation';

interface SaveBarMessage {
    type: 'success' | 'error';
    text: ReactNode;
}

export interface SaveBarProps {
    /** The form differs from what is stored. */
    dirty: boolean;
    saving?: boolean;
    onSave: () => void;
    /** Shows a Discard button that puts the form back. */
    onDiscard?: () => void;
    /** The outcome of the last save; shown instead of "unsaved changes". */
    message?: SaveBarMessage | null;
    /** Save cannot run (invalid form). */
    disabled?: boolean;
    saveLabel?: ReactNode;
    /** Stick to the top of the scroller (long pages) or to the bottom (a form's footer). Default top. */
    position?: 'top' | 'bottom';
    /** Show the bar while clean too (a page whose only Save is this bar). Default false: it appears with the first edit. */
    alwaysVisible?: boolean;
    /** Ask before the tab closes, and before the host navigates when it passes `setLeaveGuard`. Default true. */
    guardLeave?: boolean;
    setLeaveGuard?: SetLeaveGuard | null;
    leaveTexts?: LeaveGuardTexts;
    className?: string;
}

const POSITION = {
    top: 'sticky top-0 mb-4',
    bottom: 'sticky bottom-0 mt-4',
} as const;

function BarStatus({ message, dirty }: { message?: SaveBarMessage | null; dirty: boolean }) {
    const { t } = useTranslation();
    if (message) {
        const ink = message.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]';
        return (
            <span role="status" aria-live="polite" className={`flex items-center gap-1.5 text-[12px] font-medium ${ink}`}>
                {message.text}
            </span>
        );
    }
    if (!dirty) return null;
    return (
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--warning-ink)]">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]" />
            {t('admin_ui.unsaved', 'Unsaved changes')}
        </span>
    );
}

function BarActions({ dirty, saving, onSave, onDiscard, disabled, saveLabel }: Pick<SaveBarProps, 'dirty' | 'saving' | 'onSave' | 'onDiscard' | 'disabled' | 'saveLabel'>) {
    const { t } = useTranslation();
    return (
        <>
            {onDiscard && dirty && (
                <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
                    {t('admin_ui.discard', 'Discard')}
                </Button>
            )}
            <Button variant="primary" size="sm" onClick={onSave} busy={!!saving} disabled={!!disabled || !dirty}>
                {saving ? t('common.saving', 'Saving…') : (saveLabel ?? t('admin_ui.save_changes', 'Save changes'))}
            </Button>
        </>
    );
}

/**
 * The sticky save bar of a long form (Organisation's bar, generalised): the
 * state of the edit on the left, Discard and Save on the right, and the
 * Compliance leave guard while there is something to lose. It appears with
 * the first edit (or a save's outcome) unless `alwaysVisible`.
 */
export default function SaveBar(props: SaveBarProps) {
    const { dirty, saving = false, message = null, position = 'top', guardLeave = true, className = '' } = props;
    const confirmDialog = useLeaveGuard(guardLeave && dirty && !saving, props.setLeaveGuard, props.leaveTexts);
    const visible = props.alwaysVisible || dirty || saving || !!message;
    return (
        <>
            {visible && (
                <div className={`${POSITION[position]} z-10 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 py-2.5 shadow-sm ${className}`}>
                    <BarStatus message={message} dirty={dirty} />
                    <div className="flex-1" />
                    <BarActions {...props} saving={saving} />
                </div>
            )}
            {confirmDialog}
        </>
    );
}
