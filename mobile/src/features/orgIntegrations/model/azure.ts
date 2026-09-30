/**
 * The web Azure panel's constants and rules (integrations/azure/constants.js,
 * pinned by azure.lockstep.test.ts): its sections, the four chat tiers and
 * their defaults, which models reason, and the group-sync schedule words.
 */

import { parseDecimal } from '@/shared/lib/decimal';
import type { IconName } from '@/shared/ui';

import type { AzureConfig, AzureSectionId, AzureTier } from './azureTypes';

export interface AzureSection {
    id: AzureSectionId;
    labelKey: string;
    descKey: string;
    /** The keys' English: [label, description]. */
    english: [string, string];
    icon: IconName;
    color: string;
    href: string;
}

/** SUB_SECTIONS, in its order; `href` is where each opens on the phone. */
export const AZURE_SECTIONS: readonly AzureSection[] = [
    { id: 'openai', labelKey: 'azure.openai_label', descKey: 'azure.openai_desc', english: ['Azure OpenAI', 'Endpoint, API key & model deployments'], icon: 'Cloud', color: '#0078D4', href: '/org/azure/openai' },
    { id: 'chatModels', labelKey: 'azure.chat_tiers_label', descKey: 'azure.chat_tiers_desc', english: ['Chat Model Tiers', 'Assign a model to each tier for Direct Chat'], icon: 'Layers', color: '#5B5FC7', href: '/org/azure/models' },
    { id: 'docProcessing', labelKey: 'azure.doc_processing_label', descKey: 'azure.doc_processing_desc', english: ['Document Processing', 'Azure Document Intelligence & embeddings'], icon: 'FileText', color: '#0078D4', href: '/org/azure/documents' },
    { id: 'sso', labelKey: 'azure.sso_label', descKey: 'azure.sso_desc', english: ['Microsoft SSO', 'Azure AD credentials & user approval'], icon: 'Shield', color: '#00a4ef', href: '/org/azure/sso' },
];

export type TierKey = 'fast' | 'thinking' | 'writer' | 'pro';

/** TIERS: the four the panel shows (the stored map may hold more; a save keeps them). */
export const AZURE_TIERS: readonly { key: TierKey; icon: string; labelKey: string; descKey: string; english: [string, string] }[] = [
    { key: 'fast', icon: '⚡', labelKey: 'azure.tier_fast', descKey: 'azure.tier_fast_desc', english: ['Fast', 'Quick responses for simple questions'] },
    { key: 'thinking', icon: '🧠', labelKey: 'azure.tier_thinking', descKey: 'azure.tier_thinking_desc', english: ['Thinking', 'Complex reasoning and analysis'] },
    { key: 'writer', icon: '✍️', labelKey: 'azure.tier_writer', descKey: 'azure.tier_writer_desc', english: ['Writer', 'Long-form content and reports'] },
    { key: 'pro', icon: '✨', labelKey: 'azure.tier_pro', descKey: 'azure.tier_pro_desc', english: ['Deep Thinking', 'Maximum quality output'] },
];

/** TIER_DEFAULTS. */
export const TIER_DEFAULTS: Readonly<Record<TierKey, { maxTokens: number; temperature: number }>> = {
    fast: { maxTokens: 8192, temperature: 0.7 },
    thinking: { maxTokens: 40960, temperature: 0.7 },
    writer: { maxTokens: 16384, temperature: 0.7 },
    pro: { maxTokens: 40960, temperature: 0.7 },
};

/** A tier's temperature bounds: the web field's min and max (ChatModelsSection.jsx). */
export const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;

/**
 * A typed temperature, with a dot or a decimal comma: the number within
 * TEMPERATURE_RANGE, null for an empty field (the tier's default), or
 * undefined while the text is not a number yet ("-"), which keeps the stored one.
 */
export function temperatureFromText(text: string): number | null | undefined {
    if (text.trim() === '') return null;
    const typed = parseDecimal(text);
    if (typed === null) return undefined;
    return Math.min(TEMPERATURE_RANGE.max, Math.max(TEMPERATURE_RANGE.min, typed));
}

/** The panel's own tier labels, sent with an empty tier (orgAzureConfig.js PANEL_TIERS). */
export const PANEL_TIER_LABELS: Readonly<Record<TierKey, string>> = {
    fast: 'Fast',
    thinking: 'Thinking',
    writer: 'Writer',
    pro: 'Deep Thinking',
};

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

/** isReasoningCapable. */
export function isReasoningCapable(modelId: string | null | undefined): boolean {
    if (!modelId) return false;
    return /^o\d/.test(modelId) || /^gpt-5/.test(modelId) || /^claude-(opus|sonnet|haiku)-4/.test(modelId);
}

