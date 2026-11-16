import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { Dispatch, SetStateAction } from 'react';
import { CLAUDE_RECOMMENDED, type ClaudeRecommendation } from './constants';
import { applicableRecommendations, recommendedModelId } from './claudeRecommendations';
import type { CatalogModel, StatusMessage, TierConfig, TierSettings } from './tierTypes';
import { flash } from './tierTypes';

/** Which tier table a recommendation lands in: the regular tiers or the EU ones. */
type TierTable = 'regular' | 'eu';

export interface ClaudeSettingsState {
    claudeMessage: StatusMessage | null;
    /** The tier row that just took the recommended values (flashes for 1.5s). */
    claudeRecAppliedTier: string | null;
    /**
     * Lay the recommendation over one tier of `table` (regular by default). The
     * model is the newest of the recommendation's family in `models`; nothing
     * happens when this server offers none.
     */
    applyClaudeRecommendedForTier: (tierKey: string, models: readonly CatalogModel[], table?: TierTable) => void;
    /**
     * Lay the recommendations over every regular tier whose family is in
     * `models`; the other tiers keep what they have. Returns how many tiers changed.
     */
    applyAllClaudeRecommended: (models: readonly CatalogModel[]) => number;
}

interface TierSetters {
    setConfig: Dispatch<SetStateAction<TierConfig>>;
    setEuConfig: Dispatch<SetStateAction<TierConfig>>;
}

/** A tier's settings with the recommended Claude values laid over them. */
function withRecommended(current: TierSettings | undefined, rec: ClaudeRecommendation, modelId: string): TierSettings {
    return {
        ...(current || {}),
        modelId,
        maxTokens: rec.maxTokens,
        temperature: rec.temperature,
        reasoningEffort: rec.reasoningEffort,
        reasoningSummary: rec.reasoningSummary,
        budgetTokens: rec.budgetTokens,
    };
}

/**
 * The recommended per-tier Claude defaults. Applying one only changes the
 * page's draft: the admin still saves the page, which keeps it reviewable.
 * The EU tiers get their own target, so an Apply on an EU tier never rewrites
 * the regular one.
 */
export default function useClaudeSettings({ setConfig, setEuConfig }: TierSetters): ClaudeSettingsState {
    const { t } = useTranslation();
    const [claudeMessage, setClaudeMessage] = useState<StatusMessage | null>(null);
    const [claudeRecAppliedTier, setClaudeRecAppliedTier] = useState<string | null>(null);

    // Flashing the row provides feedback.
    const applyClaudeRecommendedForTier = (tierKey: string, models: readonly CatalogModel[], table: TierTable = 'regular') => {
        const rec = Object.hasOwn(CLAUDE_RECOMMENDED, tierKey) ? CLAUDE_RECOMMENDED[tierKey] : undefined;
        const modelId = recommendedModelId(tierKey, models);
        if (!rec || !modelId) return;
        const set = table === 'eu' ? setEuConfig : setConfig;
        set(prev => ({ ...prev, [tierKey]: withRecommended(prev[tierKey], rec, modelId) }));
        if (table === 'eu') return;
        setClaudeRecAppliedTier(tierKey);
        setTimeout(() => setClaudeRecAppliedTier(curr => curr === tierKey ? null : curr), 1500);
    };

    const applyAllClaudeRecommended = (models: readonly CatalogModel[]) => {
        const applicable = Object.entries(applicableRecommendations(models));
        if (applicable.length === 0) return 0;
        // Functional update: the caller confirms first, so the config this
        // render saw may be stale by the time the admin clicks (a load landed).
        setConfig((prev) => {
            const next = { ...prev };
            for (const [tierKey, modelId] of applicable) {
                next[tierKey] = withRecommended(next[tierKey], CLAUDE_RECOMMENDED[tierKey], modelId);
            }
            return next;
        });
        const text = applicable.length === 1
            ? t('ai_model_setup.claude_applied_one', 'Recommended settings applied to 1 tier. Save the page to keep them.')
            : t('ai_model_setup.claude_applied_some', 'Recommended settings applied to {n} tiers. Save the page to keep them.', { n: applicable.length });
        flash(setClaudeMessage, { type: 'success', text }, 5000);
        return applicable.length;
    };

    return { claudeMessage, claudeRecAppliedTier, applyClaudeRecommendedForTier, applyAllClaudeRecommended };
}
