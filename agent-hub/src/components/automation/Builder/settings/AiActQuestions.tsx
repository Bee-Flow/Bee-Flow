import React from 'react';
import { BookOpen } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { AnnexDomainId, Tri } from '../../../../api/queries/automation/readiness';
import type { AiActAnswerBody, AiActCheckQuestion, AiActOpenQuestion } from '../../../../api/queries/automation/aiActCheck';
import { DOMAIN_FALLBACK, questionText, reasonText } from './aiActCopy';

/** The answers being given to the open questions, before they are sent. */
export interface AiActDraft {
    answers: Partial<Record<AiActCheckQuestion, Tri>>;
    domains: AnnexDomainId[];
}

/** Bee's suggestion is preselected only where it is 'likely'; 'unknown' starts empty. */
export function initialDraft(questions: AiActOpenQuestion[]): AiActDraft {
    const answers: AiActDraft['answers'] = {};
    let domains: AnnexDomainId[] = [];
    for (const q of questions) {
        if (q.confidence !== 'likely' || !q.suggested) continue;
        answers[q.id] = q.suggested;
        if (q.id === 'sensitiveUse' && q.suggested === 'yes') domains = [...q.suggestedDomains];
    }
    return { answers, domains };
}

/** "Does it use AI?" open and not answered yes: the other questions do not matter yet. */
export function visibleQuestions(questions: AiActOpenQuestion[], d: AiActDraft): AiActOpenQuestion[] {
    const usesAi = questions.find(q => q.id === 'usesAi');
    return usesAi && d.answers.usesAi !== 'yes' ? [usesAi] : questions;
}

/** Every shown question answered, and "yes, a high-risk area" names one. */
export function draftComplete(questions: AiActOpenQuestion[], d: AiActDraft): boolean {
    return visibleQuestions(questions, d).every(q => !!d.answers[q.id]
        && (q.id !== 'sensitiveUse' || d.answers.sensitiveUse !== 'yes' || d.domains.length > 0));
}

/** The PUT body for the shown questions. */
export function draftBody(questions: AiActOpenQuestion[], d: AiActDraft): AiActAnswerBody {
    const body: AiActAnswerBody = {};
    for (const q of visibleQuestions(questions, d)) {
        const a = d.answers[q.id];
        if (!a) continue;
        body[q.id] = a;
        if (q.id === 'sensitiveUse' && a === 'yes') body.domains = [...d.domains];
        if (q.id === 'prohibitedUse' && a === 'yes' && q.practices.length) body.practices = [...q.practices];
    }
    return body;
}

/**
 * The open questions, all on one screen: the answers as pills, Bee's
 * suggestion marked ("Bee thinks this"), the evidence line under each, and
 * the ten areas when "yes" is picked for Annex III.
 */
export default function AiActQuestions({ questions, draft, onChange, disabled = false }: {
    questions: AiActOpenQuestion[];
    draft: AiActDraft;
    onChange: (next: AiActDraft) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex flex-col gap-3" data-testid="aiact-questions">
            {visibleQuestions(questions, draft).map(q => (
                <Question key={q.id} q={q} draft={draft} onChange={onChange} disabled={disabled} />
            ))}
        </div>
    );
}

function Question({ q, draft, onChange, disabled }: { q: AiActOpenQuestion; draft: AiActDraft; onChange: (next: AiActDraft) => void; disabled: boolean }) {
    const { t } = useTranslation();
    const text = questionText(q.id, t);
    const value = draft.answers[q.id] || null;
    const pick = (v: Tri) => {
        const next: AiActDraft = { answers: { ...draft.answers, [q.id]: v }, domains: draft.domains };
        if (q.id === 'sensitiveUse' && v === 'yes' && !next.domains.length) next.domains = [...q.suggestedDomains];
        onChange(next);
    };
    const toggle = (id: AnnexDomainId) => onChange({
        answers: draft.answers,
        domains: draft.domains.includes(id) ? draft.domains.filter(x => x !== id) : [...draft.domains, id],
    });
    const why = q.evidence.map(e => reasonText(e, t)).filter(Boolean).join(' ');
    return (
        <fieldset className="flex flex-col gap-1.5 min-w-0" data-testid={`aiact-question-${q.id}`}>
            <legend className="font-semibold leading-[17px] mb-1">{text.title}</legend>
            <p className="text-[var(--text-secondary)] leading-4">{text.hint}</p>
            <div role="radiogroup" aria-label={text.title} className="flex flex-wrap gap-1.5">
                {text.options.map(o => {
                    const selected = value === o.value;
                    const bee = q.suggested === o.value;
                    return (
                        <button
                            key={o.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={disabled}
                            onClick={() => pick(o.value)}
                            className={`px-2.5 py-1 rounded-lg text-left disabled:opacity-60 ${selected
                                ? 'border-2 border-[var(--accent-primary)] font-semibold'
                                : 'border border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]'}`}
                        >
                            {o.label}
                            {/* The space outside the span, so it is part of the radio's accessible name. */}
                            {bee && ' '}
                            {bee && <span className="font-medium text-[var(--type-ai)]">· {t('routines.aiact.bee_thinks', 'Bee thinks this')}</span>}
                        </button>
                    );
                })}
            </div>
            {q.id === 'sensitiveUse' && value === 'yes' && (
                <fieldset className="flex flex-col gap-1 pl-1" data-testid="aiact-domains">
                    <legend className="font-semibold mb-1">{t('routines.aiact.domains', 'Which area? Pick at least one.')}</legend>
                    {q.domains.map(d => (
                        <label key={d.id} className="flex items-start gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={draft.domains.includes(d.id)}
                                disabled={disabled}
                                onChange={() => toggle(d.id)}
                                className="mt-0.5 accent-[var(--accent-primary)]"
                            />
                            <span>
                                {t(`compliance.ladder_annex_q_${d.id}`, DOMAIN_FALLBACK[d.id])}
                                {d.article && <span className="text-[var(--text-tertiary)]"> · {d.article}</span>}
                            </span>
                        </label>
                    ))}
                </fieldset>
            )}
            {why && <p className="text-[var(--text-tertiary)] leading-4" data-testid={`aiact-evidence-${q.id}`}>{why}</p>}
            <p className="flex items-center gap-1.5 text-[var(--text-tertiary)]">
                <BookOpen className="w-3 h-3 shrink-0" aria-hidden />
                <a href={text.why.href} target="_blank" rel="noopener noreferrer" className="underline">
                    {t('routines.aiact.why', 'Why do we ask this?')}
                </a>
                <span>· {text.why.label}</span>
            </p>
        </fieldset>
    );
}
