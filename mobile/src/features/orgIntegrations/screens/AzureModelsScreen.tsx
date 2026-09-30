/**
 * Chat model tiers (web: integrations/azure/ChatModelsSection.jsx): which
 * Azure deployment each Direct Chat tier uses, with its budget, temperature
 * and reasoning. Saved together; the server merges the four over what it
 * stores, so the tiers this screen does not show are kept.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Banner, Group, ListRow, SaveBar } from '@/shared/ui';

import { AzureTierSheet } from '../components/AzureTierSheet';
import { useAzureScreen } from '../hooks/useAzureScreen';
import { useAzureSectionForm } from '../hooks/useAzureSectionForm';
import { AZURE_TIERS, blankTier, deployedModels, tiersBody, type TierKey } from '../model/azure';
import type { AzureTier } from '../model/azureTypes';

type Tiers = Record<string, AzureTier>;

export function AzureModelsScreen() {
    const t = useTranslation();
    const azure = useAzureScreen();
    const config = azure.query.data;
    const [open, setOpen] = useState<TierKey | null>(null);
    const { form, saving, save } = useAzureSectionForm<{ tiers: Tiers }>(
        azure.orgId,
        config ? { tiers: config.chatModelTiers } : null,
        (d) => ({ section: 'chatModels', chatModelTiers: tiersBody(d.tiers) }),
    );
    const tiers = form.draft?.tiers ?? {};
    useConfirmLeave(form.dirty);
    const tierOf = (key: TierKey) => tiers[key] ?? blankTier(key);
    const models = deployedModels(config?.azureModels ?? '');
    const openTier = AZURE_TIERS.find((tier) => tier.key === open);

    return (
        <OrgSettingsFrame
            title={t('azure.chat_tiers_title', 'Chat Model Tiers')}
            subtitle={azure.subtitle}
            allowed={azure.allowed}
            denied={azure.denied}
            query={azure.query}
            footer={<SaveBar dirty={form.dirty} saving={saving} onSave={() => void save()} onDiscard={form.reset} />}
        >
            {() => (
                <>
                    {models.length === 0 ? (
                        <Banner tone="warning">
                            {t('azure.no_models_warning', 'No models available. Configure deployed model names in the Azure OpenAI section first, or ensure models are loaded from the admin dashboard.')}
                        </Banner>
                    ) : null}
                    <Group footer={t('azure.chat_tiers_section_desc', 'Assign a model to each tier for Direct Chat mode. These are the same tier settings used in the admin dashboard.')}>
                        {AZURE_TIERS.map((tier) => (
                            <ListRow
                                key={tier.key}
                                testID={`azure-tier-${tier.key}`}
                                title={`${tier.icon} ${t(tier.labelKey, tier.english[0])}`}
                                subtitle={tierOf(tier.key).modelId || t('azure.not_configured_option', '— Not configured —')}
                                meta={t(tier.descKey, tier.english[1])}
                                chevron
                                disabled={models.length === 0}
                                onPress={() => setOpen(tier.key)}
                            />
                        ))}
                    </Group>
                    <AzureTierSheet
                        tierKey={open}
                        title={openTier ? t(openTier.labelKey, openTier.english[0]) : ''}
                        tier={open ? tierOf(open) : null}
                        models={models}
                        onChange={(patch) => open && form.set('tiers', { ...tiers, [open]: { ...tierOf(open), ...patch } })}
                        onClose={() => setOpen(null)}
                    />
                </>
            )}
        </OrgSettingsFrame>
    );
}
