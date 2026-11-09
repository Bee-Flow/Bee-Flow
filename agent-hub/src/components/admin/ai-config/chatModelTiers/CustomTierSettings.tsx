// The expanded settings of one custom tier: where it is offered, token limit,
// temperature and the reasoning controls. Same state and handlers as before.
import React from 'react';
import { CUSTOM_TIER_DEFAULTS, TASK_TYPES } from './constants';
import { clampToEfforts, getModelMeta, isClaudeAdaptiveOnly, isClaudeReasoning, isGpt5, isGpt5Pro, openAIEffortOptions, stampedEffortOptions } from './modelMeta';
import TierThinkingFields from './TierThinkingFields';
import type { CustomTier } from './tierTypes';
import type { CustomTiersState } from './useCustomTiers';
import { FIELD_INPUT, FieldGrid, Field } from '@/components/shared/SettingsList';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

interface CustomTierSettingsProps {
    tier: CustomTier;
    stampedEfforts: string[] | null;
    reasoningCapable: (id: string) => boolean;
    updateCustomTier: CustomTiersState['updateCustomTier'];
    toggleCustomTaskType: CustomTiersState['toggleCustomTaskType'];
}

const OPENAI_LABELS = (t: TranslateFn): Record<string, string> => ({
    none: t('admin_ai_config.tier_eff_none', 'None (disabled)'),
    xhigh: t('admin_ai_config.tier_eff_xhigh', 'xHigh'),
    low: t('admin_ai_config.tier_eff_low', 'Low'),
    medium: t('admin_ai_config.tier_eff_medium', 'Medium'),
    high: t('admin_ai_config.tier_eff_high', 'High'),
    max: t('admin_ai_config.tier_eff_max', 'Max'),
});

