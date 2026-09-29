// "EU Chat Model Tiers" section of ChatModelTiersConfig. Subtree moved
// verbatim from ChatModelTiersConfig.jsx; all bindings are threaded in as
// props.
import React from 'react';
import { TIERS } from './constants';
import CustomTierEuRow from './CustomTierEuRow';
import TierCard from './TierCard';

export default function EuTiersSection({
    euConfig, customTiers, euSaving, euMessage, saveEu, updateEuTier,
    expandedTier, setExpandedTier, chatModels, byProvider,
    hiddenModelIds, toggleHiddenModel, isLocal, reasoningCapable,
    applyClaudeRecommendedForTier, updateCustomTier,
}) {
    return (
            <div className="p-4 sm:p-6 rounded-xl border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: 'rgba(0, 51, 153, 0.15)' }}>🇪🇺</div>
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>EU Chat Model Tiers</h3>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            EU-hosted models used when an organization has EU mode enabled in their Privacy Shield
                        </p>
                    </div>
                </div>

                {euMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${euMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {euMessage.text}
                    </div>
                )}

                <div className="space-y-4">
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
                </div>

                {/* Custom tiers — EU model picker per tier. Only shown when any custom tier exists. */}
                {customTiers.length > 0 && (
                    <div className="mt-6 pt-6 border-t" style={{ borderColor: 'var(--border-default)' }}>
                        <h4 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                            Custom Tiers — EU override
                        </h4>
                        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                            Pick an EU-hosted model for each custom tier. Used automatically when an organization has EU mode enabled.
                        </p>
                        <div className="space-y-4">
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
                        </div>
                    </div>
                )}

                <button
                    onClick={saveEu}
                    disabled={euSaving}
                    className="mt-6 px-6 py-2.5 rounded-lg font-medium text-sm transition-all text-white hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {euSaving ? 'Saving...' : 'Save EU Tier Configuration'}
                </button>
            </div>
    );
}
