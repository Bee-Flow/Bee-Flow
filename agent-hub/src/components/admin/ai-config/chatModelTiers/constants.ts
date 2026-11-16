// Tier registry, per-tier defaults and the Bee Flow recommended Claude
// defaults for the chat-model-tier admin panel. Moved verbatim from
// ChatModelTiersConfig.jsx; only the `export` keywords are new.
import beeFlowIcon from '@/assets/BeeFlow-logo-Icon-2026.svg';

export interface TierDef {
    key: string;
    icon: string;
    iconSrc?: string;
    label: string;
    desc: string;
}

export interface TierDefaults {
    maxTokens: number;
    temperature: number;
    verbosity: string;
}

/** The Claude model families a recommendation can name. */
export type ClaudeFamily = 'haiku' | 'sonnet' | 'opus';

export interface ClaudeRecommendation {
    /** Resolved to the newest model of this family the catalogue offers (claudeRecommendations.ts). */
    family: ClaudeFamily;
    maxTokens: number;
    temperature: number;
    reasoningEffort: string | undefined;
    reasoningSummary: boolean;
    budgetTokens: number | undefined;
    /** English fallback of ai_model_setup.claude_rec_note_<tier>. */
    note: string;
}

export const TIERS: TierDef[] = [
    { key: 'fast', icon: '⚡', label: 'Fast', desc: 'Quick responses for simple questions' },
    { key: 'standard', icon: '🐝', iconSrc: beeFlowIcon, label: 'Flow (Direct)', desc: 'Direct chat tier with per-chat orchestrated stages' },
    { key: 'swarm', icon: '🐝🐝', iconSrc: beeFlowIcon, label: 'Swarm (Direct)', desc: 'Direct chat tier that runs a multi-agent swarm (Deep Research) and synthesises one answer' },
    { key: 'thinking', icon: '🧠', label: 'Thinking', desc: 'Complex reasoning and analysis' },
    { key: 'writer', icon: '✍️', label: 'Writer', desc: 'Long-form content and reports' },
    { key: 'pro', icon: '✨', label: 'Deep Thinking', desc: 'Maximum quality output' }
];

// Must match TIER_DEFAULTS in server/core/llm/modelResolver.js (what the server
// falls back to when a field is empty), so the admin UI shows the real value.
// `pro` (Deep Thinking) falls back to the server's `pro` row, not `deep_thinking`.
export const TIER_DEFAULTS: Record<string, TierDefaults> = {
    fast: { maxTokens: 4096, temperature: 0.2, verbosity: 'low' },
    standard: { maxTokens: 16384, temperature: 0.5, verbosity: 'medium' },
    swarm: { maxTokens: 16384, temperature: 0.5, verbosity: 'medium' },
    thinking: { maxTokens: 32768, temperature: 0.7, verbosity: 'medium' },
    writer: { maxTokens: 32768, temperature: 0.7, verbosity: 'high' },
    pro: { maxTokens: 32768, temperature: 0.7, verbosity: 'high' },
};

// Custom tier defaults when creating a new one
export const CUSTOM_TIER_DEFAULTS = { maxTokens: 32768, temperature: 0.7 };

// ── Bee Flow recommended Claude defaults per tier ────────────────────
// Applied by the "Claude models" section's Apply buttons. A recommendation
// names a family; the model is the newest of that family the configured
// catalogue offers (claudeRecommendations.ts), so a new release needs no edit
// here and a tier whose family this server lacks cannot be applied. Values from
// the provider's docs (64K/128K max output, adaptive thinking: Effort sets the
// depth, no manual budget).
export const CLAUDE_RECOMMENDED: Record<string, ClaudeRecommendation> = {
    fast: {
        family: 'haiku',
        maxTokens: 4096, temperature: 0.2,
        reasoningEffort: undefined, reasoningSummary: false, budgetTokens: undefined,
        note: 'The small, quick model: it does not think, so effort stays off.',
    },
    standard: {
        family: 'sonnet',
        maxTokens: 16384, temperature: 0.5,
        reasoningEffort: 'low', reasoningSummary: false, budgetTokens: undefined,
        note: 'Flow: multi-stage workflow with light adaptive thinking.',
    },
    swarm: {
        family: 'sonnet',
        maxTokens: 16384, temperature: 0.5,
        reasoningEffort: 'low', reasoningSummary: false, budgetTokens: undefined,
        note: 'Per-agent depth handled by the swarm runtime.',
    },
    thinking: {
        family: 'sonnet',
        maxTokens: 32768, temperature: 1,
        reasoningEffort: 'medium', reasoningSummary: true, budgetTokens: undefined,
        note: 'Medium effort: Effort sets how deep the model thinks.',
    },
    writer: {
        family: 'sonnet',
        maxTokens: 32768, temperature: 0.7,
        reasoningEffort: 'low', reasoningSummary: false, budgetTokens: undefined,
        note: 'Long-form prose with light adaptive thinking.',
    },
    pro: {
        family: 'opus',
        maxTokens: 64000, temperature: 0.7,
        reasoningEffort: 'high', reasoningSummary: true, budgetTokens: undefined,
        note: 'The strongest model at high effort, for the hardest questions.',
    },
};

export const CLAUDE_REC_TIER_ORDER = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

export const TASK_TYPES = [
    { key: 'direct_chat', label: 'Direct Chat' },
    { key: 'agent_chat', label: 'Agent Chat' },
];

// Convert a free-form label into a stable custom tier id (slug, namespaced).
export const slugifyTierLabel = (label: string | null | undefined) => {
    const slug = String(label || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return slug ? `custom:${slug}` : '';
};
