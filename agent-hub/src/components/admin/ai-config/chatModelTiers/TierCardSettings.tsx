// The expanded settings of one standard tier: token limit, temperature,
// reasoning controls and (Flow) the bootstrap model. Same state and handlers
// as before; only the markup is a grid of compact fields.
import React from 'react';
import { CLAUDE_RECOMMENDED, type TierDef, type TierDefaults } from './constants';
import { clampToEfforts, defaultTierEffort, getModelMeta, isClaudeAdaptiveOnly, isClaudeModel, isClaudeReasoning, isGpt5, isGpt5Pro, isGpt56Plus, openAIEffortOptions, stampedEffortOptions } from './modelMeta';
import TierThinkingFields from './TierThinkingFields';
import type { TierSettings, CatalogModel } from './tierTypes';
import { getModelDisplayName } from '@/api/modelMeta';
import SearchableModelSelect from '../../shared/SearchableModelSelect';
import { FIELD_INPUT, FieldGrid, Field, InlineHint, QUIET_BUTTON } from '@/components/shared/SettingsList';
import Toggle from '@/components/shared/Toggle';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

export interface TierCardSettingsProps {
    tier: TierDef;
    tierConfig: TierSettings;
    updateFn: (tierKey: string, field: string, value: unknown) => void;
    defaults: TierDefaults | null;
    chatModels: CatalogModel[];
    byProvider: Record<string, CatalogModel[]>;
    hiddenModelIds: string[];
    toggleHiddenModel: (modelId: string) => Promise<void>;
    isLocal: (id: string) => boolean;
    reasoningCapable: (id: string) => boolean;
    applyClaudeRecommendedForTier: (tierKey: string) => void;
}

/** "Bee Flow recommends" for a Claude model on this tier, with Apply: a slim line, not a box. */
function ClaudeRecommendedHint({ t, tierKey, onApply }: { t: TranslateFn; tierKey: string; onApply: (tierKey: string) => void }) {
    const rec = CLAUDE_RECOMMENDED[tierKey];
    return (
        <InlineHint
            action={(
                <button type="button" onClick={() => onApply(tierKey)} className={QUIET_BUTTON}>
                    {t('admin_ai_config.claude_apply', 'Apply')}
                </button>
            )}
        >
            <span className="font-medium text-[var(--text-primary)]">{t('admin_ai_config.tier_rec_title', 'Bee Flow recommends')}</span>{' '}
            {t('admin_ai_config.tier_rec_line', '{model} · {tokens} tokens · {effort} effort · {mode}', { model: getModelMeta(rec.modelId)?.name || rec.modelId, tokens: rec.maxTokens.toLocaleString(), effort: rec.reasoningEffort || t('admin_ai_config.tier_rec_no_effort', 'no'), mode: rec.budgetTokens ? t('admin_ai_config.tier_rec_extended', 'extended ({n})', { n: rec.budgetTokens.toLocaleString() }) : t('admin_ai_config.claude_adaptive', 'adaptive') })}
        </InlineHint>
    );
}

/** The hint under the effort select: which levels the model takes and what they do. */
function effortHint(t: TranslateFn, modelId: string, stamped: boolean, isLocal: (id: string) => boolean): string {
    if (isGpt5Pro(modelId)) return t('admin_ai_config.tier_hint_pro', 'Pro models always reason at high effort.');
    if (stamped && !isLocal(modelId)) return t('admin_ai_config.tier_hint_stamped', 'This model takes only these levels. A level set elsewhere is rounded to the nearest one, so Low becomes None and Medium becomes High.');
    if (isClaudeReasoning(modelId)) return t('admin_ai_config.tier_hint_claude', 'How deep Claude thinks before answering. Default: Medium.');
    if (isGpt56Plus(modelId)) return t('admin_ai_config.tier_hint_gpt56', 'How much the model reasons. Low is the fast/cheap tier here: Minimal was retired after GPT-5.5.');
    if (isGpt5(modelId)) return t('admin_ai_config.tier_hint_gpt5', 'How much the model reasons. Minimal is the fast/cheap GPT-5 tier.');
    if (isLocal(modelId)) return t('admin_ai_config.tier_hint_local', 'Self-hosted: None switches thinking off, which always works. The level itself only changes anything when the model\'s template grades it (gpt-oss does; Qwen3 treats every level as "on"). llama.cpp can cap thinking length server-wide with --reasoning-budget in its preset.');
    return t('admin_ai_config.tier_hint_default', 'Controls how much the model reasons before responding.');
}

