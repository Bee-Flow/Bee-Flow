import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useConfigChatModels } from '@/api/queries/configModels';
import type { PatternLibraryProps } from './patternTypes';
import { STARTER_SETS } from './starterSets';
import { useTranslation } from '@/hooks/useTranslation';
import { TIER_META, configuredTierKeys } from '@/components/licensing/tierMeta';
import { generateRegexWithAi } from '../api/guardrailsApi';
import { errorMessage } from '@/utils/caughtError';

type StarterSet = (typeof STARTER_SETS)[number];

/**
 * Starter sets. The two empty columns below were the whole reason this page
 * read as unfinished: an authoring surface with nothing to author from.
 */
export function StarterSets({ onApply }: { onApply: (set: StarterSet) => void }) {
    const { t } = useTranslation();
    return (
        <section
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4"
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
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-primary)]/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
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
const NO_TIERS: Record<string, unknown> = {};

function useGenerationTiers() {
    // A failed read leaves the picker empty; generation still works on the server default.
    const data = useConfigChatModels().data as { tiers?: Record<string, unknown> } | Record<string, unknown> | undefined;
    const tiers = (data as { tiers?: Record<string, unknown> } | undefined)?.tiers || data || NO_TIERS;
    const tierKeys: string[] = configuredTierKeys(tiers).filter((k: string) => k !== 'auto');
    const [picked, setAiModelTier] = useState('');
    // Until one is picked (or when the picked one is gone), the first configured tier.
    const aiModelTier = picked && tierKeys.includes(picked) ? picked : (tierKeys[0] || '');
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
            setAiMessage({ type: 'error', text: 'Error communicating with AI: ' + errorMessage(e) });
        } finally {
            setAiGenerating(false);
        }
    };

    return (
        <section className="p-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]">
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
                    className="flex-1 min-w-[240px] px-3 py-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-[13px] disabled:opacity-50"
                />
                <label className="sr-only" htmlFor="gr-ai-tier">{t('admin.gr_ai_tier', 'Model tier')}</label>
                <select
                    id="gr-ai-tier"
                    value={aiModelTier}
                    onChange={e => setAiModelTier(e.target.value)}
                    disabled={aiGenerating || tierKeys.length === 0}
                    className="px-3 py-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-[13px] disabled:opacity-50"
                >
                    {tierKeys.map(key => (
                        <option key={key} value={key}>{(TIER_META as Record<string, { label?: string } | undefined>)[key]?.label || key}</option>
                    ))}
                </select>
                <button
                    onClick={handleGenerateWithAI}
                    disabled={aiGenerating || !aiPrompt.trim()}
                    className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-[var(--accent-primary-fg)] disabled:opacity-50 bg-[var(--accent-primary)] hover:opacity-90 transition-opacity whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                    {aiGenerating ? t('admin.gr_ai_generating', 'Generating…') : t('admin.gr_ai_generate', 'Generate')}
                </button>
            </div>
            {aiMessage && (
                <p className={`mt-2 text-xs ${aiMessage.type === 'success' ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`} role="status">
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
