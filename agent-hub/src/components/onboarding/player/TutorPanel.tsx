import { CornerDownLeft, Loader2, MessageCircleQuestionMark, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import MarkdownRenderer from '../../renderers/MarkdownRenderer';
import { askTutor } from '../exerciseCoach';
import type { LessonStep } from '../lessons.types';

/**
 * TutorPanel — the "Ask AI" surface available on EVERY step of the lesson
 * player, not just graded exercises. Learners who get stuck mid-lesson ask in
 * their own words; the tutor answers grounded in the current step's content
 * plus a server-side Bee Flow fact sheet. It nudges before it solves (the
 * Codecademy help-ladder), which the server prompt enforces.
 *
 * Conversation state lives in memory per lesson (the thread resets when the
 * player closes) — deliberately lightweight, the persistent record is the
 * lesson progress itself.
 *
 * Props:
 *   lessonId, step — current position; the step's visible text becomes context
 *   modelTier      — tier for the tutor call
 *   onClose        — collapse the panel
 */
const QUICK_PROMPTS: { id: string; labelKey: string; labelFallback: string }[] = [
    { id: 'explain', labelKey: 'learn.tutor.quick_explain', labelFallback: 'Explain this differently' },
    { id: 'example', labelKey: 'learn.tutor.quick_example', labelFallback: 'Give me a real example' },
    { id: 'why', labelKey: 'learn.tutor.quick_why', labelFallback: 'Why does this matter?' },
];

// The step's learner-visible text, so the tutor knows what "this" refers to.
// Kept compact — the server caps context length anyway.
function stepContextOf(step: LessonStep | null | undefined): string {
    if (!step) return '';
    const bits = [
        step.titleFallback,
        step.bodyFallback,
        step.bodyMdFallback,
        step.questionFallback,
        step.instructionFallback,
    ].filter(Boolean);
    return bits.join('\n').slice(0, 1500);
}

interface TutorPanelProps {
    lessonId: string;
    step: LessonStep | null;
    modelTier?: string;
    onClose: () => void;
}

interface TutorMessage {
    role: 'user' | 'tutor';
    text: string;
}

export default function TutorPanel({ lessonId, step, modelTier = 'fast', onClose }: TutorPanelProps) {
    const { t, locale } = useTranslation();
    const [thread, setThread] = useState<TutorMessage[]>([]); // { role: 'user'|'tutor', text }
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [thread, busy]);

    const ask = async (question: string) => {
        const q = String(question || '').trim();
        if (!q || busy) return;
        setInput('');
        setThread((prev) => [...prev, { role: 'user', text: q }]);
        setBusy(true);
        const { answer } = await askTutor({
            question: q,
            lessonId,
            stepId: step?.id,
            stepContext: stepContextOf(step),
            modelTier,
            locale,
        });
        setThread((prev) => [...prev, { role: 'tutor', text: answer }]);
        setBusy(false);
    };

    return (
        <div className="flex flex-col gap-2 rounded-[10px] flex-shrink-0 [background:var(--bg-secondary)] [padding:10px_12px]" data-testid="tutor-panel">
            <div className="flex items-center gap-1.5">
                <MessageCircleQuestionMark className="w-[13px] h-[13px] text-[var(--accent-primary)]" aria-hidden="true" />
                <span className="font-semibold text-[var(--text-primary)]">{t('learn.tutor.name', 'AI tutor')}</span>
                <span className="text-[11px] text-[var(--text-tertiary)]">{t('learn.tutor.ladder', 'gives a hint first, the answer only after')}</span>
                <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')}
                    className="ml-auto grid place-items-center w-6 h-6 rounded-md transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]">
                    <X className="w-[12px] h-[12px]" />
                </button>
            </div>

            {thread.length === 0 ? (
                <div className="flex flex-wrap gap-1 text-[11px] font-medium">
                    {QUICK_PROMPTS.map((p) => (
                        <button key={p.id} type="button" onClick={() => ask(t(p.labelKey, p.labelFallback))}
                            className="rounded-full transition-colors hover:bg-[var(--bg-tertiary)] [padding:3px_9px] [border:1px_solid_var(--border-default)] [background:var(--bg-card)]! [color:var(--text-secondary)]">
                            {t(p.labelKey, p.labelFallback)}
                        </button>
                    ))}
                </div>
            ) : (
                <div ref={scrollRef} className="overflow-y-auto flex flex-col gap-1.5 max-h-[220px]">
                    {thread.map((m, i) => (
                        <div key={i} className="text-[12px] leading-relaxed rounded-lg px-3 py-2 max-w-[92%]"
                            style={m.role === 'user'
                                ? { alignSelf: 'flex-end', background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--text-primary)' }
                                : { alignSelf: 'flex-start', background: 'var(--bg-card)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                            {m.role === 'tutor' ? <MarkdownRenderer content={m.text} /> : m.text}
                        </div>
                    ))}
                    {busy && (
                        <div className="self-start inline-flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                            <Loader2 className="animate-spin w-[12px] h-[12px]" /> {t('learn.tutor.thinking', 'Thinking…')}
                        </div>
                    )}
                </div>
            )}

            <form className="flex items-center gap-2 rounded-lg [padding:7px_10px] [border:1px_solid_var(--border-default)] [background:var(--bg-card)]"
                onSubmit={(e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); ask(input); }}>
                <input
                    value={input}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
                    placeholder={t('learn.tutor.placeholder_step', 'Ask a question about this step…')}
                    aria-label={t('learn.tutor.title', 'Ask the AI coach')}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[12px] [color:var(--text-primary)]!"
                />
                <button type="submit" disabled={busy || !input.trim()} aria-label={t('learn.tutor.send', 'Send')}
                    className="grid place-items-center transition-opacity disabled:opacity-40 text-[var(--text-tertiary)]">
                    <CornerDownLeft className="w-[12px] h-[12px]" />
                </button>
            </form>
        </div>
    );
}
