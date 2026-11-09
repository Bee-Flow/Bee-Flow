// "Claude Settings" section of ChatModelTiersConfig (recommended defaults
// table + robustness toggles). Subtree moved verbatim from
// ChatModelTiersConfig.jsx; all bindings are threaded in as props.
import React from 'react';
import type { ClaudeSettingsState } from './useClaudeSettings';
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER, TIERS } from './constants';
import { getModelMeta } from './modelMeta';
import { QUIET_BUTTON, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useToastOnMessage } from '../ui/useToastOnMessage';
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
    useToastOnMessage(claudeMessage);
    return (
        <SettingsGroup
            title={t('admin_ai_config.claude_title', 'Claude Settings')}
            description={t('admin_ai_config.claude_subtitle', 'Bee Flow\'s recommended Claude defaults per tier, plus Claude-specific robustness knobs.')}
            actions={(
                <button type="button" onClick={applyAllClaudeRecommended} className={QUIET_BUTTON}>
                    {t('admin_ai_config.claude_apply_all', 'Apply all recommended')}
                </button>
            )}
        >
            <SettingsList>
                {/* Per-tier recommendations table */}
                <div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">
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
                                            <td className="px-3 py-2 font-mono text-[11px] text-[var(--text-tertiary)]">
                                                {displayName}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {rec.maxTokens.toLocaleString()}
                                            </td>
                                            <td className="px-3 py-2">
                                                {rec.reasoningEffort || <span className="text-[var(--text-tertiary)]">—</span>}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">
                                                {rec.budgetTokens
                                                    ? rec.budgetTokens.toLocaleString()
                                                    : <span className="text-[var(--text-tertiary)]">{t('admin_ai_config.claude_adaptive', 'adaptive')}</span>}
                                            </td>
                                            <td className="px-3 py-2 text-[var(--text-tertiary)]">
                                                {rec.note}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                <button type="button" onClick={() => applyClaudeRecommendedForTier(tierKey)} className={QUIET_BUTTON}>
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
                <p className="m-0 px-4 py-2 text-[11px] text-[var(--text-tertiary)]">
                    {t('admin_ai_config.claude_apply_hint', 'Apply patches the local tier configuration above: click "Save Tier Configuration" to persist.')}
                </p>

                {/* Robustness toggle */}
                <SettingRow
                    label={t('admin_ai_config.claude_retry_title', 'Auto-retry on empty output')}
                    hint={(
                        <>
                            {t('admin_ai_config.claude_retry_hint', 'When a Claude turn finishes with thinking but no text (adaptive thinking consumed the whole budget), do one follow-up call without thinking so the model writes a real answer based on what it already deliberated. Strongly recommended.')}
                            {claudeSaving && <span className="ml-1">{t('admin_ai_config.saving_ellipsis', 'Saving…')}</span>}
                        </>
                    )}
                >
                    <div className="flex justify-end">
                        <Toggle
                            checked={claudeAutoRetry}
                            onChange={(next) => { setClaudeAutoRetry(next); saveClaudeSettings(next); }}
                            ariaLabel={t('admin_ai_config.claude_retry_title', 'Auto-retry on empty output')}
                        />
                    </div>
                </SettingRow>
            </SettingsList>
        </SettingsGroup>
    );
}