function EffortOptions({ t, modelId, stamped }: { t: TranslateFn; modelId: string; stamped: string[] | null }) {
    if (isGpt5Pro(modelId)) return <option value="high">{t('admin_ai_config.tier_eff_pro', 'High: pro models reason at high only')}</option>;
    if (stamped) return <>{stampedEffortOptions(stamped).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>;
    if (isClaudeReasoning(modelId)) {
        return (
            <>
                <option value="none">{t('admin_ai_config.tier_eff_none', 'None (disabled)')}</option>
                <option value="low">{t('admin_ai_config.tier_eff_low_d', 'Low: quick tasks')}</option>
                <option value="medium">{t('admin_ai_config.tier_eff_medium_d', 'Medium: balanced (default)')}</option>
                <option value="high">{t('admin_ai_config.tier_eff_high_d', 'High: complex reasoning')}</option>
                {isClaudeAdaptiveOnly(modelId) ? (
                    <>
                        <option value="xhigh">{t('admin_ai_config.tier_eff_xhigh_d', 'xHigh: extended exploration')}</option>
                        <option value="max">{t('admin_ai_config.tier_eff_max_d', 'Max: no thinking constraints')}</option>
                    </>
                ) : (
                    <option value="xhigh">{t('admin_ai_config.tier_eff_max_deep', 'Max: deepest thinking')}</option>
                )}
            </>
        );
    }
    /* OpenAI o-series / GPT-5 / 5.6 / 6: the vocabulary differs per generation, so it comes from the catalog. */
    return <>{openAIEffortOptions(modelId).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>;
}

type ReasoningFieldsProps = Pick<TierCardSettingsProps, 'tier' | 'tierConfig' | 'updateFn' | 'isLocal'> & { defaults: TierDefaults; stampedEfforts: string[] | null };

function ReasoningFields({ tier, tierConfig, updateFn, defaults, stampedEfforts, isLocal }: ReasoningFieldsProps) {
    const { t } = useTranslation();
    const modelId = tierConfig.modelId;
    const effortValue = isGpt5Pro(modelId)
        ? 'high'
        : stampedEfforts
            ? clampToEfforts(tierConfig.reasoningEffort || defaultTierEffort(tier.key), stampedEfforts)
            : (tierConfig.reasoningEffort || (isClaudeReasoning(modelId) ? 'medium' : 'none'));
    return (
        <>
            <Field
                label={isClaudeReasoning(modelId) ? t('admin_ai_config.tier_thinking_effort', 'Thinking effort') : t('admin_ai_config.tier_reasoning_effort', 'Reasoning effort')}
                hint={effortHint(t, modelId, !!stampedEfforts, isLocal)}
            >
                <select
                    value={effortValue}
                    onChange={e => updateFn(tier.key, 'reasoningEffort', e.target.value)}
                    disabled={isGpt5Pro(modelId)}
                    className={FIELD_INPUT}
                >
                    <EffortOptions t={t} modelId={modelId} stamped={stampedEfforts} />
                </select>
            </Field>
            {!isClaudeReasoning(modelId) && (
                <Field
                    label={t('admin_ai_config.tier_summary', 'Reasoning summary')}
                    hint={isLocal(modelId)
                        ? t('admin_ai_config.tier_summary_local', 'Show the model\'s own reasoning. A self-hosted runtime streams its full chain of thought rather than a summary: turn this off to keep it out of the reply.')
                        : t('admin_ai_config.tier_summary_hint', 'Show a summary of the model\'s reasoning process.')}
                >
                    <Toggle
                        size="sm"
                        checked={!!tierConfig.reasoningSummary}
                        onChange={next => updateFn(tier.key, 'reasoningSummary', next)}
                        ariaLabel={t('admin_ai_config.tier_summary', 'Reasoning summary')}
                    />
                </Field>
            )}
            {isGpt5(modelId) && (
                <Field label={t('admin_ai_config.tier_verbosity', 'Verbosity')} hint={t('admin_ai_config.tier_verb_hint', 'GPT-5 output length / level of detail.')}>
                    <select
                        value={(tierConfig.verbosity as string | undefined) || defaults.verbosity || 'medium'}
                        onChange={e => updateFn(tier.key, 'verbosity', e.target.value)}
                        className={FIELD_INPUT}
                    >
                        <option value="low">{t('admin_ai_config.tier_verb_low', 'Low: concise')}</option>
                        <option value="medium">{t('admin_ai_config.tier_verb_medium', 'Medium: balanced (default)')}</option>
                        <option value="high">{t('admin_ai_config.tier_verb_high', 'High: detailed')}</option>
                    </select>
                </Field>
            )}
        </>
    );
}

/** Flow only: a cheap model for the per-conversation skill bootstrap pass, whatever the main model is. */
function BootstrapField({ tierConfig, updateFn, chatModels, byProvider, hiddenModelIds, toggleHiddenModel }: Pick<TierCardSettingsProps, 'tierConfig' | 'updateFn' | 'chatModels' | 'byProvider' | 'hiddenModelIds' | 'toggleHiddenModel'>) {
    const { t } = useTranslation();
    const model = chatModels.find(m => m.id === tierConfig.bootstrapModelId);
    const display = model ? getModelDisplayName(model) : null;
    const label = model ? (display !== model.id ? display : model.id) : t('admin_ai_config.tier_same_as_main', 'Same as main model');
    return (
        <Field
            label={t('admin_ai_config.tier_bootstrap', 'Bootstrap model (cheap & fast)')}
            hint={t('admin_ai_config.tier_bootstrap_hint', 'Used once per direct chat to plan the conversation\'s Flow stages. Pick a small/fast model (e.g. Haiku) to cut planning cost. Leave empty to reuse the main model.')}
        >
            <SearchableModelSelect
                value={tierConfig.bootstrapModelId || ''}
                label={label}
                groups={byProvider}
                onChange={({ modelId }) => updateFn('standard', 'bootstrapModelId', modelId || '')}
                hiddenIds={hiddenModelIds}
                onToggleHidden={toggleHiddenModel} />
        </Field>
    );
}

/** The fields every tier with defaults has: limits, reasoning, Claude's thinking mode. */
function DefaultsFields(props: TierCardSettingsProps & { defaults: TierDefaults }) {
    const { t } = useTranslation();
    const { tier, tierConfig, updateFn, defaults, chatModels, isLocal, reasoningCapable } = props;
    const modelId = tierConfig.modelId;
    const selectedModel = chatModels.find(m => m.id === modelId);
    // Mistral stamps its own effort vocabulary (none/high) on the model; the
    // select then offers exactly that and shows what is really sent.
    const stampedEfforts = Array.isArray(selectedModel?.efforts) && selectedModel.efforts.length > 0 ? selectedModel.efforts : null;
    const adaptiveOnly = isClaudeAdaptiveOnly(modelId);
    return (
                    <>
                        <Field label={t('admin_ai_config.tier_max_tokens', 'Max Tokens')} hint={t('admin_ai_config.tier_max_hint', 'Default: {n}. Thinking models need higher values.', { n: defaults.maxTokens.toLocaleString() })}>
                            <input
                                type="number"
                                value={tierConfig.maxTokens !== undefined ? tierConfig.maxTokens : defaults.maxTokens}
                                onChange={e => updateFn(tier.key, 'maxTokens', parseInt(e.target.value) || defaults.maxTokens)}
                                min={256} max={131072} step={256}
                                className={FIELD_INPUT}
                            />
                        </Field>
                        <Field
                            label={t('admin_ai_config.tier_temperature', 'Temperature')}
                            hint={adaptiveOnly
                                ? t('admin_ai_config.tier_temp_rejected', 'This model rejects temperature: thinking depth is set by Effort.')
                                : t('admin_ai_config.tier_temp_hint', '0 = deterministic, 1 = creative. Default: {n}', { n: defaults.temperature })}
                        >
                            <input
                                type="number"
                                value={tierConfig.temperature !== undefined ? tierConfig.temperature : defaults.temperature}
                                onChange={e => updateFn(tier.key, 'temperature', parseFloat(e.target.value) || defaults.temperature)}
                                min={0} max={2} step={0.1}
                                disabled={adaptiveOnly}
                                className={FIELD_INPUT}
                            />
                        </Field>
                        {reasoningCapable(modelId) && (
                            <ReasoningFields tier={tier} tierConfig={tierConfig} updateFn={updateFn} defaults={defaults} stampedEfforts={stampedEfforts} isLocal={isLocal} />
                        )}
                        {/* Claude thinking mode + budget: only Sonnet 4.6 / Opus 4.6 honour budget_tokens. */}
                        {isClaudeReasoning(modelId) && !adaptiveOnly && (
                            <TierThinkingFields
                                budgetTokens={tierConfig.budgetTokens}
                                adaptiveHint={t('admin_ai_config.tier_adaptive_hint2', 'Claude decides the thinking depth based on Effort. Shares the output budget: heavy turns can leave no room for the answer.')}
                                extendedHint={t('admin_ai_config.tier_extended_hint2', 'Fixed thinking budget. Output is guaranteed (max tokens − budget). Safer for long answers.')}
                                onAdaptive={() => updateFn(tier.key, 'budgetTokens', undefined)}
                                onExtended={() => updateFn(tier.key, 'budgetTokens', CLAUDE_RECOMMENDED[tier.key]?.budgetTokens || 10000)}
                                onBudget={v => updateFn(tier.key, 'budgetTokens', v)}
                            />
                        )}
                    </>
    );
}

export default function TierCardSettings(props: TierCardSettingsProps) {
    const { t } = useTranslation();
    const { tier, tierConfig, defaults, applyClaudeRecommendedForTier } = props;
    const modelId = tierConfig.modelId;
    const adaptiveOnly = isClaudeAdaptiveOnly(modelId);
    return (
        <div className="flex flex-col gap-3">
            {defaults && isClaudeModel(modelId) && CLAUDE_RECOMMENDED[tier.key] && (
                <ClaudeRecommendedHint t={t} tierKey={tier.key} onApply={applyClaudeRecommendedForTier} />
            )}
            <FieldGrid>
                {defaults && <DefaultsFields {...props} defaults={defaults} />}
                {tier.key === 'standard' && <BootstrapField {...props} />}
            </FieldGrid>
            {defaults && adaptiveOnly && (
                <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                    <span className="font-medium text-[var(--text-primary)]">{t('admin_ai_config.tier_adaptive_only_lead', '{model} uses adaptive thinking only.', { model: getModelMeta(modelId)?.name || t('admin_ai_config.tier_this_model', 'This model') })}</span>{' '}
                    {t('admin_ai_config.tier_adaptive_only_rest', 'The API rejects manual thinking budgets and the temperature setting: the Effort dropdown above controls how deep the model thinks. Use Auto-retry on empty output (Claude Settings panel) as a safety net for heavy reasoning runs.')}
                </p>
            )}
        </div>
    );
}