function CustomEffortOptions({ tier, stampedEfforts }: { tier: CustomTier; stampedEfforts: string[] | null }) {
    const { t } = useTranslation();
    if (isGpt5Pro(tier.modelId)) return <option value="high">{t('admin_ai_config.tier_eff_pro_locked', 'High (pro: locked)')}</option>;
    if (stampedEfforts) return <>{stampedEffortOptions(stampedEfforts).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>;
    if (isClaudeReasoning(tier.modelId)) {
        const adaptive = isClaudeAdaptiveOnly(tier.modelId);
        return (
            <>
                <option value="none">{t('admin_ai_config.tier_eff_none', 'None (disabled)')}</option>
                <option value="low">{t('admin_ai_config.tier_eff_low', 'Low')}</option>
                <option value="medium">{t('admin_ai_config.tier_eff_medium', 'Medium')}</option>
                <option value="high">{t('admin_ai_config.tier_eff_high', 'High')}</option>
                {adaptive && <option value="xhigh">{t('admin_ai_config.tier_eff_xhigh', 'xHigh')}</option>}
                {adaptive && <option value="max">{t('admin_ai_config.tier_eff_max', 'Max')}</option>}
            </>
        );
    }
    /* OpenAI: the effort vocabulary differs per generation. */
    const labels = OPENAI_LABELS(t);
    return <>{openAIEffortOptions(tier.modelId).map(([value]) => <option key={value} value={value}>{labels[value] ?? value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</>;
}

function CustomReasoningFields({ tier, stampedEfforts, updateCustomTier }: Pick<CustomTierSettingsProps, 'tier' | 'stampedEfforts' | 'updateCustomTier'>) {
    const { t } = useTranslation();
    return (
        <>
            <Field label={isClaudeReasoning(tier.modelId) ? t('admin_ai_config.tier_thinking_effort', 'Thinking effort') : t('admin_ai_config.tier_reasoning_effort', 'Reasoning effort')}>
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
                    className={FIELD_INPUT}
                >
                    <CustomEffortOptions tier={tier} stampedEfforts={stampedEfforts} />
                </select>
            </Field>
            {isGpt5(tier.modelId) && (
                <Field label={t('admin_ai_config.tier_verbosity', 'Verbosity')}>
                    <select
                        value={tier.verbosity || 'medium'}
                        onChange={e => updateCustomTier(tier.id, { verbosity: e.target.value })}
                        className={FIELD_INPUT}
                    >
                        <option value="low">{t('admin_ai_config.tier_verb_low', 'Low: concise')}</option>
                        <option value="medium">{t('admin_ai_config.tier_verb_medium_custom', 'Medium: balanced')}</option>
                        <option value="high">{t('admin_ai_config.tier_verb_high', 'High: detailed')}</option>
                    </select>
                </Field>
            )}
        </>
    );
}

/** Which task types the tier is offered for, as toggle chips. */
function TaskTypeChips({ tier, toggleCustomTaskType }: Pick<CustomTierSettingsProps, 'tier' | 'toggleCustomTaskType'>) {
    const { t } = useTranslation();
    const taskTypes = new Set(tier.allowedTaskTypes || []);
    return (
        <Field label={t('admin_ai_config.custom_available_for', 'Available for')}>
            <div className="flex flex-wrap gap-1.5">
                {TASK_TYPES.map(tt => {
                    const active = taskTypes.has(tt.key);
                    return (
                        <button
                            key={tt.key}
                            type="button"
                            aria-pressed={active}
                            onClick={() => toggleCustomTaskType(tier.id, tt.key)}
                            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${active
                                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                                : 'border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                        >
                            {active ? '✓ ' : ''}{tt.label}
                        </button>
                    );
                })}
            </div>
        </Field>
    );
}

export default function CustomTierSettings({ tier, stampedEfforts, reasoningCapable, updateCustomTier, toggleCustomTaskType }: CustomTierSettingsProps) {
    const { t } = useTranslation();
    const adaptiveOnly = isClaudeAdaptiveOnly(tier.modelId);
    return (
        <div className="flex flex-col gap-3">
            <TaskTypeChips tier={tier} toggleCustomTaskType={toggleCustomTaskType} />
            <FieldGrid>
                <Field label={t('admin_ai_config.tier_max_tokens', 'Max Tokens')}>
                    <input
                        type="number"
                        value={tier.maxTokens !== undefined ? tier.maxTokens : CUSTOM_TIER_DEFAULTS.maxTokens}
                        onChange={e => updateCustomTier(tier.id, { maxTokens: parseInt(e.target.value) || CUSTOM_TIER_DEFAULTS.maxTokens })}
                        min={256} max={131072} step={256}
                        className={FIELD_INPUT}
                    />
                </Field>
                <Field label={t('admin_ai_config.tier_temperature', 'Temperature')}>
                    <input
                        type="number"
                        value={tier.temperature !== undefined ? tier.temperature : CUSTOM_TIER_DEFAULTS.temperature}
                        onChange={e => updateCustomTier(tier.id, { temperature: parseFloat(e.target.value) || CUSTOM_TIER_DEFAULTS.temperature })}
                        min={0} max={2} step={0.1}
                        className={FIELD_INPUT}
                    />
                </Field>
                {reasoningCapable(tier.modelId) && <CustomReasoningFields tier={tier} stampedEfforts={stampedEfforts} updateCustomTier={updateCustomTier} />}
                {/* Claude thinking mode + budget (Sonnet/Opus 4.6 only: the adaptive-only family has no manual budget). */}
                {isClaudeReasoning(tier.modelId) && !adaptiveOnly && (
                    <TierThinkingFields
                        budgetTokens={tier.budgetTokens}
                        adaptiveHint={t('admin_ai_config.tier_adaptive_hint', 'Claude decides depth from Effort. Shares Max Tokens with output.')}
                        extendedHint={t('admin_ai_config.tier_extended_hint', 'Fixed thinking budget. Output is guaranteed (max tokens − budget).')}
                        onAdaptive={() => updateCustomTier(tier.id, { budgetTokens: undefined })}
                        onExtended={() => updateCustomTier(tier.id, { budgetTokens: tier.budgetTokens || 10000 })}
                        onBudget={v => updateCustomTier(tier.id, { budgetTokens: v })}
                    />
                )}
            </FieldGrid>
            {adaptiveOnly && (
                <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                    {t('admin_ai_config.tier_adaptive_only', '{model} uses adaptive thinking only: the Effort dropdown controls how deep the model thinks. Manual thinking budgets and the temperature setting are not supported.', { model: getModelMeta(tier.modelId)?.name || t('admin_ai_config.tier_this_model', 'This model') })}
                </p>
            )}
        </div>
    );
}
