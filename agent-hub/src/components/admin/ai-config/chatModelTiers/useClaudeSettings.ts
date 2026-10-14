import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { CLAUDE_RECOMMENDED, CLAUDE_REC_TIER_ORDER } from './constants';
import type { StatusMessage, TierConfig, TierSettings } from './tierTypes';
import { flash } from './tierTypes';
import { getAiConfig, postAiConfig } from '../../../../api/aiConfig';

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
    applyClaudeRecommendedForTier: (tierKey: string) => void;
    applyAllClaudeRecommended: () => void;
}

/** A tier's settings with the recommended Claude values laid over them. */
function withRecommended(current: TierSettings | undefined, rec: ClaudeRecommendation): TierSettings {
    return {
        ...(current || {}),
        modelId: rec.modelId,
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
export default function useClaudeSettings(config: TierConfig, setConfig: Dispatch<SetStateAction<TierConfig>>): ClaudeSettingsState {
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
                flash(setClaudeMessage, { type: 'success', text: 'Claude settings saved' }, 3000);
            } else {
                setClaudeMessage({ type: 'error', text: 'Failed to save Claude settings' });
            }
        } catch (e) {
            setClaudeMessage({ type: 'error', text: 'Failed to save Claude settings' });
        }
        setClaudeSaving(false);
    };

    // Flashing the row provides feedback.
    const applyClaudeRecommendedForTier = (tierKey: string) => {
        const rec = RECOMMENDED[tierKey];
        if (!rec) return;
        setConfig(prev => ({ ...prev, [tierKey]: withRecommended(prev[tierKey], rec) }));
        setClaudeRecAppliedTier(tierKey);
        setTimeout(() => setClaudeRecAppliedTier(curr => curr === tierKey ? null : curr), 1500);
    };

    const applyAllClaudeRecommended = () => {
        const next = { ...config };
        for (const tierKey of CLAUDE_REC_TIER_ORDER) {
            const rec = RECOMMENDED[tierKey];
            if (!rec) continue;
            next[tierKey] = withRecommended(next[tierKey], rec);
        }
        setConfig(next);
        flash(setClaudeMessage, { type: 'success', text: 'Recommended Claude defaults applied to all tiers — click Save Tier Configuration to persist.' }, 5000);
    };

    return {
        claudeAutoRetry, setClaudeAutoRetry, claudeSaving, claudeMessage, claudeRecAppliedTier,
        loadClaudeSettings, saveClaudeSettings, applyClaudeRecommendedForTier, applyAllClaudeRecommended,
    };
}
