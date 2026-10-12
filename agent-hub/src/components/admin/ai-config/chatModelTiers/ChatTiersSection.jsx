// "Chat Model Tiers" section of ChatModelTiersConfig (standard tiers + the
// custom-tier list + the save button). Subtree moved verbatim from
// ChatModelTiersConfig.jsx; all bindings are threaded in as props.
import React from 'react';
import { TIERS, TIER_DEFAULTS } from './constants';
import CustomTierCard from './CustomTierCard';
import TierCard from './TierCard';
import { useTranslation } from '../../../../hooks/useTranslation';

export default function ChatTiersSection({
    config, customTiers, saving, message, save, addCustomTier, updateTier,
    expandedTier, setExpandedTier, expandedCustomId, setExpandedCustomId,
    chatModels, byProvider, hiddenModelIds, toggleHiddenModel,
    isLocal, reasoningCapable, applyClaudeRecommendedForTier,
    updateCustomTier, renameCustomTier, removeCustomTier, toggleCustomTaskType,
}) {
    const { t } = useTranslation();
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(139, 92, 246, 0.15)' }}>💬</div>
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_chat_title', 'Chat Model Tiers')}</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
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
                <div className="mt-6 pt-6 border-t" style={{ borderColor: 'var(--border-default)' }}>
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {t('admin_ai_config.tier_custom_title', 'Custom Tiers')}
                            </h4>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {t('admin_ai_config.tier_custom_hint', 'Extra tiers beyond the standard four. Restrict each tier to specific task types and per-group access from the Organisation admin.')}
                            </p>
                        </div>
                        <button
                            onClick={addCustomTier}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white hover:opacity-90 transition-opacity"
                            style={{ background: 'var(--accent-primary)' }}
                        >
                            {t('admin_ai_config.tier_custom_add', '+ Add Custom Tier')}
                        </button>
                    </div>
                    {customTiers.length === 0 ? (
                        <div className="p-4 rounded-lg border text-center text-xs" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
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
                    className="mt-6 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {saving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.tier_save', 'Save Tier Configuration')}
                </button>
            </div>
    );
}
