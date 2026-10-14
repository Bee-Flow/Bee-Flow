import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PatternLibraryProps } from './patternTypes';
import { STARTER_SETS } from './starterSets';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TIER_META, configuredTierKeys } from '../../../../licensing/tierMeta';
import { apiJson, generateRegexWithAi } from '../api/guardrailsApi';

type StarterSet = (typeof STARTER_SETS)[number];

/**
 * Starter sets. The two empty columns below were the whole reason this page
 * read as unfinished: an authoring surface with nothing to author from.
 */
export function StarterSets({ onApply }: { onApply: (set: StarterSet) => void }) {
    const { t } = useTranslation();
    return (
        <section
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5"
            aria-labelledby="gr-starter-heading"
        >
            <h3
                id="gr-starter-heading"
                className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1"
            >
                {t('admin.gr_starter_title', 'Start from a template')}
            </h3>
            <p className="text-xs text-[var(--text-secondary)] mb-3 leading-relaxed">
                {t('admin.gr_starter_desc', 'Ready-made collections per country and theme. They are added to your library for review — nothing is applied to an organisation until you bind the collection.')}
            </p>
            <div className="flex flex-wrap gap-2">
                {STARTER_SETS.map(set => (
                    <button
                        key={set.id}
                        type="button"
                        onClick={() => onApply(set)}
                        title={set.description}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-primary)]/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                    >
                        <Plus size={13} aria-hidden="true" />
                        {set.name}
                    </button>
                ))}
            </div>
            {/* Worth saying plainly: this layer is not the PII detector.
                It is flat redaction that keeps working when the guard
                service is down — the state that produces "Privacy
                protection is temporarily unavailable". */}
            <p className="mt-3 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                {t('admin.gr_starter_note', 'These patterns are matched in the app itself, so they keep working when the PII Guard service is unavailable. They have no checksums — the guard handles that.')}
            </p>
        </section>
    );
}

/**
 * The tiers the server has configured, and the one picked for generation.
 *
 * The picker used to hard-code `fast|think|write|deep_thinking`, but the real
 * keys are `fast|standard|swarm|thinking|writer|pro`. Three of the four
 * matched nothing, so `tiers[key] || {}` silently fell back to the global
 * default model — including for `think`, which was the DEFAULT selection.
 * Sourcing the list from the server's own configured tiers makes that class
 * of drift impossible rather than fixing it once.
 */
function useGenerationTiers() {
    const [tiers, setTiers] = useState<Record<string, unknown>>({});
    const [aiModelTier, setAiModelTier] = useState('');
    useEffect(() => {
        let cancelled = false;
        apiJson('/ai/config/chat-models')
            .then((data: { tiers?: Record<string, unknown> } | Record<string, unknown> | null) => {
                if (cancelled) return;
                const configured = (data as { tiers?: Record<string, unknown> })?.tiers || data || {};
                setTiers(configured);
                const keys: string[] = configuredTierKeys(configured).filter((k: string) => k !== 'auto');
                setAiModelTier(prev => (prev && keys.includes(prev) ? prev : (keys[0] || '')));
            })
            .catch(() => { /* the picker just stays empty; generation still works on the server default */ });
        return () => { cancelled = true; };
    }, []);
    const tierKeys: string[] = configuredTierKeys(tiers).filter((k: string) => k !== 'auto');
    return { tierKeys, aiModelTier, setAiModelTier };
}

interface AiGenerateProps extends Pick<PatternLibraryProps, 'setRules' | 'setCollections'> {
    onSaved?: () => void;
}

/** Describe what to detect; the AI writes (and saves) the whole library. */
export function AiGenerate({ setRules, setCollections, onSaved }: AiGenerateProps) {
    const { t } = useTranslation();
    const [aiPrompt, setAiPrompt] = useState('');
    const [aiGenerating, setAiGenerating] = useState(false);
    const [aiMessage, setAiMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const { tierKeys, aiModelTier, setAiModelTier } = useGenerationTiers();

    const handleGenerateWithAI = async () => {
        if (!aiPrompt.trim() || aiGenerating) return;
        setAiGenerating(true);
        setAiMessage(null);
        try {
            const data = await generateRegexWithAi({ prompt: aiPrompt.trim(), modelTier: aiModelTier });
            if (data?.success) {
                setRules(data.regexGuardrails?.rules || []);
                setCollections(data.regexGuardrails?.collections || []);
                setAiMessage({ type: 'success', text: data.message || 'Rules generated successfully!' });
                setAiPrompt('');
                onSaved?.();
            } else {
                setAiMessage({ type: 'error', text: data?.error || 'Failed to generate rules' });
            }
        } catch (e) {
            setAiMessage({ type: 'error', text: 'Error communicating with AI: ' + (e as Error).message });
        } finally {
            setAiGenerating(false);
        }
    };

    return (
        <section className="p-5 rounded-xl border border-[var(--accent-primary)]/20 bg-[var(--accent-primary)]/5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
                ✨ {t('admin.gr_ai_title', 'Generate with AI')}
            </h3>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
                {t('admin.gr_ai_desc', 'Describe what you want to detect and the AI will create rules and collections for you.')}
            </p>
            <div className="flex flex-wrap gap-2">
                <input
                    value={aiPrompt}
                    onChange={e => setAiPrompt(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleGenerateWithAI()}
                    placeholder={t('admin.gr_ai_placeholder', 'e.g. Dutch IBAN and passport numbers, EU credit cards…')}
                    aria-label={t('admin.gr_ai_placeholder', 'e.g. Dutch IBAN and passport numbers, EU credit cards…')}
                    disabled={aiGenerating}
                    className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm disabled:opacity-50"
                />
                <label className="sr-only" htmlFor="gr-ai-tier">{t('admin.gr_ai_tier', 'Model tier')}</label>
                <select
                    id="gr-ai-tier"
                    value={aiModelTier}
                    onChange={e => setAiModelTier(e.target.value)}
                    disabled={aiGenerating || tierKeys.length === 0}
                    className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm disabled:opacity-50"
                >
                    {tierKeys.map(key => (
                        <option key={key} value={key}>{(TIER_META as Record<string, { label?: string } | undefined>)[key]?.label || key}</option>
                    ))}
                </select>
                <button
                    onClick={handleGenerateWithAI}
                    disabled={aiGenerating || !aiPrompt.trim()}
                    className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 bg-[var(--accent-primary)] hover:opacity-90 transition-opacity whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                    {aiGenerating ? t('admin.gr_ai_generating', 'Generating…') : t('admin.gr_ai_generate', 'Generate')}
                </button>
            </div>
            {aiMessage && (
                <p className={`mt-2 text-xs ${aiMessage.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`} role="status">
                    {aiMessage.text}
                </p>
            )}
            {/* The endpoint persists inside its tool loop and returns the WHOLE
                library, which replaces anything unsaved here. Say so until the
                review-then-adopt flow lands in phase 2. */}
            <p className="mt-2 text-[11px] text-[var(--text-tertiary)] leading-relaxed">
                {t('admin.gr_ai_replaces_warning', 'Generating saves immediately and replaces the full rule library — any unsaved edits above are lost.')}
            </p>
        </section>
    );
}
