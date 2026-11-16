// Shared "AI Translate" toolbar for the admin Languages panel — replaces the
// model-tier <select> + translate <button> cluster (and its result banner)
// that was duplicated three times (GUI strings / system prompts / email
// templates). Pair it with the useAiTranslate hook, which owns the state and
// the submit handler.
//
// The disable guard `translating || missing === 0` lives here so it applies
// uniformly: the email-templates copy previously omitted the `missing === 0`
// half and could fire a no-op translate — using this control fixes that.
//
// The tier options are the server's CONFIGURED chat tiers (configuredTierKeys
// over /ai/config/chat-models), named the way every other tier picker names
// them (tierI18nKey). A tier that has no model is not offered; Auto, Flow and
// Swarm are orchestration modes, not one model, so they are left out too.
// Until the list arrives (or when the server has none) the current tier is the
// only option, and the server falls back to its default model.

import { AlertCircle, Check, Languages, Loader2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useConfigChatModels } from '@/api/queries/configModels';
import type { AiTranslateResult as AiTranslateResultData } from '@/hooks/useAiTranslate';
import { useTranslation } from '@/hooks/useTranslation';
import { configuredTierKeys, tierI18nKey, TIER_META } from '@/components/licensing/tierMeta';
import { ALERT_ERROR, ALERT_SUCCESS, PRIMARY_BTN } from '@/components/shared/adminUi';

/** Orchestration modes and custom tiers: not one translating model. */
const NOT_A_TRANSLATION_TIER = new Set(['auto', 'standard', 'swarm']);

/** The configured tiers a translation can run on, in the canonical order. */
function translationTierKeys(tiers: Record<string, unknown>): string[] {
    return configuredTierKeys(tiers).filter((k: string) => !NOT_A_TRANSLATION_TIER.has(k) && !k.startsWith('custom:'));
}

/** The chat-models answer is the tier map itself, or (older servers) `{ tiers }`. */
function tierMapOf(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object') return {};
    const record = data as Record<string, unknown>;
    const nested = record.tiers;
    return nested && typeof nested === 'object' ? nested as Record<string, unknown> : record;
}

interface AiTranslateControlProps {
    tier: string;
    onTierChange: (tier: string) => void;
    onTranslate: () => void;
    translating: boolean;
    /** Untranslated count; 0 disables the button. */
    missing?: number;
    icon?: ReactNode;
    showCount?: boolean;
    className?: string;
}

export default function AiTranslateControl({
    tier,
    onTierChange,
    onTranslate,
    translating,
    missing,
    icon,
    showCount = true,
    className = 'flex items-center gap-1.5 shrink-0',
}: AiTranslateControlProps) {
    const { t } = useTranslation();
    const chatModels = useConfigChatModels();
    const configured = useMemo(() => translationTierKeys(tierMapOf(chatModels.data)), [chatModels.data]);
    const options = configured.length ? configured : [tier];
    // A tier the server no longer has (or the hook's 'fast' default on a server
    // without it) moves to the first configured one, so what the select shows
    // is what the request sends.
    useEffect(() => {
        if (configured.length && !configured.includes(tier)) onTierChange(configured[0]);
    }, [configured, tier, onTierChange]);

    return (
        <div className={className}>
            <select
                value={tier}
                onChange={e => onTierChange(e.target.value)}
                disabled={translating}
                aria-label={t('platform_panels.translate_tier', 'Model tier for AI translation')}
                className="px-2 py-1 rounded-lg text-xs border outline-none bg-[var(--bg-secondary)] border-[var(--border-default)] text-[var(--text-primary)] focus:border-[var(--accent-primary)]"
            >
                {options.map(key => <option key={key} value={key}>{t(tierI18nKey(key), TIER_META[key]?.label ?? key)}</option>)}
            </select>
            <button
                type="button"
                onClick={onTranslate}
                disabled={translating || missing === 0}
                className={PRIMARY_BTN}
            >
                {translating ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> {t('admin_languages.ai.translating', 'Translating...')}</>
                ) : (
                    <>{icon ?? <Languages className="w-3.5 h-3.5" aria-hidden="true" />} {t('admin_languages.ai.translate', 'AI Translate')}{showCount ? ` (${missing || 0})` : ''}</>
                )}
            </button>
        </div>
    );
}

// The status banner shown under the toolbar after a translate run. Renders
// nothing until there is a result. `result` is `{ message }` on success or
// `{ error }` on failure (see useAiTranslate).
export function AiTranslateResult({ result }: { result: AiTranslateResultData | null }) {
    if (!result) return null;
    return (
        <div className={`${result.error ? ALERT_ERROR : ALERT_SUCCESS} mb-3 items-center`} role={result.error ? 'alert' : 'status'}>
            {result.error ? (
                <><AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> {result.error}</>
            ) : (
                <><Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> {result.message}</>
            )}
        </div>
    );
}
