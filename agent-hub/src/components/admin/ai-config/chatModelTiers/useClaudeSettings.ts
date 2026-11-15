import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { Dispatch, SetStateAction } from 'react';
import { CLAUDE_RECOMMENDED } from './constants';
import { applicableRecommendations, resolveRecommendedModelId } from './claudeRecommendations';
import type { CatalogModel, StatusMessage, TierConfig, TierSettings } from './tierTypes';
import { flash } from './tierTypes';
import { getAiConfig, postAiConfig } from '@/api/aiConfig';

interface ClaudeRecommendation {
    modelId: string;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: string;
    reasoningSummary?: boolean | string;
    budgetTokens?: number;
}

const RECOMMENDED = CLAUDE_RECOMMENDED as Record<string, ClaudeRecommendation | undefined>;

export interface ClaudeSettingsState {
    claudeAutoRetry: boolean;
    setClaudeAutoRetry: Dispatch<SetStateAction<boolean>>;
    claudeSaving: boolean;
    claudeMessage: StatusMessage | null;
    /** The tier row that just took the recommended values (flashes for 1.5s). */
    claudeRecAppliedTier: string | null;
    loadClaudeSettings: () => Promise<void>;
    saveClaudeSettings: (next?: boolean) => Promise<void>;
    /**
     * Lay the recommendation over one tier. With `models` (the configured
     * catalogue) the recommended model is resolved against it, and nothing
     * happens when this server does not offer it.
     */
    applyClaudeRecommendedForTier: (tierKey: string, models?: readonly CatalogModel[]) => void;
    /**
     * Lay the recommendations over every tier whose recommended model is in
     * `models`; the other tiers keep what they have. Returns how many tiers changed.
     */
    applyAllClaudeRecommended: (models: readonly CatalogModel[]) => number;
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
 * Claude's robustness switch (auto-retry on an empty answer) and the
 * recommended per-tier defaults. Applying a recommendation only patches the
 * local tier config: the admin still has to hit "Save Tier Configuration",
 * which keeps the action reviewable.
 */
export default function useClaudeSettings(_config: TierConfig, setConfig: Dispatch<SetStateAction<TierConfig>>): ClaudeSettingsState {
    const { t } = useTranslation();
    const [claudeAutoRetry, setClaudeAutoRetry] = useState(true);
    const [claudeSaving, setClaudeSaving] = useState(false);
    const [claudeMessage, setClaudeMessage] = useState<StatusMessage | null>(null);
    const [claudeRecAppliedTier, setClaudeRecAppliedTier] = useState<string | null>(null);

    const loadClaudeSettings = async () => {
        try {
            const res = await getAiConfig('claude-settings');
            if (res.ok) {
                const data = await res.json();
                setClaudeAutoRetry(data.autoRetryOnEmpty !== false);
            }
        } catch (e) { console.error('Failed to load Claude settings:', e); }
    };

    const saveClaudeSettings = async (next = claudeAutoRetry) => {
        setClaudeSaving(true);
        try {
            const res = await postAiConfig('claude-settings', { autoRetryOnEmpty: next });
            if (res.ok) {
                flash(setClaudeMessage, { type: 'success', text: t('admin_ai_config.claude_saved', 'Claude settings saved') }, 3000);
            } else {
                setClaudeMessage({ type: 'error', text: t('admin_ai_config.claude_save_failed', 'Failed to save Claude settings') });
            }
        } catch (e) {
            setClaudeMessage({ type: 'error', text: t('admin_ai_config.claude_save_failed', 'Failed to save Claude settings') });
        }
        setClaudeSaving(false);
    };

    // Flashing the row provides feedback.
    const applyClaudeRecommendedForTier = (tierKey: string, models?: readonly CatalogModel[]) => {
        const rec = RECOMMENDED[tierKey];
        if (!rec) return;
        const modelId = models ? resolveRecommendedModelId(rec.modelId, models) : rec.modelId;
        if (!modelId) return;
        setConfig(prev => ({ ...prev, [tierKey]: withRecommended(prev[tierKey], rec, modelId) }));
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
                const rec = RECOMMENDED[tierKey];
                if (rec) next[tierKey] = withRecommended(next[tierKey], rec, modelId);
            }
            return next;
        });
        const text = applicable.length === 1
            ? t('ai_model_setup.claude_applied_one', 'Recommended settings applied to 1 tier. Click Save Tier Configuration to keep them.')
            : t('ai_model_setup.claude_applied_some', 'Recommended settings applied to {n} tiers. Click Save Tier Configuration to keep them.', { n: applicable.length });
        flash(setClaudeMessage, { type: 'success', text }, 5000);
        return applicable.length;
    };

    return {
        claudeAutoRetry, setClaudeAutoRetry, claudeSaving, claudeMessage, claudeRecAppliedTier,
        loadClaudeSettings, saveClaudeSettings, applyClaudeRecommendedForTier, applyAllClaudeRecommended,
    };
}
