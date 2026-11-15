// The standard tiers of the Models page as rows of a settings list. Edits go
// into the page's draft; the save bar stores them.
import type { ModelPickerSource } from './modelPicker.types';
import type { TierConfig } from './tierTypes';
import type { ClaudeSettingsState } from './useClaudeSettings';
import type { TierConfigsState } from './useTierConfigs';
import { TIERS, TIER_DEFAULTS } from './constants';
import TierCard from './TierCard';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useTranslation } from '@/hooks/useTranslation';

interface ChatTiersSectionProps extends ModelPickerSource {
    config: TierConfig;
    updateTier: TierConfigsState['updateTier'];
    expandedTier: TierConfigsState['expandedTier'];
    setExpandedTier: TierConfigsState['setExpandedTier'];
    isLocal: (id: string) => boolean;
    reasoningCapable: (id: string) => boolean;
    applyClaudeRecommendedForTier: ClaudeSettingsState['applyClaudeRecommendedForTier'];
}

export default function ChatTiersSection({
    config, updateTier, expandedTier, setExpandedTier,
    chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
    isLocal, reasoningCapable, applyClaudeRecommendedForTier,
}: ChatTiersSectionProps) {
    const { t } = useTranslation();
    return (
        <SettingsGroup title={t('admin_ai_config.tier_chat_title', 'Chat Model Tiers')} description={t('ai_model_setup.tiers_subtitle', 'The model behind each tier, used by chats and agents.')}>
            <SettingsList>
                {TIERS.map(tier => (
                    <TierCard
                        key={tier.key}
                        tier={tier}
                        tierConfig={config[tier.key] || {}}
                        updateFn={updateTier}
                        defaults={TIER_DEFAULTS[tier.key]}
                        expandedTier={expandedTier}
                        setExpandedTier={setExpandedTier}
                        chatModels={chatModels}
                        byProvider={byProvider}
                        hiddenModelIds={hiddenModelIds}
                        toggleHiddenModel={toggleHiddenModel}
                        isLocal={isLocal}
                        reasoningCapable={reasoningCapable}
                        applyClaudeRecommendedForTier={(tierKey, models) => applyClaudeRecommendedForTier(tierKey, models, 'regular')}
                    />
                ))}
            </SettingsList>
        </SettingsGroup>
    );
}
