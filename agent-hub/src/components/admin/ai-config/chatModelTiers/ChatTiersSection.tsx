// "Chat Model Tiers" section of ChatModelTiersConfig (standard tiers + the
// custom-tier list + the save button). Subtree moved verbatim from
// ChatModelTiersConfig.jsx; all bindings are threaded in as props.
import React from 'react';
import type { ModelPickerSource } from './modelPicker.types';
import type { TierConfig, CustomTier, StatusMessage } from './tierTypes';
import type { ClaudeSettingsState } from './useClaudeSettings';
import type { CustomTiersState } from './useCustomTiers';
import type { TierConfigsState } from './useTierConfigs';
import { TIERS, TIER_DEFAULTS } from './constants';
import CustomTierCard from './CustomTierCard';
import TierCard from './TierCard';
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
    return (
            <div className="p-4 sm:p-6 rounded-xl border [background:var(--bg-secondary)] [border-color:var(--border-default)]">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl [background:rgba(139,92,246,0.15)]">💬</div>
                    <div>
                        <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin_ai_config.tier_chat_title', 'Chat Model Tiers')}</h3>
                        <p className="text-xs text-[var(--text-muted)]">
                            {t('admin_ai_config.tier_chat_subtitle', 'Assign a model to each tier for Direct Chat mode')}
                        </p>
                    </div>
                </div>

                {message && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${message.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {message.text}
                    </div>
                )}

                <div className="space-y-4">
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
                </div>

                {/* Custom tiers — live inside the same section as the standard four */}
                <div className="mt-6 pt-6 border-t border-[var(--border-default)]">
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                                {t('admin_ai_config.tier_custom_title', 'Custom Tiers')}
                            </h4>
                            <p className="text-xs text-[var(--text-muted)]">
                                {t('admin_ai_config.tier_custom_hint', 'Extra tiers beyond the standard four. Restrict each tier to specific task types and per-group access from the Organisation admin.')}
                            </p>
                        </div>
                        <button
                            onClick={addCustomTier}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white hover:opacity-90 transition-opacity bg-[var(--accent-primary)]"
                        >
                            {t('admin_ai_config.tier_custom_add', '+ Add Custom Tier')}
                        </button>
                    </div>
                    {customTiers.length === 0 ? (
                        <div className="p-4 rounded-lg border text-center text-xs [background:var(--bg-tertiary)] [border-color:var(--border-default)] [color:var(--text-muted)]!">
                            {t('admin_ai_config.tier_custom_none', 'No custom tiers yet.')}
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {customTiers.map(tier => (
                                <CustomTierCard
                                    key={tier.id}
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
                        </div>
                    )}
                </div>

                <button
                    onClick={save}
                    disabled={saving}
                    className="mt-6 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50 bg-[var(--accent-primary)]"
                >
                    {saving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_save', 'Save Tier Configuration')}
                </button>
            </div>
    );
}
