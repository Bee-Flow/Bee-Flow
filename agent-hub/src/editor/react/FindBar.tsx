/**
 * FindBar — find (and, for editors, replace) in the document.
 *
 * Matches come from the document model (engine/find.ts), are painted with
 * the highlight layer (never by touching the editor's DOM) and follow the
 * document as it changes — including co-editors' typing. Enter / Shift+Enter
 * step through them, Escape closes and puts the caret on the current match.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Replace, X, CaseSensitive } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { findMatches, matchIndexFrom, replaceMatches, type FindMatch } from '../engine/find';
import { textSelection, pos, isText, selRange } from '../engine/selection.js';
import RangeOverlay from './RangeOverlay';

interface Props {
    view: any;
    editable: boolean;
    /** Changes after every document render. */
    tick: number;
    /** Where the highlight fallback is drawn (the host's positioned wrapper). */
    container: HTMLElement | null;
    /** Bumped by the editor when Ctrl/⌘+F is pressed again while open. */
    focusSignal: number;
    onClose: () => void;
}

interface BarButtonProps {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    pressed?: boolean;
    expanded?: boolean;
    children: ReactNode;
}

/** An icon button of the bar; its label is both the accessible name and the tooltip. */
function BarButton({ label, onClick, disabled, pressed, expanded, children }: BarButtonProps) {
    return (
        <button
            type="button"
            className={`bf-icon-button ${pressed ? 'bf-icon-button--active' : ''}`}
            onClick={onClick}
            disabled={disabled}
            aria-pressed={pressed}
            aria-expanded={expanded}
            aria-label={label}
            title={label}
        >
            {children}
        </button>
    );
}

interface ReplaceRowProps {
    value: string;
    onChange: (v: string) => void;
    onReplaceOne: () => void;
    onReplaceAll: () => void;
    onEscape: () => void;
    hasCurrent: boolean;
    hasAny: boolean;
}

/** The replace field and its two buttons (editors only). */
function ReplaceRow({ value, onChange, onReplaceOne, onReplaceAll, onEscape, hasCurrent, hasAny }: ReplaceRowProps) {
    const { t } = useTranslation();
    const replaceId = useId();
    return (
        <div className="flex items-center gap-1 mt-1">
            <label htmlFor={replaceId} className="sr-only">{t('editor.replace_label', 'Replace with')}</label>
            <input
                id={replaceId}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') { e.preventDefault(); onReplaceOne(); } else if (e.key === 'Escape') { e.preventDefault(); onEscape(); }
                }}
                placeholder={t('editor.replace_placeholder', 'Replace with')}
                className="bf-find-input"
            />
            <button type="button" className="bf-text-button" onClick={onReplaceOne} disabled={!hasCurrent}>{t('editor.replace_one', 'Replace')}</button>
            <button type="button" className="bf-text-button" onClick={onReplaceAll} disabled={!hasAny}>{t('editor.replace_all', 'Replace all')}</button>
        </div>
    );
}

/** "2 of 5", "No results", or nothing before anything was typed. */
function countLabel(t: (k: string, f: string, p?: Record<string, unknown>) => string, query: string, total: number, index: number): string {
    if (!query) return '';
    return total ? t('editor.find_count', '{current} of {total}', { current: index + 1, total }) : t('editor.find_none', 'No results');
}

/** The query the bar opens with: the selected text, when it sits in one block. */
function initialQuery(view: any): string {
    const sel = view?.state?.selection;
    if (!isText(sel)) return '';
    const r = selRange(sel) as { from: { path: number[] }; to: { path: number[] } };
    if (r.from.path.join() !== r.to.path.join()) return '';
    try { return String(window.getSelection()?.toString() || '').slice(0, 200); } catch { return ''; }
}

