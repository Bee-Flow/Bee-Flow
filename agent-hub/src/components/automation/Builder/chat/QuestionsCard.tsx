import { ArrowRight, Check, MessageCircleQuestion } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import InlineMarkdown from './InlineMarkdown';
import { answersToText, type QuestionAnswer } from './questionAnswers';
import { stripInlineMarkdown } from './markdownText';
import { questionKeyAction } from './questionKeys';

export interface BuilderQuestion {
    id: string;
    prompt: string;
    options: string[];
    /** Up to three words from the model; the stepper label. */
    header?: string;
}

interface QuestionsCardProps {
    questions?: BuilderQuestion[] | null;
    /** Dims and disables the card. The builder does not pass it once the
     *  questions event has arrived: the turn ends right after the call, and a
     *  card that showed up greyed out read as a card that could not be used. */
    running?: boolean;
    /** Gets the text for the model and the structured list for the chat. */
    onAnswer: (text: string, answers: QuestionAnswer[]) => void;
}

// A click on an option moves on by itself, after a beat, so the pick is seen
// to land before the next question replaces it.
const ADVANCE_MS = 150;

const SELECTED_ROW = 'border-[color-mix(in_srgb,var(--type-ai)_45%,transparent)] bg-[color-mix(in_srgb,var(--type-ai)_6%,var(--bg-card))]';
const IDLE_ROW = 'border-transparent bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-secondary)]';

type Translate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

const rowClass = (selected: boolean) => `flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 transition-colors ${selected ? SELECTED_ROW : IDLE_ROW}`;

