/**
 * The License & Usage screen's lifecycle actions (OrgInfoPanel.jsx
 * handleCancelDowngrade, handleReactivateSubscription, doCancelSubscription and
 * the usagePooled save), each answered with the web's own sentence. Cancelling
 * asks first, in the web's in-app confirm words.
 */

import { useQueryClient } from '@tanstack/react-query';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useUpdateOrganization } from '@/features/org';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useCancelDowngrade, useCancelSubscription, useReactivateSubscription } from './mutations';
import { billingKeys } from '../api/keys';

export function useBillingActions(orgId: string | null) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const keepPlan = useCancelDowngrade(orgId);
    const keepSubscription = useReactivateSubscription(orgId);
    const cancel = useCancelSubscription(orgId);
    const updateOrg = useUpdateOrganization(orgId);

    const run = async (write: () => Promise<unknown>, done: string) => {
        try {
            await write();
            toast(done, 'success');
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    return {
        busy: keepPlan.isPending || keepSubscription.isPending || cancel.isPending,
        pooledSaving: updateOrg.isPending,
        keepPlan: () =>
            run(
                () => keepPlan.mutateAsync(),
                t('org.downgrade_cancelled_msg', 'Scheduled downgrade cancelled — you stay on your current plan.'),
            ),
        keepSubscription: () =>
            run(() => keepSubscription.mutateAsync(), t('mobile.billing.reactivated', 'Subscription will continue.')),
        cancel: async () => {
            const ok = await confirm({
                title: t('org.cancel_subscription', 'Cancel subscription'),
                message: t(
                    'org.cancel_confirm_body',
                    'Cancel your subscription at the end of the current billing period? You keep full access until then, and no further payments will be taken.',
                ),
                confirmLabel: t('org.cancel_subscription_confirm', 'Cancel subscription'),
            });
            if (ok) await run(() => cancel.mutateAsync(), t('org.cancel_scheduled_msg', 'Cancellation scheduled.'));
        },
        /** The subscription's `billing` carries the split too, so it is re-read after the save. */
        setPooled: (usagePooled: boolean) =>
            run(async () => {
                await updateOrg.mutateAsync({ usagePooled });
                await queryClient.invalidateQueries({ queryKey: billingKeys.all });
            }, t('common.saved', 'Saved')),
    };
}
