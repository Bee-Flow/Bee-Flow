// "Claude Settings" section of ChatModelTiersConfig (recommended defaults
// table + robustness toggles). Subtree moved verbatim from
// ChatModelTiersConfig.jsx; all bindings are threaded in as props.
import React from 'react';
import type { ClaudeSettingsState } from './useClaudeSettings';
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER, TIERS } from './constants';
import { getModelMeta } from './modelMeta';
import Section from '@/components/shared/Section';
import Toggle from '@/components/shared/Toggle';
import { useTranslation } from '@/hooks/useTranslation';

type ClaudeSettingsSectionProps = Pick<ClaudeSettingsState,
    'claudeAutoRetry' | 'setClaudeAutoRetry' | 'claudeSaving' | 'claudeMessage' | 'claudeRecAppliedTier'
    | 'saveClaudeSettings' | 'applyClaudeRecommendedForTier' | 'applyAllClaudeRecommended'>;

export default function ClaudeSettingsSection({
    claudeAutoRetry, setClaudeAutoRetry, claudeSaving, claudeMessage,
    claudeRecAppliedTier, saveClaudeSettings,
    applyClaudeRecommendedForTier, applyAllClaudeRecommended,
}: ClaudeSettingsSectionProps) {
    const { t } = useTranslation();
    return (
            <Section
                title={t('admin_ai_config.claude_title', 'Claude Settings')}
                description={t('admin_ai_config.claude_subtitle', 'Bee Flow\'s recommended Claude defaults per tier, plus Claude-specific robustness knobs.')}
                actions={(
                    <button
                        onClick={applyAllClaudeRecommended}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-white hover:opacity-90 transition-opacity bg-[var(--accent-primary)]"
                    >
                        {t('admin_ai_config.claude_apply_all', 'Apply all recommended')}
                    </button>
                )}
            >
                {claudeMessage && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${claudeMessage.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {claudeMessage.text}
                    </div>
                )}

                {/* Per-tier recommendations table */}
                <div className="rounded-xl border overflow-hidden mb-5 bg-[var(--bg-tertiary)] border-[var(--border-default)]">
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">{t('admin_ai_config.claude_col_tier', 'Tier')}</th>
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">{t('admin_ai_config.claude_col_model', 'Model')}</th>
                                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">{t('admin_ai_config.claude_col_max', 'Max tokens')}</th>
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">{t('admin_ai_config.claude_col_effort', 'Effort')}</th>
                                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">{t('admin_ai_config.claude_col_budget', 'Budget')}</th>
                                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">{t('admin_ai_config.claude_col_notes', 'Notes')}</th>
                                    <th className="px-3 py-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {CLAUDE_REC_TIER_ORDER.map(tierKey => {
                                    const rec = CLAUDE_RECOMMENDED[tierKey];
                                    const tier = TIERS.find(x => x.key === tierKey);
                                    const flash = claudeRecAppliedTier === tierKey;
                                    const meta = getModelMeta(rec.modelId);
                                    const displayName = meta?.name || rec.modelId;
                                    return (
                                        <tr key={tierKey}
                                            className={`[border-top:1px_solid_var(--border-default)] [transition:background_300ms_ease] [color:var(--text-primary)] ${flash ? '[background:rgba(34,_197,_94,_0.1)]' : '[background:transparent]'}`}
                                        >
                                            <td className="px-3 py-2">
                                                <span className="font-medium">{tier?.label || tierKey}</span>
                                            </td>
                                            <td className="px-3 py-2 font-mono text-[11px] text-[var(--text-muted)]">
                                                {displayName}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {rec.maxTokens.toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2">
                                                {rec.reasoningEffort || <span className="text-[var(--text-muted)]">—</span>}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {rec.budgetTokens
                                                    ? rec.budgetTokens.toLocaleString()
                                                    : <span className="text-[var(--text-muted)]">{t('admin_ai_config.claude_adaptive', 'adaptive')}</span>}
                                            </td>
                                            <td className="px-3 py-2 text-[var(--text-muted)]">
                                                {rec.note}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                <button
                                                    onClick={() => applyClaudeRecommendedForTier(tierKey)}
                                                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium border hover:bg-white/5 transition-colors border-[var(--border-default)] text-[var(--text-primary)]"
                                                >
                                                    {t('admin_ai_config.claude_apply', 'Apply')}
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
                <p className="text-[11px] mb-5 italic text-[var(--text-muted)]">
                    {t('admin_ai_config.claude_apply_hint', 'Apply patches the local tier configuration above: click "Save Tier Configuration" to persist.')}
                </p>

                {/* Robustness toggles */}
                <Toggle
                    checked={claudeAutoRetry}
                    onChange={(next) => { setClaudeAutoRetry(next); saveClaudeSettings(next); }}
                    label={t('admin_ai_config.claude_retry_title', 'Auto-retry on empty output')}
                    description={(
                        <>
                            {t('admin_ai_config.claude_retry_hint', 'When a Claude turn finishes with thinking but no text (adaptive thinking consumed the whole budget), do one follow-up call without thinking so the model writes a real answer based on what it already deliberated. Strongly recommended.')}
                            {claudeSaving && <span className="ml-1">{t('admin_ai_config.saving_ellipsis', 'Saving…')}</span>}
                        </>
                    )}
                />
            </Section>
    );
}
