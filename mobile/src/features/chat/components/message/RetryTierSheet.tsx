/**
 * "Retry with model" (the web's RetryTierMenu): the question asked again on
 * another tier, this turn only. Auto always; the others when the workspace
 * has a model configured for them.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { retryTiers } from '@/features/chat/model/retry';
import { tierDescription, tierLabel, type TierMap } from '@/features/chat/model/tiers';
import { ActionMenu } from '@/shared/ui';

export function RetryTierSheet({
    visible,
    tiers,
    onClose,
    onPick,
}: {
    visible: boolean;
    tiers: TierMap;
    onClose: () => void;
    onPick: (tier: string) => void;
}) {
    const t = useTranslation();
    return (
        <ActionMenu
            visible={visible}
            onClose={onClose}
            title={t('chat.msg.retry_with_model', 'Retry with model')}
            items={retryTiers(tiers).map((key) => ({
                id: key,
                label: tierLabel(key, tiers[key]),
                accessibilityHint: tierDescription(key, tiers[key]),
                onPress: () => onPick(key),
            }))}
        />
    );
}
