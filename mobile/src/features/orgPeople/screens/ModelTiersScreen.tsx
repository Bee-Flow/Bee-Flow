/**
 * Model tiers — the web's OrgCustomTiersPanel: the organisation's own custom
 * tiers (add, edit, delete; each maps to a model, an optional EU override and
 * the chats it serves) and, read-only, the global tiers the platform already
 * provides. Which tiers a GROUP may use is set on the group.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { QueryScreen } from '@/shared/patterns';
import { Button, Group, GroupedScroll, ListRow, NoteRow, ScreenHeader, Text } from '@/shared/ui';

import { LockedScreen } from '../components/LockedScreen';
import { TierSheet } from '../components/TierSheet';
import { useModelOptions, useOrgTiers } from '../hooks/queries';
import { usePeopleAccess } from '../hooks/usePeopleAccess';
import { newTier } from '../model/tiers';
import type { CustomTier, OrgCustomTiers } from '../model/types';

interface Editing {
    tier: CustomTier;
    isNew: boolean;
}

function TierList({ data, onEdit }: { data: OrgCustomTiers; onEdit: (tier: CustomTier) => void }) {
    const t = useTranslation();
    return (
        <GroupedScroll>
            <Group
                title={t('mobile.orgPeople.org_tiers', 'Organisation custom tiers')}
                footer={t(
                    'mobile.orgPeople.org_tiers_footer',
                    'Tiers scoped to this organisation. They appear alongside global tiers for your members.',
                )}
            >
                {data.orgTiers.length === 0 ? (
                    <NoteRow>
                        {t('mobile.orgPeople.no_org_tiers', 'No organisation-scoped tiers yet. Add one to create it.')}
                    </NoteRow>
                ) : (
                    data.orgTiers.map((tier) => (
                        <ListRow
                            key={tier.id}
                            testID={`org-tier-${tier.id}`}
                            title={`${tier.icon} ${tier.label}`}
                            subtitle={tier.modelId || t('mobile.orgPeople.not_configured', 'Not configured')}
                            meta={tier.id}
                            chevron
                            onPress={() => onEdit(tier)}
                        />
                    ))
                )}
            </Group>
            {data.globalTiers.length > 0 ? (
                <Group
                    title={t('mobile.orgPeople.global_tiers', 'Global tiers (read-only)')}
                    footer={t(
                        'mobile.orgPeople.global_tiers_footer',
                        'These tiers are provided by the system administrator. Your members can see them subject to the group permissions you’ve set.',
                    )}
                >
                    {data.globalTiers.map((tier) => (
                        <ListRow
                            key={tier.id}
                            title={`${tier.icon || '✨'} ${tier.label || tier.id}`}
                            subtitle={tier.description || undefined}
                            trailing={<Text variant="caption" tone="tertiary">{tier.id}</Text>}
                            chevron={false}
                        />
                    ))}
                </Group>
            ) : null}
        </GroupedScroll>
    );
}

export function ModelTiersScreen() {
    const t = useTranslation();
    const { isOrgAdmin } = usePeopleAccess();
    const tiers = useOrgTiers(isOrgAdmin);
    const models = useModelOptions(isOrgAdmin);
    const [editing, setEditing] = useState<Editing | null>(null);

    const title = t('mobile.orgPeople.model_tiers', 'Model tiers');
    if (!isOrgAdmin) return <LockedScreen title={title} />;

    const orgTiers = tiers.data?.orgTiers ?? [];
    const open = (tier: CustomTier, isNew: boolean) => setEditing({ tier, isNew });

    return (
        <QueryScreen
            query={tiers}
            scroll={false}
            header={(data) => (
                <ScreenHeader
                    title={title}
                    actions={
                        data ? (
                            <Button
                                testID="add-tier"
                                size="sm"
                                iconName="Plus"
                                label={t('mobile.orgPeople.add_tier', 'Add tier')}
                                onPress={() => open(newTier(orgTiers), true)}
                            />
                        ) : undefined
                    }
                />
            )}
        >
            {(data) => (
                <>
                    <TierList data={data} onEdit={(tier) => open(tier, false)} />
                    {editing ? (
                        <TierSheet
                            tier={editing.tier}
                            isNew={editing.isNew}
                            tiers={data.orgTiers}
                            models={models.data ?? []}
                            onClose={() => setEditing(null)}
                        />
                    ) : null}
                </>
            )}
        </QueryScreen>
    );
}
