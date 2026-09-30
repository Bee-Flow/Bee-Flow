/**
 * What a Stripe hand-off has to say, inline (the web's `subMessage` and its
 * "Activating your subscription…" strip): the outcome of the last Checkout or
 * portal visit, and the wait while a paid Checkout settles.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner, Button } from '@/shared/ui';

import type { HandoffNotice } from '../hooks/useStripeHandoff';

export function HandoffBanners({
    notice,
    settling,
    onDismiss,
}: {
    notice: HandoffNotice | null;
    settling: boolean;
    onDismiss: () => void;
}) {
    const t = useTranslation();
    return (
        <>
            {notice ? (
                <Banner
                    tone={notice.tone}
                    action={<Button label={t('meetings.dismiss', 'Dismiss')} variant="ghost" size="sm" onPress={onDismiss} />}
                >
                    {notice.text}
                </Banner>
            ) : null}
            {settling ? (
                <Banner tone="info" icon="LoaderCircle">
                    {`${t('org.activating_subscription', 'Activating your subscription…')} ${t('org.activating_subscription_hint', 'Payment received — confirming with Stripe.')}`}
                </Banner>
            ) : null}
        </>
    );
}
