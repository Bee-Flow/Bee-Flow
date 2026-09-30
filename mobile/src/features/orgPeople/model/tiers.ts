/**
 * Model tiers: the four standard ones a group may be limited to, and the
 * organisation's own custom tiers (the web's OrgCustomTiersPanel and the
 * "Allowed tiers" pills in OrgUsersPanel).
 */

import type { TranslateFn } from '@/core/i18n';

import type { CustomTier, CustomTierMeta } from './types';

export interface TierPill {
    id: string;
    label: string;
    icon: string;
    custom: boolean;
}

export function standardTiers(t: TranslateFn): TierPill[] {
    return [
        { id: 'fast', label: t('mobile.orgPeople.tier_fast', 'Fast'), icon: '⚡', custom: false },
        { id: 'thinking', label: t('mobile.orgPeople.tier_thinking', 'Thinking'), icon: '🧠', custom: false },
        { id: 'writer', label: t('mobile.orgPeople.tier_writer', 'Writer'), icon: '✍️', custom: false },
        { id: 'pro', label: t('mobile.orgPeople.tier_pro', 'Deep Thinking'), icon: '✨', custom: false },
    ];
}

/** Standard tiers, then the org's and the platform's custom ones. */
export function tierPills(t: TranslateFn, custom: readonly CustomTierMeta[]): TierPill[] {
    return [
        ...standardTiers(t),
        ...custom.map((c) => ({ id: c.id, label: c.label || c.id, icon: c.icon || '✨', custom: true })),
    ];
}

/**
 * A group's allowed tiers with one toggled. An empty list means "no
 * restriction", so the first tier picked on an unrestricted group restricts
 * it to that one tier — which is what tapping a pill means on the web too.
 */
export function toggleTier(allowed: readonly string[], id: string): string[] {
    return allowed.includes(id) ? allowed.filter((x) => x !== id) : [...allowed, id];
}

/** The web's slugifyTierLabel: `custom:` plus a lower-case, dashed slug. */
export function slugifyTierLabel(label: string): string {
    const slug = String(label || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return slug ? `custom:${slug}` : '';
}

export const TASK_TYPES = ['direct_chat', 'agent_chat'] as const;

export function taskTypeLabel(key: string, t: TranslateFn): string {
    return key === 'agent_chat'
        ? t('mobile.orgPeople.task_agent_chat', 'Agent Chat')
        : t('mobile.orgPeople.task_direct_chat', 'Direct Chat');
}

/** The web's "+ Add Tier" defaults, under the first free placeholder id. */
export function newTier(existing: readonly CustomTier[]): CustomTier {
    let n = existing.length + 1;
    while (existing.some((x) => x.id === `custom:org-tier-${n}`)) n += 1;
    return {
        id: `custom:org-tier-${n}`,
        label: '',
        icon: '✨',
        description: '',
        modelId: '',
        euModelId: '',
        maxTokens: 16384,
        temperature: 0.7,
        allowedTaskTypes: [...TASK_TYPES],
    };
}

/** What the tier sheet edits. */
export interface TierDraft {
    label: string;
    icon: string;
    description: string;
    modelId: string;
    euModelId: string;
    maxTokens: string;
    temperature: number;
    allowedTaskTypes: string[];
}

export function draftOf(tier: CustomTier): TierDraft {
    return {
        label: tier.label,
        icon: tier.icon,
        description: tier.description,
        modelId: tier.modelId,
        euModelId: tier.euModelId,
        maxTokens: String(tier.maxTokens),
        temperature: tier.temperature,
        allowedTaskTypes: [...tier.allowedTaskTypes],
    };
}

export const MAX_TOKENS = { min: 256, max: 131072 } as const;

/** A whole number within the web's input bounds, else null. */
export function parseMaxTokens(text: string): number | null {
    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < MAX_TOKENS.min || n > MAX_TOKENS.max) return null;
    return n;
}

/**
 * The tier the draft describes. Renaming changes the id, as on the web (the id
 * is the label's slug); a label with no usable characters keeps the old id.
 */
export function applyDraft(tier: CustomTier, draft: TierDraft): CustomTier {
    const label = draft.label.trim();
    return {
        ...tier,
        id: slugifyTierLabel(label) || tier.id,
        label,
        icon: draft.icon.trim().slice(0, 4) || '✨',
        description: draft.description.trim(),
        modelId: draft.modelId,
        euModelId: draft.euModelId,
        maxTokens: parseMaxTokens(draft.maxTokens) ?? tier.maxTokens,
        temperature: draft.temperature,
        allowedTaskTypes: TASK_TYPES.filter((k) => draft.allowedTaskTypes.includes(k)),
    };
}

/**
 * The list to POST after saving `next` in place of `previousId` (or appending
 * it). The server de-duplicates by id with the LAST one winning, so a rename
 * onto another tier's id would silently replace that tier: `collides` lets
 * the sheet refuse it first.
 */
export function upsertTier(tiers: readonly CustomTier[], previousId: string | null, next: CustomTier): CustomTier[] {
    if (previousId === null || !tiers.some((x) => x.id === previousId)) return [...tiers, next];
    return tiers.map((x) => (x.id === previousId ? next : x));
}

export function collides(tiers: readonly CustomTier[], previousId: string | null, nextId: string): boolean {
    return tiers.some((x) => x.id === nextId && x.id !== previousId);
}

export function removeTier(tiers: readonly CustomTier[], id: string): CustomTier[] {
    return tiers.filter((x) => x.id !== id);
}
