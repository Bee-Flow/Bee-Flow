// "Claude models" section of ChatModelTiersConfig: the recommended Claude
// defaults per tier and the empty-answer safety net. The panel renders it only
// when a Claude model is configured (hasClaudeModels); a recommendation whose
// model this server does not offer cannot be applied.
import type { ClaudeSettingsState } from './useClaudeSettings';
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER, TIERS } from './constants';
import { applicableRecommendations } from './claudeRecommendations';
import { getModelMeta } from './modelMeta';
import type { CatalogModel } from './tierTypes';
import { QUIET_BUTTON, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useToastOnMessage } from '../ui/useToastOnMessage';
import Toggle from '@/components/shared/Toggle';
import useConfirm from '@/components/shared/useConfirm';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

type ClaudeSettingsSectionProps = Pick<ClaudeSettingsState,
    'claudeAutoRetry' | 'setClaudeAutoRetry' | 'claudeSaving' | 'claudeMessage' | 'claudeRecAppliedTier'
    | 'saveClaudeSettings' | 'applyClaudeRecommendedForTier' | 'applyAllClaudeRecommended'> & {
    /** The configured chat models: a recommendation applies only when its model is among them. */
    chatModels: readonly CatalogModel[];
};

/** The translated note of one tier's recommendation (English fallback from constants). */
function recNote(t: TranslateFn, tierKey: string): string {
    const fallback = CLAUDE_RECOMMENDED[tierKey]?.note || '';
    switch (tierKey) {
        case 'fast': return t('ai_model_setup.claude_rec_note_fast', fallback);
        case 'standard': return t('ai_model_setup.claude_rec_note_standard', fallback);
        case 'swarm': return t('ai_model_setup.claude_rec_note_swarm', fallback);
        case 'thinking': return t('ai_model_setup.claude_rec_note_thinking', fallback);
        case 'writer': return t('ai_model_setup.claude_rec_note_writer', fallback);
        case 'pro': return t('ai_model_setup.claude_rec_note_pro', fallback);
        default: return fallback;
    }
}

export default function ClaudeSettingsSection({
    claudeAutoRetry, setClaudeAutoRetry, claudeSaving, claudeMessage,
    claudeRecAppliedTier, saveClaudeSettings,
    applyClaudeRecommendedForTier, applyAllClaudeRecommended, chatModels,
}: ClaudeSettingsSectionProps) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    useToastOnMessage(claudeMessage);
    const applicable = applicableRecommendations(chatModels);
    const applicableTiers = CLAUDE_REC_TIER_ORDER.filter(key => applicable[key]);

    const onApplyAll = async () => {
        if (applicableTiers.length === 0) return;
        const labels = applicableTiers.map(key => TIERS.find(x => x.key === key)?.label || key).join(', ');
        const description = applicableTiers.length === 1
            ? t('ai_model_setup.claude_apply_all_confirm_desc_one', 'This replaces the model and settings of 1 tier ({tiers}). Tiers whose recommended model this server does not offer keep what they have. Nothing is saved until you click Save Tier Configuration.', { tiers: labels })
            : t('ai_model_setup.claude_apply_all_confirm_desc', 'This replaces the model and settings of {n} tiers ({tiers}). Tiers whose recommended model this server does not offer keep what they have. Nothing is saved until you click Save Tier Configuration.', { n: applicableTiers.length, tiers: labels });
        const ok = await confirm({
            title: t('ai_model_setup.claude_apply_all_confirm_title', 'Apply the recommended settings?'),
            description,
            confirmLabel: t('admin_ai_config.claude_apply_all', 'Apply all recommended'),
        });
        if (ok) applyAllClaudeRecommended(chatModels);
    };

    return (
        <SettingsGroup
            title={t('admin_ai_config.claude_title', 'Claude models')}
            description={t('admin_ai_config.claude_subtitle', 'Recommended settings per tier for the Claude models on this server, and a safety net for empty answers.')}
            actions={(
                <button
                    type="button"
                    onClick={() => { void onApplyAll(); }}
                    disabled={applicableTiers.length === 0}
                    title={applicableTiers.length === 0 ? t('ai_model_setup.claude_rec_none_available', 'None of the recommended models is offered by a provider on this server.') : undefined}
                    className={`${QUIET_BUTTON} disabled:cursor-not-allowed`}
                >
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
                                    const available = !!applicable[tierKey];
                                    return (
                                        <tr key={tierKey}
                                            className={`[border-top:1px_solid_var(--border-default)] [transition:background_300ms_ease] [color:var(--text-primary)] ${flash ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)]' : '[background:transparent]'}`}
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
                                                {available ? recNote(t, tierKey) : t('ai_model_setup.claude_rec_unavailable', 'This model is not offered on this server.')}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                <button
                                                    type="button"
                                                    onClick={() => applyClaudeRecommendedForTier(tierKey, chatModels)}
                                                    disabled={!available}
                                                    className={`${QUIET_BUTTON} disabled:cursor-not-allowed`}
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
            {confirmDialog}
        </SettingsGroup>
    );
}
