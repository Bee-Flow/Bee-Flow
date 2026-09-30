/**
 * The in-app plan change (OrgInfoPanel.jsx handleSelectChange and
 * handleConfirmChange): pick a plan, read what it costs from the server's
 * preview, confirm. Upgrades apply now and are invoiced prorated; downgrades
 * wait for the period end. A declined card is the one refusal re-worded,
 * because the server only names it (`payment_required`).
 */

import { useState } from 'react';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { useChangePlan, usePreviewPlanChange } from './mutations';
import type { Plan, PlanChangePreview } from '../model/types';

function changeError(err: unknown, t: TranslateFn): string {
    if (err instanceof ApiError && err.code === 'payment_required') {
        return t(
            'mobile.billing.card_declined',
            'Your card was declined. Update your payment method via "Manage Billing".',
        );
    }
    return describeError(err).message;
}

export function usePlanChange(orgId: string | null, onDone: () => void) {
    const t = useTranslation();
    const { toast } = useToast();
    const preview = usePreviewPlanChange(orgId);
    const change = useChangePlan(orgId);
    const [target, setTarget] = useState<Plan | null>(null);
    const [quote, setQuote] = useState<PlanChangePreview | null>(null);

    const close = () => {
        setTarget(null);
        setQuote(null);
    };

    return {
        target,
        quote,
        previewing: preview.isPending ? target?.id ?? null : null,
        confirming: change.isPending,
        pick: async (plan: Plan) => {
            setTarget(plan);
            setQuote(null);
            try {
                setQuote(await preview.mutateAsync(plan.id));
            } catch (err) {
                setTarget(null);
                toast(changeError(err, t), 'error');
            }
        },
        confirm: async () => {
            if (!target) return;
            try {
                await change.mutateAsync(target.id);
                toast(
                    target.direction === 'downgrade'
                        ? t('org.downgrade_scheduled_msg', 'Downgrade scheduled for the end of this period.')
                        : t('org.upgrade_done_msg', 'Plan upgraded. Stripe invoiced the prorated difference.'),
                    'success',
                );
                close();
                onDone();
            } catch (err) {
                toast(changeError(err, t), 'error');
            }
        },
        close,
    };
}
