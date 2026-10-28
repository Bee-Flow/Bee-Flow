/** A pointer to the approvals inbox — the count, not a second copy of the list. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';
import { Banner, Button } from '@/shared/ui';

export function ApprovalsWaitingBanner({ count }: { count: number }) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <Banner
            tone="warning"
            icon="Clock"
            action={<Button label={t('compliance.attention_action_navigate', 'Open')} variant="ghost" onPress={() => router.push('/approvals')} />}
        >
            {nOf(t, 'mobile.cowork_hub.decisions_waiting', count, [
                '{count} decision is waiting on you.',
                '{count} decisions are waiting on you.',
            ])}
        </Banner>
    );
}
