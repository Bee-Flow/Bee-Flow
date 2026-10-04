import React, { useEffect, useState } from 'react';
import { BookOpen, CircleCheck, X } from 'lucide-react';
import Modal from '../../../shared/Modal';
import { useTranslation } from '../../../../hooks/useTranslation';
import {
    AI_ACT_QUESTIONS, useAiActSuggestion, useSaveAiActCheck,
    type AiActAnswers, type AiActDomain, type AiActQuestion, type AiActReason, type AiActState, type AiActSuggestion,
    type AnnexDomainId, type Tri,
} from '../../../../api/queries/automation/readiness';
import { PRIMARY_BTN, SECONDARY_BTN } from './settingsUi';
import { DOMAIN_FALLBACK, questionText, reasonText, type QuestionText } from './aiActCopy';

export { reasonText };

type Draft = Record<AiActQuestion, Tri | null> & { domains: AnnexDomainId[] };

const EMPTY: Draft = { usesAi: null, externalOutput: null, sensitiveUse: null, domains: [] };

/** Where every opening starts: the last recorded answers, else Bee's suggestion (question 3 never prefilled). */
function initialDraft(s: AiActSuggestion | undefined): Draft {
    if (!s) return EMPTY;
    if (s.previous) return { ...s.previous, domains: [...s.previous.domains] };
    return { usesAi: s.suggested.usesAi, externalOutput: s.suggested.externalOutput, sensitiveUse: null, domains: [] };
}

function answered(d: Draft, q: AiActQuestion): boolean {
    if (!d[q]) return false;
    return q !== 'sensitiveUse' || d.sensitiveUse !== 'yes' || d.domains.length > 0;
}

/**
 * The full editor of the AI Act check (artboard 5e-6): three questions, one at
 * a time, opened from "Change answers". Bee checks by itself first
 * (AiActAutoCard); this is the override when a person disagrees with it.
 * Starts on the recorded answers, else on Bee's suggestion. Finishing records
 * the check (PUT /:id/ai-act, source 'manual'), valid for 12 months.
 */
