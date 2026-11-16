// "Claude models" section of the Models page: the recommended Claude settings
// per tier. The panel renders it only when a Claude model is configured
// (hasClaudeModels). Each row names the newest model of its family this server
// offers (claudeRecommendations.ts); a row whose family the server lacks cannot
// be applied. Applying changes the page's draft only.
import type { ClaudeSettingsState } from './useClaudeSettings';
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER, TIERS } from './constants';
import { applicableRecommendations } from './claudeRecommendations';
import { getModelMeta } from './modelMeta';
import type { CatalogModel } from './tierTypes';
import { QUIET_BUTTON, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useToastOnMessage } from '../ui/useToastOnMessage';
import useConfirm from '@/components/shared/useConfirm';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

type ClaudeSettingsSectionProps = Pick<ClaudeSettingsState,
    'claudeMessage' | 'claudeRecAppliedTier' | 'applyClaudeRecommendedForTier' | 'applyAllClaudeRecommended'> & {
    /** The configured chat models: a recommendation applies only when its family is among them. */
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

const HEAD = 'px-3 py-2 font-semibold uppercase tracking-wider';

function RecTableHead({ t }: { t: TranslateFn }) {
    return (
        <thead>
            <tr className="bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">
                <th className={`text-left ${HEAD}`}>{t('admin_ai_config.claude_col_tier', 'Tier')}</th>
                <th className={`text-left ${HEAD}`}>{t('admin_ai_config.claude_col_model', 'Model')}</th>
                <th className={`text-right ${HEAD}`}>{t('admin_ai_config.claude_col_max', 'Max tokens')}</th>
                <th className={`text-left ${HEAD}`}>{t('admin_ai_config.claude_col_effort', 'Effort')}</th>
                <th className={`text-right ${HEAD}`}>{t('admin_ai_config.claude_col_budget', 'Budget')}</th>
                <th className={`text-left ${HEAD}`}>{t('admin_ai_config.claude_col_notes', 'Notes')}</th>
                <th className="px-3 py-2"></th>
            </tr>
        </thead>
    );
}

interface RecRowProps {
    t: TranslateFn;
    tierKey: string;
    /** The catalogue id this row would set; null when the server offers no model of its family. */
    modelId: string | null;
    flash: boolean;
    onApply: () => void;
}

function RecRow({ t, tierKey, modelId, flash, onApply }: RecRowProps) {
    const rec = CLAUDE_RECOMMENDED[tierKey];
    const tier = TIERS.find(x => x.key === tierKey);
    const muted = <span className="text-[var(--text-tertiary)]">—</span>;
    return (
        <tr className={`border-t border-[var(--border-default)] text-[var(--text-primary)] transition-colors duration-300 ${flash ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)]' : ''}`}>
            <td className="px-3 py-2"><span className="font-medium">{tier?.label || tierKey}</span></td>
            <td className="px-3 py-2 font-mono text-[11px] text-[var(--text-tertiary)]">{modelId ? (getModelMeta(modelId)?.name || modelId) : '—'}</td>
            <td className="px-3 py-2 text-right tabular-nums">{rec.maxTokens.toLocaleString()}</td>
            <td className="px-3 py-2">{rec.reasoningEffort || muted}</td>
            <td className="px-3 py-2 text-right tabular-nums">
                {rec.budgetTokens
                    ? rec.budgetTokens.toLocaleString()
                    : <span className="text-[var(--text-tertiary)]">{t('admin_ai_config.claude_adaptive', 'adaptive')}</span>}
            </td>
            <td className="px-3 py-2 text-[var(--text-tertiary)]">
                {modelId ? recNote(t, tierKey) : t('ai_model_setup.claude_rec_unavailable', 'This server offers no model of this kind.')}
            </td>
            <td className="px-3 py-2 text-right">
                <button type="button" onClick={onApply} disabled={!modelId} className={`${QUIET_BUTTON} disabled:cursor-not-allowed`}>
                    {t('admin_ai_config.claude_apply', 'Apply')}
                </button>
            </td>
        </tr>
    );
}

export default function ClaudeSettingsSection({
    claudeMessage, claudeRecAppliedTier, applyClaudeRecommendedForTier, applyAllClaudeRecommended, chatModels,
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
            ? t('ai_model_setup.claude_apply_all_confirm_desc_one', 'This replaces the model and settings of 1 tier ({tiers}). Tiers whose recommended model this server does not offer keep what they have. Nothing is stored until you save the page.', { tiers: labels })
            : t('ai_model_setup.claude_apply_all_confirm_desc', 'This replaces the model and settings of {n} tiers ({tiers}). Tiers whose recommended model this server does not offer keep what they have. Nothing is stored until you save the page.', { n: applicableTiers.length, tiers: labels });
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
            description={t('ai_model_setup.claude_recs_subtitle', 'Recommended settings per tier for the Claude models on this server: the newest model of each kind it offers.')}
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
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <RecTableHead t={t} />
                        <tbody>
                            {CLAUDE_REC_TIER_ORDER.map(tierKey => (
                                <RecRow
                                    key={tierKey}
                                    t={t}
                                    tierKey={tierKey}
                                    modelId={applicable[tierKey] ?? null}
                                    flash={claudeRecAppliedTier === tierKey}
                                    onApply={() => applyClaudeRecommendedForTier(tierKey, chatModels)}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
                <p className="m-0 px-4 py-2 text-[11px] text-[var(--text-tertiary)]">
                    {t('ai_model_setup.claude_apply_hint', 'Apply fills in the tier above. Nothing is stored until you save the page.')}
                </p>
            </SettingsList>
            {confirmDialog}
        </SettingsGroup>
    );
}
