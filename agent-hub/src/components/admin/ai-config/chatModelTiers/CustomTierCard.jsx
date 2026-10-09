// One custom-tier card of the chat-model-tier admin panel. Subtree moved
// verbatim from ChatModelTiersConfig.jsx's renderCustomTierCard(); all
// bindings are threaded in as props from the panel.
import React from 'react';
import { CUSTOM_TIER_DEFAULTS, TASK_TYPES } from './constants';
import { clampToEfforts, getModelMeta, isClaudeAdaptiveOnly, isClaudeReasoning, isGpt5, isGpt5Pro, openAIEffortOptions, stampedEffortOptions } from './modelMeta';
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { useTranslation } from '../../../../hooks/useTranslation';

export default function CustomTierCard({
    tier, expandedCustomId, setExpandedCustomId, chatModels, byProvider,
    hiddenModelIds, toggleHiddenModel, reasoningCapable,
    updateCustomTier, renameCustomTier, removeCustomTier, toggleCustomTaskType,
}) {
    const { t } = useTranslation();
        const isExpanded = expandedCustomId === tier.id;
        const selectedModel = chatModels.find(m => m.id === tier.modelId);
        const displayName = selectedModel ? getModelDisplayName(selectedModel) : null;
        const selectedLabel = selectedModel
            ? (displayName !== selectedModel.id ? displayName : selectedModel.id)
            : t('admin_ai_config.tier_not_configured', 'Not configured');
        const taskTypes = new Set(tier.allowedTaskTypes || []);
        // Mistral stamps its own effort vocabulary (none/high) on the model.
        const stampedEfforts = Array.isArray(selectedModel?.efforts) && selectedModel.efforts.length > 0
            ? selectedModel.efforts
            : null;

        return (
            <div key={tier.id} className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                <div className="p-4">
                    <div className="flex items-center gap-3 mb-3">
                        <input
                            type="text"
                            value={tier.icon || ''}
                            onChange={e => updateCustomTier(tier.id, { icon: e.target.value.slice(0, 4) })}
                            maxLength={4}
                            className="w-12 text-center text-xl px-1 py-1 rounded-lg border outline-none"
                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            title={t('admin_ai_config.custom_icon_title', 'Icon or emoji')}
                        />
                        <div className="flex-1 min-w-0">
                            <input
                                type="text"
                                value={tier.label || ''}
                                onChange={e => renameCustomTier(tier.id, e.target.value)}
                                placeholder={t('admin_ai_config.custom_name_placeholder', 'Tier name')}
                                className="w-full text-sm font-semibold px-2 py-1 rounded-lg border outline-none"
                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            />
                            <p className="text-[10px] mt-0.5 font-mono" style={{ color: 'var(--text-muted)' }}>{tier.id}</p>
                        </div>
                        <button
                            onClick={() => setExpandedCustomId(isExpanded ? null : tier.id)}
                            className="text-xs px-2 py-1 rounded-lg hover:bg-white/10 transition-colors"
                            style={{ color: 'var(--text-muted)' }}
                        >
                            {isExpanded ? t('admin_ai_config.custom_settings_open', '▲ Settings') : t('admin_ai_config.custom_settings_closed', '▼ Settings')}
                        </button>
                        <button
                            onClick={() => removeCustomTier(tier.id)}
                            className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-red-500/20 transition-colors"
                            style={{ color: 'var(--text-muted)' }}
                            title={t('admin_ai_config.custom_delete_title', 'Delete tier')}
                        >✕</button>
                    </div>

                    <input
                        type="text"
                        value={tier.description || ''}
                        onChange={e => updateCustomTier(tier.id, { description: e.target.value })}
                        placeholder={t('admin_ai_config.custom_desc_placeholder', 'Short description (shown in tier picker)')}
                        className="w-full text-xs px-3 py-2 mb-3 rounded-lg border outline-none"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    />

                    <SearchableModelSelect
                        value={tier.modelId || ''}
                        label={selectedLabel}
                        groups={byProvider}
                        onChange={({ modelId }) => updateCustomTier(tier.id, { modelId })}
                        hiddenIds={hiddenModelIds}
                        onToggleHidden={toggleHiddenModel}
                    />

                    <div className="mt-3">
                        <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
                            {t('admin_ai_config.custom_available_for', 'Available for')}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {TASK_TYPES.map(tt => {
                                const active = taskTypes.has(tt.key);
                                return (
                                    <button
                                        key={tt.key}
                                        type="button"
                                        onClick={() => toggleCustomTaskType(tier.id, tt.key)}
                                        className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                                        style={{
                                            background: active ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                                            color: active ? '#fff' : 'var(--text-muted)',
                                            border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                                        }}
                                    >
                                        {active ? '✓ ' : ''}{tt.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t flex gap-4 flex-wrap" style={{ borderColor: 'var(--border-default)' }}>
                        <div className="flex-1 min-w-[180px]">
                            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_max_tokens', 'Max Tokens')}</label>
                            <input
                                type="number"
                                value={tier.maxTokens !== undefined ? tier.maxTokens : CUSTOM_TIER_DEFAULTS.maxTokens}
                                onChange={e => updateCustomTier(tier.id, { maxTokens: parseInt(e.target.value) || CUSTOM_TIER_DEFAULTS.maxTokens })}
                                min={256} max={131072} step={256}
                                className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm"
                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            />
                        </div>
                        <div className="flex-1 min-w-[180px]">
                            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_temperature', 'Temperature')}</label>
                            <input
                                type="number"
                                value={tier.temperature !== undefined ? tier.temperature : CUSTOM_TIER_DEFAULTS.temperature}
                                onChange={e => updateCustomTier(tier.id, { temperature: parseFloat(e.target.value) || CUSTOM_TIER_DEFAULTS.temperature })}
                                min={0} max={2} step={0.1}
                                className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm"
                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            />
                        </div>
                        {reasoningCapable(tier.modelId) && (
                            <div className="flex-1 min-w-[180px]">
                                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{isClaudeReasoning(tier.modelId) ? t('admin_ai_config.tier_thinking_effort', '🧠 Thinking Effort') : t('admin_ai_config.tier_reasoning_effort', '🧠 Reasoning Effort')}</label>
                                <select
                                    value={isGpt5Pro(tier.modelId)
                                        ? 'high'
                                        // Unset reaches the Mistral adapter as nothing, which it sends as 'none'.
                                        : stampedEfforts
                                            ? clampToEfforts(tier.reasoningEffort || 'none', stampedEfforts)
                                            : (tier.reasoningEffort || 'none')}
                                    // With a stamped vocabulary 'none' is stored as itself: the
                                    // resolver's getTierConfig defaults an unset effort to
                                    // 'medium', which on Mistral is 'high', the opposite of None.
                                    onChange={e => updateCustomTier(tier.id, {
                                        reasoningEffort: stampedEfforts || e.target.value !== 'none' ? e.target.value : undefined,
                                    })}
                                    disabled={isGpt5Pro(tier.modelId)}
                                    className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm disabled:opacity-60"
                                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                >
                                    {isGpt5Pro(tier.modelId) ? (
                                        <option value="high">{t('admin_ai_config.tier_eff_pro_locked', 'High (pro: locked)')}</option>
                                    ) : stampedEfforts ? (
                                        stampedEffortOptions(stampedEfforts).map(([value, label]) => (
                                            <option key={value} value={value}>{label}</option>
                                        ))
                                    ) : (
                                        isClaudeReasoning(tier.modelId) ? (
                                            <>
                                                <option value="none">{t('admin_ai_config.tier_eff_none', 'None (disabled)')}</option>
                                                <option value="low">{t('admin_ai_config.tier_eff_low', 'Low')}</option>
                                                <option value="medium">{t('admin_ai_config.tier_eff_medium', 'Medium')}</option>
                                                <option value="high">{t('admin_ai_config.tier_eff_high', 'High')}</option>
                                                {isClaudeAdaptiveOnly(tier.modelId) && <option value="xhigh">{t('admin_ai_config.tier_eff_xhigh', 'xHigh')}</option>}
                                                {isClaudeAdaptiveOnly(tier.modelId) && <option value="max">{t('admin_ai_config.tier_eff_max', 'Max')}</option>}
                                            </>
                                        ) : (
                                            /* OpenAI: the effort vocabulary differs per generation. */
                                            openAIEffortOptions(tier.modelId).map(([value]) => (
                                                <option key={value} value={value}>
                                                    {value === 'none' ? t('admin_ai_config.tier_eff_none', 'None (disabled)') : value === 'xhigh' ? t('admin_ai_config.tier_eff_xhigh', 'xHigh') : value === 'low' ? t('admin_ai_config.tier_eff_low', 'Low') : value === 'medium' ? t('admin_ai_config.tier_eff_medium', 'Medium') : value === 'high' ? t('admin_ai_config.tier_eff_high', 'High') : value === 'max' ? t('admin_ai_config.tier_eff_max', 'Max') : value.charAt(0).toUpperCase() + value.slice(1)}
                                                </option>
                                            ))
                                        )
                                    )}
                                </select>
                            </div>
                        )}
                        {isGpt5(tier.modelId) && (
                            <div className="flex-1 min-w-[180px]">
                                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_verbosity', '🗣️ Verbosity')}</label>
                                <select
                                    value={tier.verbosity || 'medium'}
                                    onChange={e => updateCustomTier(tier.id, { verbosity: e.target.value })}
                                    className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm"
                                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                >
                                    <option value="low">{t('admin_ai_config.tier_verb_low', 'Low: concise')}</option>
                                    <option value="medium">{t('admin_ai_config.tier_verb_medium_custom', 'Medium: balanced')}</option>
                                    <option value="high">{t('admin_ai_config.tier_verb_high', 'High: detailed')}</option>
                                </select>
                            </div>
                        )}
                        {/* Claude thinking mode + budget tokens (Sonnet/Opus 4.6 only —
                            the adaptive-only family Opus 4.7/4.8, Sonnet 5, Fable 5 has no manual budget). */}
                        {isClaudeReasoning(tier.modelId) && !isClaudeAdaptiveOnly(tier.modelId) && (() => {
                            const mode = (tier.budgetTokens && tier.budgetTokens > 0) ? 'extended' : 'adaptive';
                            return (
                                <div className="w-full flex gap-4 flex-wrap mt-2">
                                    <div className="flex-1 min-w-[260px]">
                                        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_thinking_mode', 'Thinking Mode')}</label>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => updateCustomTier(tier.id, { budgetTokens: undefined })}
                                                className="flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors"
                                                style={{
                                                    background: mode === 'adaptive' ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                                                    borderColor: mode === 'adaptive' ? 'var(--accent-primary)' : 'var(--border-default)',
                                                    color: mode === 'adaptive' ? '#fff' : 'var(--text-primary)',
                                                }}
                                            >
                                                {t('admin_ai_config.tier_adaptive', 'Adaptive')}
                                            </button>
                                            <button
                                                onClick={() => updateCustomTier(tier.id, { budgetTokens: tier.budgetTokens || 10000 })}
                                                className="flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors"
                                                style={{
                                                    background: mode === 'extended' ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                                                    borderColor: mode === 'extended' ? 'var(--accent-primary)' : 'var(--border-default)',
                                                    color: mode === 'extended' ? '#fff' : 'var(--text-primary)',
                                                }}
                                            >
                                                {t('admin_ai_config.tier_extended', 'Extended (fixed budget)')}
                                            </button>
                                        </div>
                                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                            {mode === 'adaptive'
                                                ? t('admin_ai_config.tier_adaptive_hint', 'Claude decides depth from Effort. Shares Max Tokens with output.')
                                                : t('admin_ai_config.tier_extended_hint', 'Fixed thinking budget. Output is guaranteed (max tokens − budget).')}
                                        </p>
                                    </div>
                                    {mode === 'extended' && (
                                        <div className="flex-1 min-w-[180px]">
                                            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('admin_ai_config.tier_thinking_budget', 'Thinking Budget')}</label>
                                            <input
                                                type="number"
                                                value={tier.budgetTokens || ''}
                                                onChange={e => {
                                                    const v = parseInt(e.target.value, 10);
                                                    updateCustomTier(tier.id, { budgetTokens: isNaN(v) || v <= 0 ? undefined : v });
                                                }}
                                                min={1024} max={64000} step={1024}
                                                placeholder="10000"
                                                className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            />
                                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                                {t('admin_ai_config.tier_budget_hint', 'Tokens reserved for thinking. Must be < Max Tokens.')}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            );
                        })()}
                        {isClaudeAdaptiveOnly(tier.modelId) && (
                            <div className="w-full mt-2">
                                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    {t('admin_ai_config.tier_adaptive_only', '{model} uses adaptive thinking only: the Effort dropdown controls how deep the model thinks. Manual thinking budgets and the temperature setting are not supported.', { model: getModelMeta(tier.modelId)?.name || t('admin_ai_config.tier_this_model', 'This model') })}
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
}