function Badge({ n, selected }: { n: number; selected: boolean }) {
    return <span aria-hidden="true" className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold ${selected ? 'bg-[var(--type-ai)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-tertiary)]'}`}>{selected ? <Check size={11} strokeWidth={3} /> : n}</span>;
}

interface StepProps {
    q: BuilderQuestion;
    running: boolean;
    chosen: number;
    typed: string;
    otherValue: string;
    otherRef: RefObject<HTMLInputElement | null>;
    t: Translate;
    onPick: (index: number, advance: boolean) => void;
    onOtherChange: (value: string) => void;
    onOtherFocus: () => void;
}

/** The question on screen: its options as radio rows, and the free-text row last. */
function QuestionStep({ q, running, chosen, typed, otherValue, otherRef, t, onPick, onOtherChange, onOtherFocus }: StepProps) {
    return <fieldset disabled={running} className="min-w-0 p-4 disabled:opacity-60">
        <legend className="sr-only">{stripInlineMarkdown(q.prompt)}</legend>
        <p className="mb-3 font-medium leading-5 text-[var(--text-primary)]"><InlineMarkdown text={q.prompt} /></p>
        <div role="radiogroup" aria-label={stripInlineMarkdown(q.prompt)} className="space-y-1.5">
            {q.options.map((option, j) => {
                const selected = !typed && chosen === j;
                return <label key={`${q.id}-${j}`} className={rowClass(selected)}>
                    {/* detail is 0 for the click a key press (arrow between radios) synthesises, so only a real click moves on. */}
                    <input type="radio" name={`assistant-answer-${q.id}`} value={option} checked={selected} aria-label={stripInlineMarkdown(option)} onChange={() => onPick(j, false)} onClick={e => { if (e.detail > 0) onPick(j, true); }} className="sr-only peer" />
                    <Badge n={j + 1} selected={selected} />
                    <span className="min-w-0 flex-1 peer-focus-visible:underline"><span className="block leading-[18px] text-[var(--text-primary)]"><InlineMarkdown text={option} /></span>{j === 0 && <span className="mt-1 block text-[10px] font-medium text-[var(--text-tertiary)]">{t('automations.assistant.suggested', 'suggested')}</span>}</span>
                </label>;
            })}
            <label className={rowClass(!!typed)}>
                <Badge n={q.options.length + 1} selected={!!typed} />
                <input ref={otherRef} type="text" value={otherValue} aria-label={t('automations.assistant.questions_other', 'Other…')} placeholder={t('automations.assistant.questions_other_placeholder', 'Type your own answer')}
                    onFocus={onOtherFocus} onChange={e => onOtherChange(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent leading-[18px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]" />
            </label>
        </div>
    </fieldset>;
}

interface ProgressProps { total: number; step: number; ids: string[]; running: boolean; t: Translate; onJump: (index: number) => void }

/** Segments that are buttons: the bar shows where you are and jumps there. */
function ProgressBar({ total, step, ids, running, t, onJump }: ProgressProps) {
    if (total < 2) return null;
    return <div className="flex gap-1 px-4 pt-3">
        {ids.map((id, i) => <button key={id} type="button" disabled={running} onClick={() => onJump(i)} aria-current={i === step ? 'step' : undefined} aria-label={t('automations.assistant.questions_jump', 'Go to question {n}', { n: i + 1 })} className="group/seg flex h-4 min-w-0 flex-1 items-center disabled:opacity-60">
            <span className={`h-1.5 w-full rounded-full transition-colors ${i === step ? 'bg-[var(--type-ai)]' : i < step ? 'bg-[color-mix(in_srgb,var(--type-ai)_45%,transparent)]' : 'bg-[var(--bg-secondary)] group-hover/seg:bg-[var(--border-default)]'}`} />
        </button>)}
    </div>;
}

/** Take focus on mount so the digits and Enter work at once, but never from a field the user is typing in (the composer). */
function useFocusOnMount(ref: RefObject<HTMLElement | null>) {
    useEffect(() => {
        const active = document.activeElement as HTMLElement | null;
        const typing = !!active && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
        if (!typing) ref.current?.focus({ preventScroll: true });
    }, [ref]);
}

/**
 * One question at a time. The model asks ALL its questions in one round (at most
 * six), so the card walks through them instead of piling them up; one "Send
 * answers" submits everything. The first option is the model's recommendation
 * and is preselected, so skipping ahead never sends an unanswered question.
 */
export default function QuestionsCard({ questions, running = false, onAnswer }: QuestionsCardProps) {
    const { t } = useTranslation();
    const [step, setStep] = useState(0);
    // Per question: the picked option (default 0, the recommendation) and, apart
    // from it, the typed text. Typed text counts only while its row is on AND it
    // holds something, so what the radios show is what gets sent, and the text
    // survives a pick of another row.
    const [picked, setPicked] = useState<Record<string, number>>({});
    const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
    const [otherText, setOtherText] = useState<Record<string, string>>({});
    const rootRef = useRef<HTMLDivElement>(null);
    const otherRef = useRef<HTMLInputElement>(null);
    const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const clearAdvance = () => { if (advanceTimer.current) { clearTimeout(advanceTimer.current); advanceTimer.current = null; } };
    useEffect(() => clearAdvance, []);
    useFocusOnMount(rootRef);
    if (!questions?.length) return null;

    const total = questions.length;
    const last = step === total - 1;
    const q = questions[Math.min(step, total - 1)];
    const typed = (x: BuilderQuestion) => (otherOn[x.id] ? (otherText[x.id] || '').trim() : '');
    const chosen = (x: BuilderQuestion) => picked[x.id] ?? 0;
    const send = () => {
        clearAdvance();
        const list = questions.map(x => ({ prompt: x.prompt, answer: typed(x) || x.options[chosen(x)], suggested: !typed(x) && chosen(x) === 0 }));
        onAnswer(answersToText(list), list);
    };
    const goTo = (to: number) => { clearAdvance(); setStep(Math.max(0, Math.min(total - 1, to))); };
    const next = () => (last ? send() : goTo(step + 1));
    const pick = (j: number, advance: boolean) => {
        setPicked(p => ({ ...p, [q.id]: j }));
        setOtherOn(o => ({ ...o, [q.id]: false }));
        if (advance && !last) { clearAdvance(); advanceTimer.current = setTimeout(() => setStep(s => Math.min(total - 1, s + 1)), ADVANCE_MS); }
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (running) return;
        const target = e.target as HTMLElement;
        const action = questionKeyAction({ key: e.key, shiftKey: e.shiftKey, modified: e.altKey || e.ctrlKey || e.metaKey, inOther: target === otherRef.current, onButton: target.tagName === 'BUTTON', onTextarea: target.tagName === 'TEXTAREA', optionCount: q.options.length });
        if (!action) return;
        e.preventDefault();
        if (action.type === 'leave-other') { e.stopPropagation(); rootRef.current?.focus(); }
        else if (action.type === 'next') next();
        else if (action.type === 'back') goTo(step - 1);
        else if (action.type === 'pick') pick(action.index, true);
        else otherRef.current?.focus();
    };

    return <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} data-testid="questions-card" className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card)] text-xs outline-none">
        <div className="flex items-start gap-2.5 border-b border-[var(--border-default)] p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--type-ai)_10%,transparent)] text-[var(--type-ai)]"><MessageCircleQuestion size={16} /></span>
            <div className="min-w-0">
                <h3 className="font-semibold leading-5 text-[var(--text-primary)]">{t('automations.assistant.questions', 'A few questions before continuing')}</h3>
                <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-tertiary)]">{total > 1
                    ? `${t('automations.assistant.questions_progress', 'Question {n} of {total}', { n: step + 1, total })}${q.header ? ` · ${q.header}` : ''}`
                    : t('automations.assistant.questions_hint', 'Choose an answer for each question, or add your own.')}</p>
            </div>
        </div>
        <ProgressBar total={total} step={step} ids={questions.map(x => x.id)} running={running} t={t} onJump={goTo} />
        <QuestionStep q={q} running={running} chosen={chosen(q)} typed={typed(q)} otherValue={otherText[q.id] || ''} otherRef={otherRef} t={t} onPick={pick}
            onOtherChange={value => { setOtherText(a => ({ ...a, [q.id]: value })); setOtherOn(o => ({ ...o, [q.id]: true })); }}
            onOtherFocus={() => { if ((otherText[q.id] || '').trim()) setOtherOn(o => ({ ...o, [q.id]: true })); }} />
        <div className="space-y-2 border-t border-[var(--border-default)] bg-[var(--bg-secondary)]/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
                {total > 1 && <button type="button" disabled={running || step === 0} onClick={() => goTo(step - 1)} className="rounded-xl px-3 py-2.5 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40">{t('automations.assistant.questions_back', 'Back')}</button>}
                <button type="button" disabled={running} onClick={next} className="ml-auto flex items-center justify-center gap-2 rounded-xl bg-[var(--text-primary)] px-4 py-2.5 font-medium text-[var(--bg-primary)] transition-opacity hover:opacity-90 disabled:opacity-50">
                    {total === 1 ? t('automations.assistant.questions_send_one', 'Send answer') : last ? t('automations.assistant.questions_send', 'Send answers') : t('automations.assistant.questions_next', 'Next')}<ArrowRight size={13} />
                </button>
            </div>
            {total > 1 && !last && <button type="button" disabled={running} onClick={send} className="block w-full rounded-lg py-1.5 text-center text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50">{t('automations.assistant.questions_use_suggested', 'Use suggestions for the rest')}</button>}
            <p className="text-center text-[10px] leading-4 text-[var(--text-tertiary)]">{t('automations.assistant.questions_keys_hint', '1–{n} to choose · Enter for next', { n: q.options.length })}</p>
        </div>
    </div>;
}
