import React, { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Sparkles, Undo2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import type { StyleAssist, StyleAssistAnswer } from '@/api/formStyleAssist';
import { RemovedWarning } from './CustomCssEditor';
import type { Style, Theme } from './stylePresets';

const PROMPT_MAX = 2000;

interface Props {
    /** Absent when there is no saved automation to ask about yet. */
    assist?: StyleAssist | null;
    theme: Theme;
    style: Style | undefined;
    customCss: string;
    /** Puts CSS into the Custom CSS field (and so into the preview). */
    onCss: (css: string) => void;
}

/**
 * "Describe the look": the owner says what the form should feel like, the
 * model answers with CSS, and that lands in the Custom CSS field and the live
 * preview at once. Nothing runs on the server; the author keeps it, edits it,
 * or presses Undo to get the CSS from before the answer back.
 */
export default function DescribeLookPanel({ assist, theme, style, customCss, onCss }: Props) {
    const { t } = useTranslation();
    const id = useId();
    const [prompt, setPrompt] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [answer, setAnswer] = useState<StyleAssistAnswer | null>(null);
    // The CSS from before the last answer; null when there is nothing to undo.
    const [previous, setPrevious] = useState<string | null>(null);
    // The answer arrives later than the click: write through the newest handler,
    // or an edit made while waiting would be overwritten by an old form.
    const onCssRef = useRef(onCss);
    useEffect(() => { onCssRef.current = onCss; });

    const ask = async () => {
        if (!assist || busy || !prompt.trim()) return;
        setBusy(true);
        setError(null);
        try {
            const { customCss: _css, ...rest } = style || {};
            const next = await assist({ prompt: prompt.trim(), theme, style: Object.keys(rest).length ? rest : null, customCss: customCss || null });
            setPrevious(customCss);
            setAnswer(next);
            onCssRef.current(next.css);
        } catch (err) {
            setError(messageOf(err, t('forms.style.ai_failed', 'The AI could not style this form. Please try again.')));
        } finally {
            setBusy(false);
        }
    };

    const undo = () => {
        if (previous === null) return;
        onCssRef.current(previous);
        setPrevious(null);
        setAnswer(null);
    };

    return (
        <div className="space-y-1.5 rounded-md border border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] p-2" data-testid="form-style-describe">
            <label htmlFor={`${id}-prompt`} className="block text-[11px] font-medium text-[var(--text-primary)]">{t('forms.style.describe', 'Describe the look')}</label>
            <textarea
                id={`${id}-prompt`}
                rows={2}
                value={prompt}
                maxLength={PROMPT_MAX}
                placeholder={t('forms.style.describe_placeholder', 'For example: a warm bakery feel, bigger inputs, a dark glass card')}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value)}
                className="w-full px-2 py-1 rounded-md text-xs border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
            />
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={ask}
                    disabled={!assist || busy || !prompt.trim()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
                >
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {busy ? t('forms.style.asking', 'Asking…') : t('forms.style.ask_ai', 'Ask AI')}
                </button>
                {previous !== null ? (
                    <button
                        type="button"
                        onClick={undo}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <Undo2 size={12} /> {t('forms.style.undo', 'Undo')}
                    </button>
                ) : null}
            </div>
            {!assist ? (
                <p className="text-[10px] text-[var(--text-tertiary)]">{t('forms.style.ai_unavailable', 'Save the automation first to ask the AI for a look.')}</p>
            ) : null}
            {error ? <p className="text-[11px] text-[var(--error)]" role="alert">{error}</p> : null}
            {answer ? <AnswerNotes answer={answer} /> : null}
        </div>
    );
}

/** What the model said it did, and what the server took out of its CSS. */
function AnswerNotes({ answer }: { answer: StyleAssistAnswer }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1" data-testid="form-style-ai-answer">
            <p className="text-[10px] text-[var(--text-tertiary)]">{t('forms.style.ai_applied', 'The CSS is in the field below and in the preview.')}</p>
            {answer.notes.length ? (
                <ul className="list-disc pl-4 text-[11px] leading-snug text-[var(--text-secondary)]">
                    {answer.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
            ) : null}
            <RemovedWarning removed={answer.removed} title={t('forms.style.ai_removed', 'Taken out of the AI\'s answer:')} testId="form-style-ai-removed" />
        </div>
    );
}