/** isClaudeReasoning: adaptive thinking, no summary switch. */
export function isClaudeReasoning(modelId: string | null | undefined): boolean {
    return Boolean(modelId) && /^claude-(opus|sonnet|haiku)-4/.test(modelId as string);
}

/** The deployment names the tiers pick from (ChatModelsSection's fallback list; the web's /ai/models is gone). */
export function deployedModels(azureModels: string): string[] {
    return azureModels
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
}

/** An empty tier, as the server fills one in. */
export function blankTier(key: TierKey): AzureTier {
    const label = PANEL_TIER_LABELS[key];
    return { modelId: '', label, maxTokens: null, temperature: null, reasoningEffort: null, reasoningSummary: false, raw: { modelId: '', label } };
}

/** The chatModels save: only the panel's four tiers, each with its untouched fields. */
export function tiersBody(tiers: Record<string, AzureTier>): Record<TierKey, Record<string, unknown>> {
    const out = {} as Record<TierKey, Record<string, unknown>>;
    for (const { key } of AZURE_TIERS) {
        const { raw, maxTokens, temperature, reasoningEffort, reasoningSummary, ...tier } = tiers[key] ?? blankTier(key);
        out[key] = {
            ...raw,
            ...tier,
            ...(maxTokens !== null ? { maxTokens } : {}),
            ...(temperature !== null ? { temperature } : {}),
            ...(reasoningEffort !== null ? { reasoningEffort } : {}),
            // Sent once it is on, or once it was stored: switching it off must overwrite a stored true.
            ...(reasoningSummary || 'reasoningSummary' in raw ? { reasoningSummary } : {}),
        };
    }
    return out;
}

/** A tier as its sheet's fields show it: text values, with the tier's defaults beside them. */
export function tierFields(key: TierKey | null, tier: AzureTier | null) {
    const defaults = key ? TIER_DEFAULTS[key] : TIER_DEFAULTS.fast;
    return {
        modelId: tier?.modelId ?? '',
        maxTokens: tier?.maxTokens == null ? '' : String(tier.maxTokens),
        temperature: tier?.temperature == null ? '' : String(tier.temperature),
        defaults,
    };
}

/** The hub's status chip per section, as the web's list shows it; null for none. */
export function sectionStatus(id: AzureSectionId, c: AzureConfig): 'configured' | 'partial' | 'missing' | number | null {
    if (id === 'openai') {
        if (!c.azureEndpoint && !c.hasAzureApiKey) return null;
        return c.azureEndpoint && c.hasAzureApiKey ? 'configured' : 'partial';
    }
    if (id === 'chatModels') {
        const set = AZURE_TIERS.filter(({ key }) => c.chatModelTiers[key]?.modelId).length;
        return set > 0 ? set : null;
    }
    if (id === 'sso') return ssoConfigured(c) ? 'configured' : 'missing';
    return c.hasAzureDocEndpoint && c.hasAzureDocKey ? 'configured' : null;
}

export function ssoConfigured(c: Pick<AzureConfig, 'ssoClientId' | 'hasSsoClientSecret'>): boolean {
    return Boolean(c.ssoClientId && c.hasSsoClientSecret);
}

/** The interval choices of the periodic group sync (SSOSection.jsx), in hours. */
export const SYNC_INTERVALS: readonly number[] = [1, 3, 6, 12, 24, 48, 168];

/**
 * When the periodic group sync runs next (SSOSection.jsx): overdue, within a
 * minute, or in `text` — the time left as the web writes it ("45m", "2h",
 * "5h 30m").
 */
export function nextSync(
    lastSyncAt: string | null,
    intervalHours: number,
    now = Date.now(),
): { kind: 'overdue' | 'imminent' | 'in'; text: string } | null {
    const last = lastSyncAt ? Date.parse(lastSyncAt) : Number.NaN;
    if (Number.isNaN(last)) return null;
    const diffMs = last + intervalHours * 3_600_000 - now;
    if (diffMs < 0) return { kind: 'overdue', text: '' };
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return { kind: 'imminent', text: '' };
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 1) return { kind: 'in', text: `${minutes}m` };
    return { kind: 'in', text: rest > 0 ? `${hours}h ${rest}m` : `${hours}h` };
}

/** The tenant check the server makes (TENANT_ALIASES and GUID in orgAzureConfig.js). */
export function validTenant(value: string): boolean {
    const v = value.trim();
    return (
        v === '' ||
        ['common', 'organizations', 'consumers'].includes(v.toLowerCase()) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    );
}

/** The endpoint check the server makes: an http(s) address, or empty to clear it. */
export function validEndpoint(value: string): boolean {
    const v = value.trim();
    return v === '' || /^https?:\/\/\S+$/i.test(v);
}
