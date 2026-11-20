// The bar above the grid: the name of the selected cell and its raw content
// (the formula, not the result). Typing here edits the same draft as typing in
// the cell. While a formula is being typed, the functions that match the word
// under the cursor are offered, and in a Dutch sheet a line says that ; works
// between arguments and that function names stay English.

import React, { useMemo, useRef } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { functionNames } from './sheetEngine';
import type { GridState } from './useGridState';

export interface FormulaBarProps {
    grid: GridState;
    readOnly: boolean;
    /** The edit ended with a key: give focus back to the grid. */
    onDone: () => void;
    /** How the sheet reads typed numbers; 'nl' shows the separator hint while a formula is typed. */
    locale?: 'nl' | 'en';
}

const MAX_HINTS = 6;

export default function FormulaBar({ grid, readOnly, onDone, locale = 'en' }: FormulaBarProps) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);
    const { editing, actions } = grid;
    const value = editing ? editing.draft : grid.activeRaw;
    const functions = useMemo(() => functionNames(), []);

    const formulaDraft = editing && editing.draft.startsWith('=') ? editing.draft : null;
    const typingFormula = formulaDraft !== null;
    const word = formulaDraft !== null ? /[A-Za-z][A-Za-z0-9.]*$/.exec(formulaDraft)?.[0] ?? '' : '';
    const hints = word ? functions.filter((f) => f.startsWith(word.toUpperCase()) && f !== word.toUpperCase()).slice(0, MAX_HINTS) : [];

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); if (editing) actions.commit('down'); onDone(); }
        else if (e.key === 'Escape') { e.preventDefault(); actions.cancel(); onDone(); }
    };
    const insert = (fn: string) => {
        if (!editing) return;
        actions.setDraft(`${editing.draft.slice(0, editing.draft.length - word.length)}${fn}(`, 'bar');
        inputRef.current?.focus();
    };

    return (
        <div className="shrink-0 border-b border-[var(--border-default)] bg-[var(--bg-primary)]" data-testid="formula-bar">
            <div className="flex items-center gap-2 px-3 py-1.5">
                <span
                    className="w-14 shrink-0 text-center text-[12px] font-medium rounded px-1 py-1 bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                    aria-label={t('spreadsheet.name_box', 'Selected cell')} role="status" data-testid="formula-bar-cell"
                >
                    {grid.activeName}
                </span>
                <span className="shrink-0 text-[12px] italic text-[var(--text-tertiary)]" title={functions.join(', ')} aria-hidden="true">fx</span>
                <input
                    ref={inputRef} value={value} readOnly={readOnly} spellCheck={false} autoComplete="off"
                    aria-label={t('spreadsheet.formula_bar', 'Formula bar')}
                    onChange={(e) => actions.setDraft(e.target.value, 'bar')}
                    onKeyDown={onKeyDown}
                    onBlur={() => { if (editing?.origin === 'bar') actions.commit('none'); }}
                    className="flex-1 min-w-0 px-2 py-1 text-[13px] font-mono rounded border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
                />
            </div>
            {typingFormula && locale === 'nl' && (
                <p className="px-3 pb-1.5 m-0 text-[11px] text-[var(--text-tertiary)]" data-testid="formula-bar-separator-hint">
                    {t('doc_formulas.separator_hint', 'Use ; or , between arguments; function names are English (SUM, AVERAGE).')}
                </p>
            )}
            {hints.length > 0 && (
                <ul className="flex flex-wrap gap-1 px-3 pb-1.5 m-0 list-none" aria-label={t('spreadsheet.functions', 'Functions')}>
                    {hints.map((fn) => (
                        <li key={fn}>
                            <button
                                type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(fn)}
                                className="px-2 py-0.5 rounded text-[11px] font-mono bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                            >
                                {fn}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
