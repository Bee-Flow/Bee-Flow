import { useCallback } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
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
    const { t } = useTranslation();
    const { confirm: ask, confirmDialog } = useConfirm();

    const confirm = useCallback((step) => {
        const s = step && typeof step === 'object' ? step : {};
        return ask({
            title: s.title || s.heading || t('studio_apps_runtime.confirm.title', 'Please confirm'),
            description: s.message || t('studio_apps_runtime.confirm.description', 'Are you sure you want to continue?'),
            confirmLabel: s.confirmLabel || t('studio_apps_runtime.confirm.continue', 'Continue'),
            cancelLabel: s.cancelLabel || t('studio_apps_runtime.confirm.cancel', 'Cancel'),
            destructive: !!s.destructive,
        });
    }, [ask, t]);

    return { confirm, dialog: confirmDialog };
}
