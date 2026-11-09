// "EU Chat Model Tiers" section of ChatModelTiersConfig: the standard tiers and
// the EU override of each custom tier as settings lists. All bindings are
// threaded in as props.
import React from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { TierConfig, CustomTier, StatusMessage } from './tierTypes';
import type { ClaudeSettingsState } from './useClaudeSettings';
import type { CustomTiersState } from './useCustomTiers';
import type { TierConfigsState } from './useTierConfigs';
import { TIERS } from './constants';
import CustomTierEuRow from './CustomTierEuRow';
import TierCard from './TierCard';
import { SAVE_BUTTON, SettingsGroup, SettingsList } from '../ui/SettingsList';
import { useToastOnMessage } from '../ui/useToastOnMessage';
import { useTranslation } from '@/hooks/useTranslation';

interface EuTiersSectionProps extends ModelPickerSource {
    euConfig: TierConfig;
    customTiers: CustomTier[];
    euSaving: boolean;
    euMessage: StatusMessage | null;
    saveEu: TierConfigsState['saveEu'];
    updateEuTier: TierConfigsState['updateEuTier'];
    expandedTier: TierConfigsState['expandedTier'];
    setExpandedTier: TierConfigsState['setExpandedTier'];
    isLocal: (id: string) => boolean;
    reasoningCapable: (id: string) => boolean;
    applyClaudeRecommendedForTier: ClaudeSettingsState['applyClaudeRecommendedForTier'];
    updateCustomTier: CustomTiersState['updateCustomTier'];
}

export default function EuTiersSection({
    euConfig, customTiers, euSaving, euMessage, saveEu, updateEuTier,
    expandedTier, setExpandedTier, chatModels, byProvider,
    hiddenModelIds, toggleHiddenModel, isLocal, reasoningCapable,
    applyClaudeRecommendedForTier, updateCustomTier,
}: EuTiersSectionProps) {
    const { t } = useTranslation();
    useToastOnMessage(euMessage);
    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SettingsGroup title={t('admin_ai_config.tier_eu_title', 'EU Chat Model Tiers')} description={t('admin_ai_config.tier_eu_subtitle', 'EU-hosted models used when an organization has EU mode enabled in their Privacy Shield')}>
                <SettingsList>
                    {TIERS.map(tier => (
                        <TierCard
                            key={tier.key}
                            tier={tier}
                            tierConfig={euConfig[tier.key] || {}}
                            updateFn={updateEuTier}
                            defaults={null}
                            expandedTier={expandedTier}
                            setExpandedTier={setExpandedTier}
                            chatModels={chatModels}
                            byProvider={byProvider}
                            hiddenModelIds={hiddenModelIds}
                            toggleHiddenModel={toggleHiddenModel}
                            isLocal={isLocal}
                            reasoningCapable={reasoningCapable}
                            applyClaudeRecommendedForTier={applyClaudeRecommendedForTier}
                        />
                    ))}
                </SettingsList>
            </SettingsGroup>

            {/* Custom tiers: EU model picker per tier. Only shown when any custom tier exists. */}
            {customTiers.length > 0 && (
                <SettingsGroup
                    title={t('admin_ai_config.tier_eu_custom_title', 'Custom Tiers: EU override')}
                    description={t('admin_ai_config.tier_eu_custom_hint', 'Pick an EU-hosted model for each custom tier. Used automatically when an organization has EU mode enabled.')}
                >
                    <SettingsList>
                        {customTiers.map(tier => (
                            <CustomTierEuRow
                                key={tier.id}
                                tier={tier}
                                chatModels={chatModels}
                                byProvider={byProvider}
                                hiddenModelIds={hiddenModelIds}
                                toggleHiddenModel={toggleHiddenModel}
                                updateCustomTier={updateCustomTier}
                            />
                        ))}
                    </SettingsList>
                </SettingsGroup>
            )}

            <div>
                <button type="button" onClick={saveEu} disabled={euSaving} className={SAVE_BUTTON}>
                    {euSaving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_eu_save', 'Save EU Tier Configuration')}
                </button>
            </div>
        </div>
    );
}
