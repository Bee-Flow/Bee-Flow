// The EU tiers of the Models page: the standard tiers' EU-hosted models, used
// when an organisation runs in EU mode. Edits go into the page's draft, and a
// recommendation applied here lands in the EU table, never in the regular one.
import type { ModelPickerSource } from './modelPicker.types';
import type { TierConfig } from './tierTypes';
import type { ClaudeSettingsState } from './useClaudeSettings';
import type { TierConfigsState } from './useTierConfigs';
import { TIERS } from './constants';
import TierCard from './TierCard';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface EuTiersSectionProps extends ModelPickerSource {
    euConfig: TierConfig;
    updateEuTier: TierConfigsState['updateEuTier'];
    expandedTier: TierConfigsState['expandedEuTier'];
    setExpandedTier: TierConfigsState['setExpandedEuTier'];
    isLocal: (id: string) => boolean;
    reasoningCapable: (id: string) => boolean;
    applyClaudeRecommendedForTier: ClaudeSettingsState['applyClaudeRecommendedForTier'];
}

export default function EuTiersSection({
    euConfig, updateEuTier, expandedTier, setExpandedTier, chatModels, byProvider,
    hiddenModelIds, toggleHiddenModel, isLocal, reasoningCapable, applyClaudeRecommendedForTier,
}: EuTiersSectionProps) {
    const { t } = useTranslation();
    return (
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
                        applyClaudeRecommendedForTier={(tierKey, models) => applyClaudeRecommendedForTier(tierKey, models, 'eu')}
                    />
                ))}
            </SettingsList>
        </SettingsGroup>
    );
}
