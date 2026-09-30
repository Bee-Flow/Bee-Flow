/**
 * The editor's choices, as pure functions: which models, apps and knowledge
 * bases it offers, and how it names them. Unit-tested in editorOptions.test.ts.
 */

import type { TranslateFn } from '@/core/i18n';

/** Tools the platform always provides, whatever the org allows (web: integrationAvailability.js). */
export const ALWAYS_AVAILABLE: ReadonlySet<string> = new Set(['agent-search']);

type TierInfo = { label?: string };

/** A tier's name in the web's words (agent-hub tierMeta.js). */
export function tierName(t: TranslateFn, key: string, info?: TierInfo): string {
    switch (key) {
        case 'auto': return t('tier.auto', 'Auto');
        case 'fast': return t('tier.fast', 'Fast');
        case 'standard': return t('tier.standard', 'Flow');
        case 'swarm': return t('tier.swarm', 'Swarm');
        case 'thinking': return t('tier.thinking', 'Think');
        case 'writer': return t('tier.writer', 'Write');
        case 'pro':
        case 'deep_thinking': return t('tier.deep_thinking', 'Deep Thinking');
        default: return info?.label || key.replace(/^custom:/, '');
    }
}

export interface ModelOption {
    /** What `agent.model` stores: '' (org default), `tier:<key>` or a raw model id. */
    value: string;
    label: string;
}

/**
 * The org default, then every tier this person may pick. `auto` is left out:
 * "let the platform choose" is what the default already means. A model the
 * list does not carry (a raw id, a tier since withdrawn) stays offered so
 * opening the editor never silently changes it.
 */
export function modelOptions(t: TranslateFn, tiers: Record<string, TierInfo> | undefined, current: string): ModelOption[] {
    const options: ModelOption[] = [
        { value: '', label: t('mobile.agents.editor.model_default', 'Your organisation’s default') },
    ];
    for (const [key, info] of Object.entries(tiers ?? {})) {
        if (key === 'auto') continue;
        options.push({ value: `tier:${key}`, label: tierName(t, key, info) });
    }
    if (current && !options.some((o) => o.value === current)) {
        const key = current.startsWith('tier:') ? current.slice('tier:'.length) : null;
        options.push({ value: current, label: key ? tierName(t, key) : current });
    }
    return options;
}

export function modelLabel(t: TranslateFn, options: readonly ModelOption[], value: string): string {
    return options.find((o) => o.value === value)?.label ?? value;
}

/** The tier keys a refine may switch to (the web's configuredTierKeys). */
export function selectableTierKeys(tiers: Record<string, TierInfo> | undefined): string[] {
    return Object.keys(tiers ?? {}).filter((k) => k !== 'auto');
}

/**
 * The apps an agent may be given. While the org's allow-list is unknown only
 * the built-ins are offered: a grant the org does not allow is one the
 * runtime refuses, and offering it would read as the save being broken.
 */
export function availableAgentApps<T extends { id: string }>(
    catalog: readonly T[],
    orgEnabled: readonly string[] | null | undefined,
    known: boolean,
): T[] {
    if (!known) return catalog.filter((a) => ALWAYS_AVAILABLE.has(a.id));
    return catalog.filter((a) => ALWAYS_AVAILABLE.has(a.id) || !orgEnabled || orgEnabled.includes(a.id));
}

/**
 * Knowledge bases an agent may link — the server's `?context=agent` filter
 * (server/routes/knowledgeBases/shared.js): a base that never said where it
 * may be used counts everywhere.
 */
export function agentKnowledgeBases<T extends { usage_contexts?: string[] }>(bases: readonly T[]): T[] {
    return bases.filter((kb) => !kb.usage_contexts || kb.usage_contexts.includes('agent'));
}

/** Who may use the agent, in the web's publish menu words. */
export function audienceLabel(t: TranslateFn, isPublished: boolean, sharedGroups: readonly string[]): string {
    if (!isPublished) return t('agent_wizard.publish.personal', 'Personal');
    if (sharedGroups.length > 0) return t('agent_wizard.publishing.groups', 'Visible to groups');
    return t('agent_wizard.publish.entire_org', 'Entire Organisation');
}
