/**
 * Minimal, self-contained copy of the host's tier metadata.
 *
 * Trimmed vs the host original: no imported SVG logo (`iconSrc`) and no emoji /
 * AppEmoji fallback path — every tier here resolves to a lucide icon, which the
 * module already bundles. Keeps the model picker fully self-contained.
 */
import { Zap, Brain, Workflow, Users, PenLine, Lightbulb, Shuffle, Sparkles } from 'lucide-react';

export const TIER_META = {
    auto:          { Icon: Shuffle,   label: 'Auto',          desc: 'Optimal choice' },
    fast:          { Icon: Zap,       label: 'Fast',          desc: 'Quick answers' },
    standard:      { Icon: Workflow,  label: 'Flow',          desc: 'Multi-stage orchestration', beta: true },
    swarm:         { Icon: Users,     label: 'Swarm',         desc: 'Parallel agents, synthesised answer', beta: true },
    thinking:      { Icon: Brain,     label: 'Think',         desc: 'Complex problems' },
    writer:        { Icon: PenLine,   label: 'Write',         desc: 'Long-form content' },
    deep_thinking: { Icon: Lightbulb, label: 'Deep Thinking', desc: 'Advanced reasoning' },
    pro:           { Icon: Lightbulb, label: 'Deep Thinking', desc: 'Advanced reasoning' },
};

export function customTierMeta(key, cfg) {
    return {
        Icon: Sparkles,
        label: cfg?.label || key.replace(/^custom:/, ''),
        desc: cfg?.description || 'Custom tier',
    };
}

const STANDARD_TIER_ORDER = ['auto', 'fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

/** Ordered, configured-only tier keys given the server's `tiers` payload. */
export function configuredTierKeys(tiers = {}) {
    const customKeys = Object.keys(tiers).filter((k) => k.startsWith('custom:'));
    return [...STANDARD_TIER_ORDER, ...customKeys].filter((key) => {
        const cfg = tiers[key] || {};
        const hasMeta = !!TIER_META[key] || key.startsWith('custom:');
        if (!hasMeta) return false;
        return key === 'auto' || key.startsWith('custom:') || !!cfg.modelId;
    });
}

/** Resolve a tier key to its display label. */
export function tierLabel(tierKey, tiers = {}) {
    if (!tierKey) return '';
    if (TIER_META[tierKey]) return TIER_META[tierKey].label;
    if (tierKey.startsWith('custom:')) return customTierMeta(tierKey, tiers[tierKey]).label;
    return tierKey.charAt(0).toUpperCase() + tierKey.slice(1);
}
