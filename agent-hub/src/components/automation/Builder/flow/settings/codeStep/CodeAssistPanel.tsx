// The assistant tab of the large code editor: ask for code in plain words,
// get it written, changed or trimmed, and keep or undo each turn.
import { Check, Loader2, RotateCcw, Send, Sparkles, Square } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import type { AssistTurn } from './useCodeAssistChat';

interface CodeAssistPanelProps {
    turns: AssistTurn[];
    busy: boolean;
    codeIsEmpty: boolean;
    onSend: (text: string) => void;
    onStop: () => void;
    onKeep: (id: number) => void;
    onUndo: (id: number) => void;
    /** Text put in the box from outside ("Fix with Bee"). */
    prefill?: { text: string; nonce: number } | null;
}

const STARTERS: Array<[string, string]> = [
    ['code_step.assist.starter.vat', 'Add 21% VAT to an amount and round it to cents'],
    ['code_step.assist.starter.dates', 'Work out the due date: the invoice date plus 30 days'],
    ['code_step.assist.starter.clean', 'Clean up a list of rows: trim the names and drop empty ones'],
];

function TurnView({ turn, last, onKeep, onUndo }: { turn: AssistTurn; last: boolean; onKeep: (id: number) => void; onUndo: (id: number) => void }) {
    const { t } = useTranslation();
    const changed = turn.after != null;
    return (
        <li className="space-y-2" data-testid="assist-turn">
            <div className="ml-8 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm whitespace-pre-wrap">{turn.ask}</div>
            <div className="space-y-2 text-sm">
                {turn.reply && <p className="whitespace-pre-wrap text-[var(--text-primary)]">{turn.reply}</p>}
                {turn.status === 'streaming' && !turn.reply && (
                    <p className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]"><Loader2 size={13} className="animate-spin" aria-hidden="true" />{t('code_step.assist.working', 'Working on it…')}</p>
                )}
                {turn.edits.length > 0 && (
                    <ul className="space-y-1" aria-label={t('code_step.assist.edits', 'What changed')}>
                        {turn.edits.map((e, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                                <span className="mt-0.5 rounded bg-[var(--bg-tertiary)] px-1.5 font-mono text-[10px] uppercase">{e.op}</span>
                                <span>{e.summary}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {turn.error && <p className="text-xs text-[var(--error)]">{turn.error}</p>}
                {turn.status === 'stopped' && <p className="text-xs text-[var(--text-secondary)]">{t('code_step.assist.stopped', 'Stopped. Your code is unchanged.')}</p>}
                {changed && turn.decision == null && turn.status !== 'streaming' && (
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={() => onKeep(turn.id)} className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-primary)] px-2.5 py-1 text-xs font-medium text-[var(--accent-primary-fg)]">
                            <Check size={12} aria-hidden="true" />{t('code_step.assist.keep', 'Keep')}
                        </button>
                        <button type="button" onClick={() => onUndo(turn.id)} disabled={!last} title={last ? undefined : t('code_step.assist.undo_later', 'Undo the newer changes first')} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2.5 py-1 text-xs font-medium disabled:opacity-40">
                            <RotateCcw size={12} aria-hidden="true" />{t('code_step.assist.undo', 'Undo')}
                        </button>
                    </div>
                )}
                {turn.decision === 'undone' && <p className="text-xs text-[var(--text-secondary)]">{t('code_step.assist.undone', 'Undone: the code is back as it was.')}</p>}
            </div>
        </li>
    );
}

export default function CodeAssistPanel({ turns, busy, codeIsEmpty, onSend, onStop, onKeep, onUndo, prefill = null }: CodeAssistPanelProps) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const listRef = useRef<HTMLUListElement | null>(null);
    const boxRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        if (!prefill) return;
        setText(prefill.text);
        boxRef.current?.focus();
    }, [prefill]);
    useEffect(() => {
        const el = listRef.current;
        if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight });
    }, [turns]);

    const submit = () => {
        if (!text.trim() || busy) return;
        onSend(text);
        setText('');
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    };
    const lastChanged = [...turns].reverse().find((x) => x.after != null && x.decision !== 'undone');

    return (
        <div className="flex h-full min-h-0 flex-col" data-testid="code-assist-panel">
            <ul ref={listRef} className="flex-1 min-h-0 space-y-4 overflow-auto p-3 custom-scrollbar">
                {turns.length === 0 && (
                    <li className="space-y-3 text-sm text-[var(--text-secondary)]">
                        <p className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]"><Sparkles size={14} aria-hidden="true" />{t('code_step.assist.intro_title', 'Bee writes the code with you')}</p>
                        <p>{t('code_step.assist.intro', 'Say what the step should do. Bee writes it, changes parts of it or removes what you no longer need, and describes every input so the form fills itself.')}</p>
                        {codeIsEmpty && (
                            <div className="flex flex-col gap-1.5">
                                {STARTERS.map(([key, english]) => (
                                    <button key={key} type="button" onClick={() => onSend(t(key, english))} disabled={busy} className="rounded-md border border-[var(--border-subtle)] px-2.5 py-1.5 text-left text-xs hover:bg-[var(--bg-tertiary)]">
                                        {t(key, english)}
                                    </button>
                                ))}
                            </div>
                        )}
                    </li>
                )}
                {turns.map((turn) => <TurnView key={turn.id} turn={turn} last={turn === lastChanged} onKeep={onKeep} onUndo={onUndo} />)}
            </ul>
            <div className="border-t border-[var(--border-subtle)] p-2">
                <div className="flex items-end gap-2">
                    <textarea
                        ref={boxRef}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={onKeyDown}
                        rows={2}
                        aria-label={t('code_step.assist.input', 'Ask Bee about this code')}
                        placeholder={codeIsEmpty ? t('code_step.assist.placeholder_empty', 'Write code that…') : t('code_step.assist.placeholder', 'Change, explain or fix this code…')}
                        className="flex-1 resize-none rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent-primary)]"
                    />
                    {busy ? (
                        <button type="button" onClick={onStop} aria-label={t('code_step.assist.stop', 'Stop')} className="grid h-8 w-8 place-items-center rounded-md border border-[var(--border-subtle)]"><Square size={13} aria-hidden="true" /></button>
                    ) : (
                        <button type="button" onClick={submit} disabled={!text.trim()} aria-label={t('code_step.assist.send', 'Send')} className="grid h-8 w-8 place-items-center rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-40"><Send size={13} aria-hidden="true" /></button>
                    )}
                </div>
            </div>
        </div>
    );
}