/** Matches of the query in the current document, the current one, and their highlight layers. */
function useFindMatches(view: any, query: string, caseSensitive: boolean, tick: number) {
    const [current, setCurrent] = useState(0);
    // Bumped each time the user moves to a match (a new query, match case,
    // next or previous). Only that scrolls: the document changing under the
    // bar (typing, a caret move, a co-editor) never pulls the page back.
    const [nav, setNav] = useState(0);
    const scrolledNav = useRef(0);
    const matches: FindMatch[] = useMemo(
        () => (view ? findMatches(view.state.doc, query, { caseSensitive }) : []),
        // `tick` is the document-changed signal: view.state is mutable.
        [view, query, caseSensitive, tick],
    );
    const index = matches.length ? Math.min(current, matches.length - 1) : -1;

    // Start from the first match at or after the caret when the query changes.
    useEffect(() => {
        const sel = view?.state?.selection;
        setCurrent(matchIndexFrom(matches, isText(sel) ? (selRange(sel) as any).from : null));
        setNav((n) => n + 1);
    }, [query, caseSensitive]);

    const ranges: Range[] = useMemo(
        () => matches.map((m) => (view ? view.rangeFor(m.from, m.to) : null)).filter(Boolean) as Range[],
        [matches, view],
    );

    // Bring the match the user moved to into view, once per move.
    useEffect(() => {
        if (scrolledNav.current === nav) return;
        scrolledNav.current = nav;
        const r = index >= 0 ? ranges[index] : null;
        const el = r ? (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement) as Element | null : null;
        try { el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); } catch { /* old engines */ }
    }, [nav, index, ranges]);

    const layers = useMemo(() => [
        { name: 'bf-find', ranges: ranges.filter((_, i) => i !== index), className: 'bf-find-rect' },
        { name: 'bf-find-current', ranges: index >= 0 && ranges[index] ? [ranges[index]] : [], className: 'bf-find-current-rect' },
    ], [ranges, index]);

    const step = (delta: number) => {
        if (!matches.length) return;
        setCurrent((i) => (Math.min(i, matches.length - 1) + delta + matches.length) % matches.length);
        setNav((n) => n + 1);
    };
    return { matches, index, layers, step };
}

export default function FindBar({ view, editable, tick, container, focusSignal, onClose }: Props) {
    const { t } = useTranslation();
    const [query, setQuery] = useState(() => initialQuery(view));
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [replaceOpen, setReplaceOpen] = useState(false);
    const [replacement, setReplacement] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const findId = useId();
    const { matches, index, layers, step } = useFindMatches(view, query, caseSensitive, tick);

    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [focusSignal]);

    const close = (selectCurrent: boolean) => {
        const m = index >= 0 ? matches[index] : null;
        onClose();
        if (selectCurrent && m && view) {
            view.focus();
            view.dispatch((s: any) => ({ ...s, selection: textSelection(pos(m.from.path, m.from.offset), pos(m.to.path, m.to.offset)) }), { kind: 'selection' });
        }
    };

    /** Replace the current match, or all of them, as one undoable step. */
    const replace = (all: boolean) => {
        const targets = all ? matches : (index >= 0 ? [matches[index]] : []);
        if (!editable || !targets.length) return;
        view.dispatch((s: any) => replaceMatches(s, targets, replacement), { kind: 'structural' });
    };
    const count = countLabel(t, query, matches.length, index);

    return (
        <div className="bf-find-dock">
            <div className="bf-find-bar" role="search" aria-label={t('editor.find_label', 'Find in document')}>
                <div className="flex items-center gap-1">
                    {editable && (
                        <BarButton label={t('editor.find_toggle_replace', 'Show replace')} expanded={replaceOpen} onClick={() => setReplaceOpen((o) => !o)}>
                            <Replace className="w-3.5 h-3.5" aria-hidden="true" />
                        </BarButton>
                    )}
                    <label htmlFor={findId} className="sr-only">{t('editor.find_label', 'Find in document')}</label>
                    <input
                        id={findId}
                        ref={inputRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); close(true); }
                            else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.currentTarget.select(); }
                        }}
                        placeholder={t('editor.find_placeholder', 'Find')}
                        className="bf-find-input"
                    />
                    <span className="text-[10px] tabular-nums min-w-[52px] text-right text-[var(--text-tertiary)]" aria-live="polite">{count}</span>
                    <BarButton label={t('editor.find_match_case', 'Match case')} pressed={caseSensitive} onClick={() => setCaseSensitive((c) => !c)}>
                        <CaseSensitive className="w-3.5 h-3.5" aria-hidden="true" />
                    </BarButton>
                    <BarButton label={t('editor.find_previous', 'Previous match')} disabled={!matches.length} onClick={() => step(-1)}>
                        <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                    </BarButton>
                    <BarButton label={t('editor.find_next', 'Next match')} disabled={!matches.length} onClick={() => step(1)}>
                        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                    </BarButton>
                    <BarButton label={t('editor.find_close', 'Close find')} onClick={() => close(false)}>
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </BarButton>
                </div>
                {editable && replaceOpen && (
                    <ReplaceRow
                        onReplaceOne={() => replace(false)}
                        onReplaceAll={() => replace(true)}
                        onEscape={() => close(true)}
                        hasCurrent={index >= 0}
                        hasAny={matches.length > 0}
                        value={replacement}
                        onChange={setReplacement}
                    />
                )}
                {container && createPortal(<RangeOverlay layers={layers} container={container} tick={tick} />, container)}
            </div>
        </div>
    );
}
