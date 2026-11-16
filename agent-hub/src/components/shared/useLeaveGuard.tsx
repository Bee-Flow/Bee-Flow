import { useEffect } from 'react';
import useConfirm from '@/components/shared/useConfirm';
import useTranslation from '@/hooks/useTranslation';

/** A host's navigation guard: it awaits the function before it leaves, and stays when it resolves false. */
export type SetLeaveGuard = (guard: (() => Promise<boolean>) | null) => void;

export interface LeaveGuardTexts {
    title?: string;
    description?: string;
    confirmLabel?: string;
}

/**
 * Unsaved edits are never lost silently (the Compliance settings page's
 * guard, generalised). While `dirty`:
 *  - the host's navigation guard (`setLeaveGuard`, e.g. the Compliance hub's
 *    rail) asks through useConfirm before it navigates away;
 *  - the browser asks before the tab closes or reloads (`beforeunload`).
 * Both go when the edit is clean again (saved or discarded) and on unmount.
 * Returns the confirm dialog to mount next to the form.
 */
export default function useLeaveGuard(dirty: boolean, setLeaveGuard?: SetLeaveGuard | null, texts: LeaveGuardTexts = {}) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { title, description, confirmLabel } = texts;
    useEffect(() => {
        if (!dirty) return undefined;
        const hub = typeof setLeaveGuard === 'function' ? setLeaveGuard : null;
        hub?.(() => confirm({
            title: title ?? t('admin_ui.leave_title', 'Discard unsaved changes?'),
            description: description ?? t('admin_ui.leave_desc', 'The changes you made here have not been saved.'),
            confirmLabel: confirmLabel ?? t('admin_ui.leave_discard', 'Discard changes'),
            cancelLabel: t('common.cancel', 'Cancel'),
            destructive: true,
        }));
        const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => {
            hub?.(null);
            window.removeEventListener('beforeunload', onBeforeUnload);
        };
    }, [dirty, setLeaveGuard, confirm, t, title, description, confirmLabel]);
    return confirmDialog;
}
