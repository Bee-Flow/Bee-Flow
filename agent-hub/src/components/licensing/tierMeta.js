import { Sparkles, Zap, Brain, Workflow, Users, PenLine, Lightbulb, Shuffle } from 'lucide-react';
import beeFlowIcon from '../../assets/BeeFlow-logo-Icon-2026.svg';

// Shared metadata for the user-facing tier keys. Used by ModelTierSelector
// (the dropdown) and the chat history badge so both stay in sync when keys
// are renamed or new tiers are added.
//
// Fields:
//   Icon     lucide component, used for the in-app monochrome icon
//   emoji    string fallback for any place that still expects a single char
//   iconSrc  optional image url override (Bee Flow logo for Flow/Swarm)
//   label    human-readable tier name
//   desc     short subtitle shown in the dropdown
//   color    accent var — kept so consumers that draw a tinted dot/ring follow
//            the admin's chosen accent rather than a hard-coded per-tier hue
//
// `pro` is a legacy key that resolves server-side to the deep-thinking model;
// the human label here makes the badge read "Deep Thinking" instead of "Pro".
export const TIER_META = {
    auto:          { Icon: Shuffle,   emoji: '🔀',    label: 'Auto',          desc: 'Optimal choice',                       color: 'var(--accent-primary)' },
    fast:          { Icon: Zap,       emoji: '⚡',    label: 'Fast',          desc: 'Quick answers',                        color: 'var(--accent-primary)' },
    standard:      { Icon: Workflow,  emoji: '🐝',   iconSrc: beeFlowIcon, label: 'Flow',  desc: 'Multi-stage orchestration',            color: 'var(--accent-primary)', beta: true },
    swarm:         { Icon: Users,     emoji: '🐝🐝', iconSrc: beeFlowIcon, label: 'Swarm', desc: 'Parallel agents, synthesised answer',  color: 'var(--accent-primary)', beta: true },
    thinking:      { Icon: Brain,     emoji: '🧠',    label: 'Think',         desc: 'Complex problems',                     color: 'var(--accent-primary)' },
    writer:        { Icon: PenLine,   emoji: '✍️',   label: 'Write',         desc: 'Long-form content',                    color: 'var(--accent-primary)' },
    deep_thinking: { Icon: Lightbulb, emoji: '✨',   label: 'Deep Thinking', desc: 'Advanced reasoning',                   color: 'var(--accent-primary)' },
    pro:           { Icon: Lightbulb, emoji: '✨',   label: 'Deep Thinking', desc: 'Advanced reasoning',                   color: 'var(--accent-primary)' },
};

// Map a tier key to its icon-catalog id. Shared by both tier pickers
// (ModelTierSelector dropdown, TierSlider composer control) so a renamed
// catalog entry can't leave one of them rendering a fallback emoji.
export function tierCatalogId(key) {
    if (!key) return 'tier.fast';
    if (key.startsWith('custom:')) return 'tier.custom';
    return key === 'pro' ? 'tier.deep' : `tier.${key}`;
}

// The tiers that sit on a single "how hard should it think" axis, shallowest
// first. Everything else — Flow, Swarm, Write, custom tiers — is a KIND of
// work, not a depth: putting Write between Think and Deep Thinking on a slider
// would assert a ranking that doesn't exist. The composer slider uses this
// list; the dropdown keeps showing everything.
export const DEPTH_TIER_KEYS = ['auto', 'fast', 'thinking', 'pro', 'deep_thinking'];

export function customTierMeta(key, cfg) {
    return {
        Icon: Sparkles,
        emoji: cfg?.icon || '✨',
        label: cfg?.label || key.replace(/^custom:/, ''),
        desc: cfg?.description || 'Custom tier',
        color: 'var(--accent-primary)',
    };
}

// Canonical ordering of the built-in tiers. Flow=standard, Swarm, Writer, Pro
// etc. only appear when the server includes them (beta gates) AND they're
// configured with a modelId.
const STANDARD_TIER_ORDER = ['auto', 'fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

/**
 * The tier keys that should actually be shown to a user, given the server's
 * `tiers` payload. Mirrors the chat's ModelTierSelector exactly so every tier
 * picker (chat composer, AI-step settings, …) lists the SAME options:
 *   - keep the canonical order, then custom tiers
 *   - `auto` is always valid; custom tiers are pre-filtered server-side
 *   - a standard tier only shows when it has a configured modelId
 */
export function configuredTierKeys(tiers = {}) {
    const customKeys = Object.keys(tiers).filter(k => k.startsWith('custom:'));
    return [...STANDARD_TIER_ORDER, ...customKeys].filter(key => {
        const cfg = tiers[key] || {};
        const hasMeta = !!TIER_META[key] || key.startsWith('custom:');
        if (!hasMeta) return false;
        return key === 'auto' || key.startsWith('custom:') || !!cfg.modelId;
    });
}

// The translation key for a built-in tier's name. `pro` is an ALIAS of
// deep_thinking (same icon, same label), so it SHARES that key: a second key
// with the same text would let a translator move the two apart and the one
// tier would answer in two different words.
export function tierI18nKey(tierKey) {
    return tierKey === 'pro' ? 'tier.deep_thinking' : `tier.${tierKey}`;
}

// Resolve a tier key to its display label. Falls back to a Capitalised raw key
// if the tier isn't in TIER_META and isn't a custom tier.
export function tierLabel(tierKey, tiers = {}) {
    if (!tierKey) return '';
    if (TIER_META[tierKey]) return TIER_META[tierKey].label;
    if (tierKey.startsWith('custom:')) return customTierMeta(tierKey, tiers[tierKey]).label;
    return tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
}