export default function AiActWizard({ open, onClose, automationId, onDone }: {
    open: boolean;
    onClose: () => void;
    automationId: string;
    onDone?: (s: AiActState) => void;
}) {
    const { t } = useTranslation();
    const suggestion = useAiActSuggestion(automationId, { enabled: open });
    const save = useSaveAiActCheck(automationId, { onDone: (s) => { onDone?.(s); onClose(); } });
    const [step, setStep] = useState(0);
    const [draft, setDraft] = useState<Draft>(EMPTY);
    const s = suggestion.data;

    // Start every opening at question 1 with the answers filled in.
    useEffect(() => {
        if (!open) return;
        setStep(0);
        setDraft(initialDraft(suggestion.data));
    }, [open, suggestion.data]);

    const q = AI_ACT_QUESTIONS[step];
    const last = step === AI_ACT_QUESTIONS.length - 1;
    const heading = t('automations.aiact.title', 'AI Act check');
    const finish = () => save.mutate({
        usesAi: draft.usesAi || 'unknown',
        externalOutput: draft.externalOutput || 'unknown',
        sensitiveUse: draft.sensitiveUse || 'unknown',
        domains: draft.domains,
    } satisfies AiActAnswers);

    return (
        <Modal open={open} onClose={onClose} size="auto" className="w-full max-w-[620px]" label={heading} variant="bare">
            <div className="rounded-[14px] bg-[var(--bg-card)] shadow-xl text-xs text-[var(--text-primary)] flex flex-col max-h-[90vh] overflow-hidden">
                <WizardHeader heading={heading} step={step} onClose={onClose} />
                <div className="p-[18px] flex flex-col gap-3 overflow-y-auto">
                    {AI_ACT_QUESTIONS.slice(0, step).map((prev, i) => (
                        <AnsweredLine
                            key={prev}
                            index={i}
                            question={prev}
                            answer={draft[prev]}
                            reason={s && s.suggested[prev] && draft[prev] === s.suggested[prev] ? s.reasons[prev][0] : undefined}
                            onChange={() => setStep(i)}
                        />
                    ))}
                    <CurrentQuestion q={q} step={step} draft={draft} setDraft={setDraft} suggestion={s} />
                    {save.error && (
                        <p role="alert" className="text-[var(--error)]">
                            {save.error.code?.startsWith('ai_act') && save.error.message
                                ? save.error.message
                                : t('automations.aiact.save_failed', 'Could not record the check. Try again.')}
                        </p>
                    )}
                </div>
                <div className="px-[18px] py-3 border-t border-[var(--border-default)] flex gap-2">
                    <button type="button" disabled={step === 0} onClick={() => setStep(n => n - 1)} className={SECONDARY_BTN}>
                        {t('automations.aiact.previous', 'Previous')}
                    </button>
                    <button
                        type="button"
                        disabled={save.isPending || !answered(draft, q)}
                        onClick={() => (last ? finish() : setStep(n => n + 1))}
                        className={`${PRIMARY_BTN} ml-auto`}
                    >
                        {last ? t('automations.aiact.finish', 'Finish check') : t('automations.aiact.next', 'Next')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

function CurrentQuestion({ q, step, draft, setDraft, suggestion }: {
    q: AiActQuestion;
    step: number;
    draft: Draft;
    setDraft: React.Dispatch<React.SetStateAction<Draft>>;
    suggestion: AiActSuggestion | undefined;
}) {
    const { t } = useTranslation();
    const text = questionText(q, t);
    const reasons = suggestion?.reasons[q] || [];
    return (
        <>
            <h3 className="text-[15px] font-semibold mt-1">{step + 1} · {text.title}</h3>
            <p className="text-[var(--text-secondary)] leading-[17px]">{text.hint}</p>
            <OptionCards
                text={text}
                value={draft[q]}
                suggested={suggestion?.suggested[q] ?? null}
                onPick={(v) => setDraft(d => ({ ...d, [q]: v }))}
            />
            {q === 'sensitiveUse' && draft.sensitiveUse === 'yes' && suggestion && (
                <DomainList
                    domains={suggestion.domains}
                    chosen={draft.domains}
                    onToggle={(id) => setDraft(d => ({ ...d, domains: d.domains.includes(id) ? d.domains.filter(x => x !== id) : [...d.domains, id] }))}
                />
            )}
            {reasons.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-[var(--text-tertiary)]" data-testid={`aiact-reasons-${q}`}>
                    {reasons.map((r, i) => <li key={`${r.code}-${i}`}>{reasonText(r, t)}</li>)}
                </ul>
            )}
            <div className="flex items-center gap-1.5 text-[var(--text-tertiary)]">
                <BookOpen className="w-3 h-3" aria-hidden />
                <a href={text.why.href} target="_blank" rel="noopener noreferrer" className="underline">
                    {t('automations.aiact.why', 'Why do we ask this?')}
                </a>
                <span>· {text.why.label}</span>
            </div>
        </>
    );
}

function DomainList({ domains, chosen, onToggle }: { domains: AiActDomain[]; chosen: AnnexDomainId[]; onToggle: (id: AnnexDomainId) => void }) {
    const { t } = useTranslation();
    return (
        <fieldset className="flex flex-col gap-1 pl-1" data-testid="aiact-domains">
            <legend className="font-semibold mb-1">{t('automations.aiact.domains', 'Which area? Pick at least one.')}</legend>
            {domains.map(d => (
                <label key={d.id} className="flex items-start gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={chosen.includes(d.id)}
                        onChange={() => onToggle(d.id)}
                        className="mt-0.5 accent-[var(--accent-primary)]"
                    />
                    <span>
                        {t(`compliance.ladder_annex_q_${d.id}`, DOMAIN_FALLBACK[d.id])}
                        {d.article && <span className="text-[var(--text-tertiary)]"> · {d.article}</span>}
                    </span>
                </label>
            ))}
        </fieldset>
    );
}

function WizardHeader({ heading, step, onClose }: { heading: string; step: number; onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="px-[18px] py-3.5 flex items-center gap-2 border-b border-[var(--border-default)]">
            <h2 className="font-semibold text-sm">{heading}</h2>
            <span className="text-[var(--text-tertiary)]">
                {t('automations.aiact.progress', 'question {n} of {total}', { n: step + 1, total: AI_ACT_QUESTIONS.length })}
            </span>
            <div className="flex gap-[3px] ml-2.5" aria-hidden>
                {AI_ACT_QUESTIONS.map((_, i) => (
                    <span key={i} className={`w-7 h-1 rounded-sm ${i <= step ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)]'}`} />
                ))}
            </div>
            <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <X className="w-[15px] h-[15px]" aria-hidden />
            </button>
        </div>
    );
}

/** "1 · Does this automation use AI? No · Bee found no AI steps.   change" */
function AnsweredLine({ index, question, answer, reason, onChange }: {
    index: number; question: AiActQuestion; answer: Tri | null; reason?: AiActReason; onChange: () => void;
}) {
    const { t } = useTranslation();
    const text = questionText(question, t);
    const chosen = text.options.find(o => o.value === answer);
    return (
        <div className="flex items-center gap-2 text-[var(--text-secondary)]" data-testid={`aiact-answered-${question}`}>
            <CircleCheck className="w-3.5 h-3.5 shrink-0 text-[var(--success)]" aria-hidden />
            <span className="min-w-0">
                {index + 1} · {text.title} <b className="text-[var(--text-primary)]">{chosen?.label || t('automations.aiact.unknown', 'I don\'t know')}</b>
                {reason && <span className="text-[var(--text-tertiary)]"> · {reasonText(reason, t)}</span>}
            </span>
            <button type="button" onClick={onChange} className="ml-auto underline shrink-0">
                {t('automations.aiact.change', 'change')}
            </button>
        </div>
    );
}

function OptionCards({ text, value, suggested, onPick }: {
    text: QuestionText; value: Tri | null; suggested: Tri | null; onPick: (v: Tri) => void;
}) {
    const { t } = useTranslation();
    return (
        <div role="radiogroup" aria-label={text.title} className="flex flex-col gap-1.5">
            {text.options.map(o => {
                const selected = value === o.value;
                const bee = suggested === o.value && suggested !== 'unknown';
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => onPick(o.value)}
                        className={`flex gap-2.5 px-3 py-2.5 rounded-[10px] text-left ${selected
                            ? 'border-2 border-[var(--accent-primary)]'
                            : 'border border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        <span className={`w-4 h-4 rounded-full shrink-0 box-border ${selected ? 'border-[5px] border-[var(--accent-primary)]' : 'border-[1.5px] border-[var(--text-tertiary)]'}`} aria-hidden />
                        <span className="min-w-0">
                            <span className="block font-semibold">
                                {o.label}
                                {bee && <span className="font-medium text-[var(--type-ai)]"> · {t('automations.aiact.bee_thinks', 'Bee thinks this')}</span>}
                            </span>
                            {o.hint && <span className="block text-[var(--text-tertiary)]">{o.hint}</span>}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
