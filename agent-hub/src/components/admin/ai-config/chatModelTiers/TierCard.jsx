// One standard-tier card of the chat-model-tier admin panel. Subtree moved
// verbatim from ChatModelTiersConfig.jsx's renderTierCard(); all bindings are
// threaded in as props from the panel.
import React from 'react';
import { CLAUDE_RECOMMENDED } from './constants';
import { clampToEfforts, defaultTierEffort, getModelMeta, isClaudeAdaptiveOnly, isClaudeModel, isClaudeReasoning, isGpt5, isGpt5Pro, isGpt56Plus, openAIEffortOptions, stampedEffortOptions } from './modelMeta';
import { getModelDisplayName } from '../../../../utils/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';

export default function TierCard({
    tier, tierConfig, updateFn, defaults,
    expandedTier, setExpandedTier, chatModels, byProvider,
    hiddenModelIds, toggleHiddenModel, isLocal, reasoningCapable,
    applyClaudeRecommendedForTier,
}) {
        const isExpanded = expandedTier === tier.key;
        const selectedModel = chatModels.find(m => m.id === tierConfig.modelId);
        const displayName = selectedModel ? getModelDisplayName(selectedModel) : null;
        const selectedLabel = selectedModel
            ? (displayName !== selectedModel.id
                ? displayName
                : selectedModel.id)
            : '— Not configured —';
        // Mistral stamps its own effort vocabulary (none/high) on the model; the
        // select then offers exactly that and shows what is really sent.
        const stampedEfforts = Array.isArray(selectedModel?.efforts) && selectedModel.efforts.length > 0
            ? selectedModel.efforts
            : null;

        return (
            <div key={tier.key} className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}>
                <div className="p-4">
                    <div className="flex items-center gap-3 mb-3">
                        {tier.iconSrc
                            ? <img src={tier.iconSrc} alt="" className="w-6 h-6 object-contain" />
                            : <span className="text-xl">{tier.icon}</span>}
                        <div className="flex-1">
                            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{tier.label}</span>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{tier.desc}</p>
                        </div>
                        {defaults && (
                            <button
                                onClick={() => setExpandedTier(isExpanded ? null : tier.key)}
                                className="text-xs px-2 py-1 rounded-lg hover:bg-white/10 transition-colors"
                                style={{ color: 'var(--text-muted)' }}
                            >
                                {isExpanded ? '▲ Settings' : '▼ Settings'}
                            </button>
                        )}
                    </div>
                    <SearchableModelSelect
                        value={tierConfig.modelId || ''}
                        label={selectedLabel}
                        groups={byProvider}
                        onChange={({ modelId }) => updateFn(tier.key, 'modelId', modelId)}
                        hiddenIds={hiddenModelIds}
                        onToggleHidden={toggleHiddenModel}
                    />
                    {/* Bootstrap-only model picker for the Standard tier — used
                        for the per-conversation skill bootstrap pass to keep
                        cost down (e.g. Haiku) regardless of the main model. */}
                    {tier.key === 'standard' && (() => {
                        const bootstrapModel = chatModels.find(m => m.id === tierConfig.bootstrapModelId);
                        const bootstrapDisplayName = bootstrapModel ? getModelDisplayName(bootstrapModel) : null;
                        const bootstrapLabel = bootstrapModel
                            ? (bootstrapDisplayName !== bootstrapModel.id ? bootstrapDisplayName : bootstrapModel.id)
                            : '— Same as main model —';
                        return (
                            <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-default)' }}>
                                <label className="block text-[11px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                    Bootstrap model (cheap & fast)
                                </label>
                                <SearchableModelSelect
                                    value={tierConfig.bootstrapModelId || ''}
                                    label={bootstrapLabel}
                                    groups={byProvider}
                                    onChange={({ modelId }) => updateFn(tier.key, 'bootstrapModelId', modelId || '')}
                                    hiddenIds={hiddenModelIds}
                                    onToggleHidden={toggleHiddenModel}
                                />
                                <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                    Used once per direct chat to plan the conversation's Flow stages. Pick a small/fast model (e.g. Haiku) to cut planning cost. Leave empty to reuse the main model.
                                </p>
                            </div>
                        );
                    })()}
                </div>
                {defaults && isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: 'var(--border-default)' }}>
                        {/* Bee Flow recommended-defaults banner — only when a Claude model is selected */}
                        {isClaudeModel(tierConfig.modelId) && CLAUDE_RECOMMENDED[tier.key] && (() => {
                            const rec = CLAUDE_RECOMMENDED[tier.key];
                            return (
                                <div className="mb-3 mt-2 p-2.5 rounded-lg border flex items-center gap-3" style={{ background: 'rgba(217, 119, 6, 0.08)', borderColor: 'rgba(217, 119, 6, 0.3)' }}>
                                    <span className="text-base">💡</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>Bee Flow recommends</div>
                                        <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {(getModelMeta(rec.modelId)?.name || rec.modelId)} · {rec.maxTokens.toLocaleString()} tokens · {rec.reasoningEffort || 'no'} effort · {rec.budgetTokens ? `extended (${rec.budgetTokens.toLocaleString()})` : 'adaptive'}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => applyClaudeRecommendedForTier(tier.key)}
                                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium border hover:bg-white/5 transition-colors shrink-0"
                                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                    >
                                        Apply
                                    </button>
                                </div>
                            );
                        })()}

                        <div className="flex gap-4 flex-wrap">
                            <div className="flex-1 min-w-[180px]">
                                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Max Tokens</label>
                                <input
                                    type="number"
                                    value={tierConfig.maxTokens !== undefined ? tierConfig.maxTokens : defaults.maxTokens}
                                    onChange={e => updateFn(tier.key, 'maxTokens', parseInt(e.target.value) || defaults.maxTokens)}
                                    min={256} max={131072} step={256}
                                    className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm"
                                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                />
                                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                    Default: {defaults.maxTokens.toLocaleString()}. Thinking models need higher values.
                                </p>
                            </div>
                            <div className="flex-1 min-w-[180px]">
                                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Temperature</label>
                                <input
                                    type="number"
                                    value={tierConfig.temperature !== undefined ? tierConfig.temperature : defaults.temperature}
                                    onChange={e => updateFn(tier.key, 'temperature', parseFloat(e.target.value) || defaults.temperature)}
                                    min={0} max={2} step={0.1}
                                    disabled={isClaudeAdaptiveOnly(tierConfig.modelId)}
                                    className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm disabled:opacity-60"
                                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                />
                                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                    {isClaudeAdaptiveOnly(tierConfig.modelId)
                                        ? 'This model rejects temperature — thinking depth is set by Effort.'
                                        : `0 = deterministic, 1 = creative. Default: ${defaults.temperature}`}
                                </p>
                            </div>
                            {reasoningCapable(tierConfig.modelId) && (
                                <>
                                    <div className="flex-1 min-w-[180px]">
                                        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>🧠 {isClaudeReasoning(tierConfig.modelId) ? 'Thinking Effort' : 'Reasoning Effort'}</label>
                                        <select
                                            value={isGpt5Pro(tierConfig.modelId)
                                                ? 'high'
                                                : stampedEfforts
                                                    ? clampToEfforts(tierConfig.reasoningEffort || defaultTierEffort(tier.key), stampedEfforts)
                                                    : (tierConfig.reasoningEffort || (isClaudeReasoning(tierConfig.modelId) ? 'medium' : 'none'))}
                                            onChange={e => updateFn(tier.key, 'reasoningEffort', e.target.value)}
                                            disabled={isGpt5Pro(tierConfig.modelId)}
                                            className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm disabled:opacity-60"
                                            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                        >
                                            {isGpt5Pro(tierConfig.modelId) ? (
                                                <option value="high">High — pro models reason at high only</option>
                                            ) : stampedEfforts ? (
                                                stampedEffortOptions(stampedEfforts).map(([value, label]) => (
                                                    <option key={value} value={value}>{label}</option>
                                                ))
                                            ) : isClaudeReasoning(tierConfig.modelId) ? (
                                                <>
                                                    <option value="none">None (disabled)</option>
                                                    <option value="low">Low — quick tasks</option>
                                                    <option value="medium">Medium — balanced (default)</option>
                                                    <option value="high">High — complex reasoning</option>
                                                    {isClaudeAdaptiveOnly(tierConfig.modelId) ? (
                                                        <>
                                                            <option value="xhigh">xHigh — extended exploration</option>
                                                            <option value="max">Max — no thinking constraints</option>
                                                        </>
                                                    ) : (
                                                        <option value="xhigh">Max — deepest thinking</option>
                                                    )}
                                                </>
                                            ) : (
                                                /* OpenAI o-series / GPT-5 / 5.6 / 6 — the vocabulary
                                                   differs per generation, so it comes from the catalog
                                                   rather than being spelled out here. */
                                                openAIEffortOptions(tierConfig.modelId).map(([value, label]) => (
                                                    <option key={value} value={value}>{label}</option>
                                                ))
                                            )}
                                        </select>
                                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                            {isGpt5Pro(tierConfig.modelId)
                                                ? 'Pro models always reason at high effort.'
                                                : stampedEfforts && !isLocal(tierConfig.modelId)
                                                    ? 'This model takes only these levels. A level set elsewhere is rounded to the nearest one, so Low becomes None and Medium becomes High.'
                                                : isClaudeReasoning(tierConfig.modelId)
                                                    ? 'How deep Claude thinks before answering. Default: Medium.'
                                                    : isGpt56Plus(tierConfig.modelId)
                                                        ? 'How much the model reasons. Low is the fast/cheap tier here — Minimal was retired after GPT-5.5.'
                                                        : isGpt5(tierConfig.modelId)
                                                            ? 'How much the model reasons. Minimal is the fast/cheap GPT-5 tier.'
                                                            : isLocal(tierConfig.modelId)
                                                                ? 'Self-hosted: None switches thinking off — that part always works. The level itself only changes anything when the model\'s template grades it (gpt-oss does; Qwen3 treats every level as "on"). llama.cpp can cap thinking length server-wide with --reasoning-budget in its preset.'
                                                                : 'Controls how much the model reasons before responding.'}
                                        </p>
                                    </div>
                                    {!isClaudeReasoning(tierConfig.modelId) && (
                                        <div className="flex-1 min-w-[180px]">
                                            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>📝 Reasoning Summary</label>
                                            <div
                                                className="flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
                                                onClick={() => updateFn(tier.key, 'reasoningSummary', !tierConfig.reasoningSummary)}
                                            >
                                                <div className={`w-9 h-5 rounded-full relative transition-colors ${tierConfig.reasoningSummary ? 'bg-green-500' : 'bg-gray-600'}`}>
                                                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${tierConfig.reasoningSummary ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                                </div>
                                                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                                                    {tierConfig.reasoningSummary ? 'Enabled' : 'Disabled'}
                                                </span>
                                            </div>
                                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                                {isLocal(tierConfig.modelId)
                                                    ? "Show the model's own reasoning. A self-hosted runtime streams its full chain of thought rather than a summary — turn this off to keep it out of the reply."
                                                    : "Show a summary of the model's reasoning process."}
                                            </p>
                                        </div>
                                    )}
                                    {isGpt5(tierConfig.modelId) && (
                                        <div className="flex-1 min-w-[180px]">
                                            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>🗣️ Verbosity</label>
                                            <select
                                                value={tierConfig.verbosity || defaults.verbosity || 'medium'}
                                                onChange={e => updateFn(tier.key, 'verbosity', e.target.value)}
                                                className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            >
                                                <option value="low">Low — concise</option>
                                                <option value="medium">Medium — balanced (default)</option>
                                                <option value="high">High — detailed</option>
                                            </select>
                                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                                GPT-5 output length / level of detail.
                                            </p>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>

                        {/* Claude-specific row: thinking mode + budget tokens.
                            Only Sonnet 4.6 / Opus 4.6 honour budget_tokens — the
                            adaptive-only family (Opus 4.7/4.8, Sonnet 5, Fable 5)
                            rejects manual budget and Haiku has no thinking at all. */}
                        {isClaudeReasoning(tierConfig.modelId) && !isClaudeAdaptiveOnly(tierConfig.modelId) && (() => {
                            const mode = (tierConfig.budgetTokens && tierConfig.budgetTokens > 0) ? 'extended' : 'adaptive';
                            return (
                                <div className="mt-4 pt-4 border-t flex gap-4 flex-wrap" style={{ borderColor: 'var(--border-default)' }}>
                                    <div className="flex-1 min-w-[260px]">
                                        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Thinking Mode</label>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => updateFn(tier.key, 'budgetTokens', undefined)}
                                                className="flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors"
                                                style={{
                                                    background: mode === 'adaptive' ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                                                    borderColor: mode === 'adaptive' ? 'var(--accent-primary)' : 'var(--border-default)',
                                                    color: mode === 'adaptive' ? '#fff' : 'var(--text-primary)',
                                                }}
                                            >
                                                Adaptive
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const rec = CLAUDE_RECOMMENDED[tier.key];
                                                    const fallback = rec?.budgetTokens || 10000;
                                                    updateFn(tier.key, 'budgetTokens', fallback);
                                                }}
                                                className="flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors"
                                                style={{
                                                    background: mode === 'extended' ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                                                    borderColor: mode === 'extended' ? 'var(--accent-primary)' : 'var(--border-default)',
                                                    color: mode === 'extended' ? '#fff' : 'var(--text-primary)',
                                                }}
                                            >
                                                Extended (fixed budget)
                                            </button>
                                        </div>
                                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                            {mode === 'adaptive'
                                                ? 'Claude decides the thinking depth based on Effort. Shares the output budget — heavy turns can leave no room for the answer.'
                                                : 'Fixed thinking budget. Output is guaranteed (max tokens − budget). Safer for long answers.'}
                                        </p>
                                    </div>
                                    {mode === 'extended' && (
                                        <div className="flex-1 min-w-[180px]">
                                            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Thinking Budget</label>
                                            <input
                                                type="number"
                                                value={tierConfig.budgetTokens || ''}
                                                onChange={e => {
                                                    const v = parseInt(e.target.value, 10);
                                                    updateFn(tier.key, 'budgetTokens', isNaN(v) || v <= 0 ? undefined : v);
                                                }}
                                                min={1024} max={64000} step={1024}
                                                placeholder="10000"
                                                className="w-full px-3 py-2 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm"
                                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                            />
                                            <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                                Tokens reserved for thinking. Must be {'<'} Max Tokens.
                                            </p>
                                        </div>
                                    )}
                                </div>
                            );
                        })()}

                        {/* Adaptive-only explainer — manual budgets are not supported */}
                        {isClaudeAdaptiveOnly(tierConfig.modelId) && (
                            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-default)' }}>
                                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{getModelMeta(tierConfig.modelId)?.name || 'This model'} uses adaptive thinking only.</span> The API rejects manual thinking budgets and the temperature setting — the Effort dropdown above controls how deep the model thinks. Use Auto-retry on empty output (Claude Settings panel) as a safety net for heavy reasoning runs.
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
}
