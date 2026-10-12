// The small floating box of the inline "Ask AI": one line to type the
// question, a spinner with Stop while it works, then a one-line result with
// Undo and "Open in panel". No menus.

import { CornerDownLeft, Loader2, Sparkles, Square } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { firstSentence } from './sheetAskText';
import type { SheetAsk } from './useSheetAsk';

const LINK = 'shrink-0 text-[12px] font-medium text-[var(--accent-primary)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] rounded-sm';
const ICON = 'shrink-0 text-[var(--accent-primary)]';

/** Escape and a click elsewhere dismiss a finished result (and an empty prompt). */
function useDismiss(box: React.RefObject<HTMLElement | null>, ask: SheetAsk) {
    const { phase, close, text } = ask;
    useEffect(() => {
        if (phase !== 'result' && !(phase === 'input' && !text)) return undefined;
        const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(false); };
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close(true);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey, true);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
    }, [phase, text, close, box]);
}

function Prompt({ ask, readOnly }: { ask: SheetAsk; readOnly: boolean }) {
    const { t } = useTranslation();
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => { input.current?.focus(); }, [ask.openCount]);
    const range = ask.snapshot?.label ?? '';
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); ask.submit(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') e.preventDefault();
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ask.close(true); }
    };
    return (
        <>
            <div className="flex items-center gap-2">
                <Sparkles size={14} aria-hidden="true" className={ICON} />
                <input
                    ref={input} value={ask.text} onChange={(e) => ask.setText(e.target.value)} onKeyDown={onKeyDown}
                    maxLength={4000} spellCheck={false} autoComplete="off"
                    aria-label={t('spreadsheet.ask.input_label', 'Ask AI about the selection')}
                    placeholder={readOnly
                        ? t('spreadsheet.ask.placeholder_read_only', 'Ask AI about {range} — e.g. explain this, find outliers', { range })
                        : t('spreadsheet.ask.placeholder', 'Ask AI about {range} — e.g. add a total, a % of total column, fix errors', { range })}
                    className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                />
                <button
                    type="button" onClick={ask.submit} disabled={!ask.text.trim()}
                    aria-label={t('spreadsheet.ask.send', 'Send')} title={t('spreadsheet.ask.send', 'Send')}
                    className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-40"
                >
                    <CornerDownLeft size={12} aria-hidden="true" />
                </button>
            </div>
            {ask.error && <p role="alert" className="m-0 pt-1 pl-6 text-[12px] text-[var(--error)]">{ask.error}</p>}
        </>
    );
}

function Working({ ask }: { ask: SheetAsk }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2" role="status">
            <Loader2 size={14} aria-hidden="true" className={`${ICON} animate-spin`} />
            <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-secondary)]">
                {t('spreadsheet.ask.working', 'Working on {range}…', { range: ask.snapshot?.label ?? '' })}
            </span>
            <button type="button" onClick={ask.stop} className={`${LINK} inline-flex items-center gap-1`}>
                <Square size={10} aria-hidden="true" />{t('spreadsheet.ask.stop', 'Stop')}
            </button>
        </div>
    );
}

function Result({ ask }: { ask: SheetAsk }) {
    const { t } = useTranslation();
    const { result } = ask;
    if (!result) return null;
    return (
        <div className="flex items-center gap-1.5" role="status" aria-label={t('spreadsheet.ask.result', 'AI result')}>
            <Sparkles size={14} aria-hidden="true" className={ICON} />
            <span className="flex-1 min-w-0 line-clamp-2 text-[13px] leading-snug text-[var(--text-primary)]" title={result.reply}>{firstSentence(result.reply)}</span>
            {result.changed && (
                <>
                    <span aria-hidden="true" className="text-[var(--text-tertiary)]">·</span>
                    {result.undone
                        ? <span className="shrink-0 text-[12px] text-[var(--text-tertiary)]">{t('spreadsheet.ask.undone', 'Undone')}</span>
                        : <button type="button" onClick={ask.undo} className={LINK}>{t('spreadsheet.ask.undo', 'Undo')}</button>}
                </>
            )}
            <span aria-hidden="true" className="text-[var(--text-tertiary)]">·</span>
            <button type="button" onClick={ask.openPanel} className={`${LINK} whitespace-nowrap`}>{t('spreadsheet.ask.open_panel', 'Open in panel')}</button>
        </div>
    );
}

export interface SheetAskBoxProps {
    ask: SheetAsk;
    readOnly: boolean;
    /** Position classes (they read the --sel-* variables of the layer). */
    position: string;
}

export default function SheetAskBox({ ask, readOnly, position }: SheetAskBoxProps) {
    const box = useRef<HTMLDivElement>(null);
    useDismiss(box, ask);
    useEffect(() => { box.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [ask.phase]);
    return (
        <div
            ref={box} data-testid="sheet-ask-box"
            className={`absolute pointer-events-auto w-[26rem] max-w-[90vw] rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg px-2.5 py-2 ${position}`}
        >
            {ask.phase === 'input' && <Prompt ask={ask} readOnly={readOnly} />}
            {ask.phase === 'working' && <Working ask={ask} />}
            {ask.phase === 'result' && <Result ask={ask} />}
        </div>
    );
}
