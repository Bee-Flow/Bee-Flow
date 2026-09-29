// Tier registry, per-tier defaults and the Bee Flow recommended Claude
// defaults for the chat-model-tier admin panel. Moved verbatim from
// ChatModelTiersConfig.jsx; only the `export` keywords are new.
import beeFlowIcon from '../../../../assets/BeeFlow-logo-Icon-2026.svg';

export const TIERS = [
    { key: 'fast', icon: '⚡', label: 'Fast', desc: 'Quick responses for simple questions' },
    { key: 'standard', icon: '🐝', iconSrc: beeFlowIcon, label: 'Flow (Direct)', desc: 'Direct chat tier with per-chat orchestrated stages' },
    { key: 'swarm', icon: '🐝🐝', iconSrc: beeFlowIcon, label: 'Swarm (Direct)', desc: 'Direct chat tier that runs a multi-agent swarm (Deep Research) and synthesises one answer' },
    { key: 'thinking', icon: '🧠', label: 'Thinking', desc: 'Complex reasoning and analysis' },
    { key: 'writer', icon: '✍️', label: 'Writer', desc: 'Long-form content and reports' },
    { key: 'pro', icon: '✨', label: 'Deep Thinking', desc: 'Maximum quality output' }
];

// Must match the server-side TIER_DEFAULTS in server/core/modelResolver.js —
// keep these two tables in sync so the admin UI shows the real fallback.
export const TIER_DEFAULTS = {
    fast: { maxTokens: 4096, temperature: 0.2, verbosity: 'low' },
    standard: { maxTokens: 16384, temperature: 0.5, verbosity: 'medium' },
    thinking: { maxTokens: 32768, temperature: 0.7, verbosity: 'medium' },
    writer: { maxTokens: 32768, temperature: 0.7, verbosity: 'high' },
    pro: { maxTokens: 64000, temperature: 0.7, verbosity: 'high' },
};

// Custom tier defaults when creating a new one
export const CUSTOM_TIER_DEFAULTS = { maxTokens: 32768, temperature: 0.7 };

// ── Bee Flow recommended Claude defaults per tier ────────────────────
// Applied by the "Claude Settings" panel's Apply buttons. Values picked
// from Anthropic docs (Sonnet 64K / Opus 128K max output, Haiku no
// adaptive thinking, Opus 4.7 adaptive-only with no manual budget).
export const CLAUDE_RECOMMENDED = {
    fast: {
        modelId: 'claude-haiku-4-5',
        maxTokens: 4096, temperature: 0.2,
        reasoningEffort: undefined, reasoningSummary: false, budgetTokens: undefined,
        note: 'Haiku 4.5 has no adaptive thinking — effort stays off.',
    },
    standard: {
        modelId: 'claude-sonnet-4-6',
        maxTokens: 16384, temperature: 0.5,
        reasoningEffort: 'low', reasoningSummary: false, budgetTokens: undefined,
        note: 'Flow: multi-stage workflow with light adaptive thinking.',
    },
    swarm: {
        modelId: 'claude-sonnet-4-6',
        maxTokens: 16384, temperature: 0.5,
        reasoningEffort: 'low', reasoningSummary: false, budgetTokens: undefined,
        note: 'Per-agent depth handled by the swarm runtime.',
    },
    thinking: {
        modelId: 'claude-sonnet-5',
        maxTokens: 32768, temperature: 1,
        reasoningEffort: 'medium', reasoningSummary: true, budgetTokens: undefined,
        note: 'Sonnet 5 adaptive-only — Effort controls thinking depth (no manual budget).',
    },
    writer: {
        modelId: 'claude-sonnet-4-6',
        maxTokens: 32768, temperature: 0.7,
        reasoningEffort: 'low', reasoningSummary: false, budgetTokens: undefined,
        note: 'Long-form prose with light adaptive thinking.',
    },
    pro: {
        modelId: 'claude-opus-4-7',
        maxTokens: 64000, temperature: 0.7,
        reasoningEffort: 'high', reasoningSummary: true, budgetTokens: undefined,
        note: 'Opus 4.7 adaptive-only — effort controls thinking budget internally.',
    },
};

export const CLAUDE_REC_TIER_ORDER = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

export const TASK_TYPES = [
    { key: 'direct_chat', label: 'Direct Chat' },
    { key: 'agent_chat', label: 'Agent Chat' },
];

// Convert a free-form label into a stable custom tier id (slug, namespaced).
export const slugifyTierLabel = (label) => {
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
