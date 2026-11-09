// "Chat Model Tiers" section of ChatModelTiersConfig: the standard tiers and
// the custom tiers as rows of a settings list, plus the save button. All
// bindings are threaded in as props.
import React from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { TierConfig, CustomTier, StatusMessage } from './tierTypes';
import type { ClaudeSettingsState } from './useClaudeSettings';
import type { CustomTiersState } from './useCustomTiers';
import type { TierConfigsState } from './useTierConfigs';
import { TIERS, TIER_DEFAULTS } from './constants';
import CustomTierCard from './CustomTierCard';
import TierCard from './TierCard';
import { QUIET_BUTTON, SAVE_BUTTON, SettingsGroup, SettingsList } from '../ui/SettingsList';
import { useToastOnMessage } from '../ui/useToastOnMessage';
import { useTranslation } from '@/hooks/useTranslation';

interface ChatTiersSectionProps extends ModelPickerSource {
    config: TierConfig;
    customTiers: CustomTier[];
    saving: boolean;
    message: StatusMessage | null;
    save: TierConfigsState['save'];
    addCustomTier: CustomTiersState['addCustomTier'];
    updateTier: TierConfigsState['updateTier'];
    expandedTier: TierConfigsState['expandedTier'];
    setExpandedTier: TierConfigsState['setExpandedTier'];
    expandedCustomId: CustomTiersState['expandedCustomId'];
    setExpandedCustomId: CustomTiersState['setExpandedCustomId'];
    isLocal: (id: string) => boolean;
    reasoningCapable: (id: string) => boolean;
    applyClaudeRecommendedForTier: ClaudeSettingsState['applyClaudeRecommendedForTier'];
    updateCustomTier: CustomTiersState['updateCustomTier'];
    renameCustomTier: CustomTiersState['renameCustomTier'];
    removeCustomTier: CustomTiersState['removeCustomTier'];
    toggleCustomTaskType: CustomTiersState['toggleCustomTaskType'];
}

export default function ChatTiersSection({
    config, customTiers, saving, message, save, addCustomTier, updateTier,
    expandedTier, setExpandedTier, expandedCustomId, setExpandedCustomId,
    chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
    isLocal, reasoningCapable, applyClaudeRecommendedForTier,
    updateCustomTier, renameCustomTier, removeCustomTier, toggleCustomTaskType,
}: ChatTiersSectionProps) {
    const { t } = useTranslation();
    useToastOnMessage(message);
    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SettingsGroup title={t('admin_ai_config.tier_chat_title', 'Chat Model Tiers')} description={t('admin_ai_config.tier_chat_subtitle', 'Assign a model to each tier for Direct Chat mode')}>
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
                            applyClaudeRecommendedForTier={applyClaudeRecommendedForTier}
                        />
                    ))}
                </SettingsList>
            </SettingsGroup>

            {/* Custom tiers live in the same section as the standard four */}
            <SettingsGroup
                title={t('admin_ai_config.tier_custom_title', 'Custom Tiers')}
                description={t('admin_ai_config.tier_custom_hint', 'Extra tiers beyond the standard four. Restrict each tier to specific task types and per-group access from the Organisation admin.')}
                actions={<button type="button" onClick={addCustomTier} className={QUIET_BUTTON}>{t('admin_ai_config.tier_custom_add', '+ Add Custom Tier')}</button>}
            >
                {customTiers.length === 0 ? (
                    <p className="m-0 rounded-lg border border-dashed border-[var(--border-default)] px-4 py-3 text-center text-xs text-[var(--text-tertiary)]">
                        {t('admin_ai_config.tier_custom_none', 'No custom tiers yet.')}
                    </p>
                ) : (
                    <SettingsList>
                        {customTiers.map((tier, position) => (
                            <CustomTierCard
                                // Keyed by position: the id follows the name, and a key that changed on
                                // every keystroke remounted the card and took the focus out of the name field.
                                key={position}
                                tier={tier}
                                expandedCustomId={expandedCustomId}
                                setExpandedCustomId={setExpandedCustomId}
                                chatModels={chatModels}
                                byProvider={byProvider}
                                hiddenModelIds={hiddenModelIds}
                                toggleHiddenModel={toggleHiddenModel}
                                reasoningCapable={reasoningCapable}
                                updateCustomTier={updateCustomTier}
                                renameCustomTier={renameCustomTier}
                                removeCustomTier={removeCustomTier}
                                toggleCustomTaskType={toggleCustomTaskType}
                            />
                        ))}
                    </SettingsList>
                )}
            </SettingsGroup>

            <div>
                <button type="button" onClick={save} disabled={saving} className={SAVE_BUTTON}>
                    {saving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_save', 'Save Tier Configuration')}
                </button>
            </div>
        </div>
    );
}
