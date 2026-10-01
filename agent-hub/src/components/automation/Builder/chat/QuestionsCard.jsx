import { ArrowRight, Check, ChevronDown, MessageCircleQuestion, Pencil } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';

export default function QuestionsCard({ questions, running, onAnswer }) {
    const { t } = useTranslation();
    const [answers, setAnswers] = useState({});
    const [custom, setCustom] = useState({});
    const [customAnswers, setCustomAnswers] = useState({});
    if (!questions?.length) return null;
    return <div className="overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] text-xs">
        <div className="flex items-start gap-2.5 border-b border-[var(--border-default)] p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--type-ai)_10%,transparent)] text-[var(--type-ai)]"><MessageCircleQuestion size={16} /></span>
            <div className="min-w-0"><h3 className="font-semibold leading-5 text-[var(--text-primary)]">{t('routines.assistant.questions', 'A few questions before continuing')}</h3><p className="mt-0.5 text-[11px] leading-4 text-[var(--text-tertiary)]">{t('routines.assistant.questions_hint', 'Choose an answer for each question, or add your own.')}</p></div>
        </div>
        <div className="divide-y divide-[var(--border-default)]">
            {questions.map((q, i) => <details key={q.id} open={i === 0} className="group/question">
                <summary className="flex cursor-pointer list-none items-start gap-2.5 p-4 transition-colors hover:bg-[var(--bg-secondary)]/40 [&::-webkit-details-marker]:hidden">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--bg-secondary)] text-[10px] font-semibold text-[var(--text-tertiary)]">{i + 1}</span>
                    <span className="min-w-0 flex-1"><span className="block font-medium leading-5 text-[var(--text-primary)]">{q.prompt}</span><span className="mt-1 line-clamp-2 text-[11px] leading-4 text-[var(--text-secondary)] group-open/question:hidden">{(custom[q.id] ? customAnswers[q.id]?.trim() : answers[q.id]) || q.options[0]}</span></span>
                    <ChevronDown size={14} className="mt-0.5 shrink-0 text-[var(--text-tertiary)] transition-transform group-open/question:rotate-180" />
                </summary>
                <fieldset disabled={running} className="min-w-0 px-4 pb-4 disabled:opacity-60">
                <legend className="sr-only">{q.prompt}</legend>
                <div className="space-y-1.5">
                    {q.options.map((option, j) => {
                        const selected = !custom[q.id] && (answers[q.id] || q.options[0]) === option;
                        return <label key={option} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors ${selected ? 'border-[color-mix(in_srgb,var(--type-ai)_45%,transparent)] bg-[color-mix(in_srgb,var(--type-ai)_6%,var(--bg-card))]' : 'border-transparent bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-secondary)]'}`}>
                            <input type="radio" name={`assistant-answer-${q.id}`} value={option} checked={selected} onChange={() => { setAnswers(a => ({ ...a, [q.id]: option })); setCustom(c => ({ ...c, [q.id]: false })); }} className="sr-only peer" />
                            <span aria-hidden="true" className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--type-ai)] peer-focus-visible:ring-offset-2 ${selected ? 'border-[var(--type-ai)] bg-[var(--type-ai)] text-white' : 'border-[var(--border-default)] bg-[var(--bg-card)]'}`}>{selected && <Check size={10} strokeWidth={3} />}</span>
                            <span className="min-w-0 flex-1"><span className="block break-words leading-[18px] text-[var(--text-primary)]">{option}</span>{j === 0 && <span className="mt-1 block text-[10px] font-medium text-[var(--text-tertiary)]">{t('routines.assistant.suggested', 'suggested')}</span>}</span>
                        </label>;
                    })}
                    <button type="button" onClick={() => setCustom(c => ({ ...c, [q.id]: !c[q.id] }))} aria-expanded={!!custom[q.id]} className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] hover:bg-[var(--bg-secondary)] ${custom[q.id] ? 'text-[var(--type-ai)]' : 'text-[var(--text-tertiary)]'}`}><Pencil size={12} />{t('routines.assistant.custom_answer', 'Or type your answer…')}</button>
                    {custom[q.id] && <textarea autoFocus id={`assistant-answer-${q.id}`} aria-label={q.prompt} rows={2} value={customAnswers[q.id] || ''} onChange={e => setCustomAnswers(a => ({ ...a, [q.id]: e.target.value }))} placeholder={t('routines.assistant.custom_answer', 'Or type your answer…')} className="w-full resize-y rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 leading-5 text-[var(--text-primary)] outline-none focus:border-[var(--type-ai)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--type-ai)_12%,transparent)]" />}
                </div>
            </fieldset>
            </details>)}
        </div>
        <div className="space-y-2 border-t border-[var(--border-default)] bg-[var(--bg-secondary)]/40 p-4">
            <button type="button" disabled={running} onClick={() => onAnswer(questions.map(q => `${q.prompt}\n${(custom[q.id] ? customAnswers[q.id]?.trim() : answers[q.id]) || q.options[0]}`).join('\n\n'))} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--text-primary)] px-3 py-2.5 font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50">{t('routines.assistant.answer_continue', 'Answer and continue')}<ArrowRight size={13} /></button>
            <p className="text-center text-[10px] leading-4 text-[var(--text-tertiary)]">{t('routines.assistant.default_answers', 'Open questions use the suggested answer when you continue.')}</p>
        </div>
    </div>;
}
