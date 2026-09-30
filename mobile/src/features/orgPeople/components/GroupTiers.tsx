/**
 * "Allowed tiers" — which model tiers a group's members may use: the four
 * standard ones and every custom tier. None switched on means no restriction
 * (every tier), exactly as the server reads an empty `allowedTiers`; the
 * first switch restricts the group to that tier.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Group, SettingRow, ToggleRow, useToast } from '@/shared/ui';

import { useUpdateGroup } from '../hooks/groupMutations';
import { tierPills, toggleTier } from '../model/tiers';
import type { CustomTierMeta, OrgGroup } from '../model/types';

export function GroupTiers({ group, custom }: { group: OrgGroup; custom: readonly CustomTierMeta[] }) {
    const t = useTranslation();
    const { toast } = useToast();
    const update = useUpdateGroup();
    // While a save is in flight, show the list it is saving.
    const pending = update.isPending ? update.variables?.patch : undefined;
    const allowed = pending && 'allowedTiers' in pending ? pending.allowedTiers : group.allowedTiers;
    const unrestricted = allowed.length === 0;
    const save = (allowedTiers: string[]) =>
        update.mutate(
            { id: group.id, patch: { allowedTiers } },
            { onError: (e) => toast(describeError(e).message, 'error') },
        );

    return (
        <Group
            title={t('mobile.orgPeople.allowed_tiers', 'Allowed tiers')}
            footer={
                unrestricted
                    ? t('mobile.orgPeople.tiers_unrestricted', 'No restriction: members may use every tier. Switch one on to limit the group to the tiers you pick.')
                    : t('mobile.orgPeople.tiers_restricted', 'Members of this group may only use the tiers switched on.')
            }
        >
            {tierPills(t, custom).map((tier) => (
                <ToggleRow
                    key={tier.id}
                    testID={`tier-${tier.id}`}
                    label={`${tier.icon} ${tier.label}`}
                    description={tier.custom ? t('mobile.orgPeople.custom_tier', 'Custom tier') : undefined}
                    value={allowed.includes(tier.id)}
                    disabled={update.isPending}
                    onValueChange={() => save(toggleTier(allowed, tier.id))}
                />
            ))}
            {!unrestricted ? (
                <SettingRow
                    testID="tiers-clear"
                    label={t('mobile.orgPeople.tiers_allow_all', 'Allow every tier')}
                    disabled={update.isPending}
                    onPress={() => save([])}
                />
            ) : null}
        </Group>
    );
}
