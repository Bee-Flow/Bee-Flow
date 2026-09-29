import { useCallback } from 'react';
import useConfirm from '../../../../shared/useConfirm';

/**
 * App Studio runtime — the shared confirm, worded from an action step.
 *
 * useActionRunner awaits an injectable `confirm(step) → Promise<boolean>` for a
 * `confirm` step (default is window.confirm). This adapter puts the step's
 * wording on the house-style dialog: `confirm(step)` resolves true (Continue)
 * or false (Cancel — which ABORTS the remaining sequence). Mount `dialog`
 * wherever the runner runs (the editor preview canvas + the standalone run
 * page) and pass `confirm` to useActionRunner.
 */
export default function useConfirmDialog() {
    const { confirm: ask, confirmDialog } = useConfirm();

    const confirm = useCallback((step) => {
        const s = step && typeof step === 'object' ? step : {};
        return ask({
            title: s.title || s.heading || 'Please confirm',
            description: s.message || 'Are you sure you want to continue?',
            confirmLabel: s.confirmLabel || 'Continue',
            cancelLabel: s.cancelLabel || 'Cancel',
            destructive: !!s.destructive,
        });
    }, [ask]);

    return { confirm, dialog: confirmDialog };
}
