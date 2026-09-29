import { AlertTriangle, Loader2, Minus, Plus } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { ColumnKindIcon } from '../ColumnKind';
import { columnTypeKind, ssErrorMessage } from '../datatableDisplay';
import { TypeSelect } from '../NewDatatableDialog';
import { HEADER_ROW_MAX, HEADER_ROW_MIN, INFERABLE_TYPES, keyColumnEligible, sheetLabelOf } from './wizardState';
import useDebouncedValue from '../../../../../hooks/useDebouncedValue';

/**
 * One sheet that will become a table: its header row, the first rows as
 * the file has them, every column with the type it will arrive as, and
 * the choice of what makes a row THAT row.
 *
 * `s` is the dialog's selection entry (columns included — the editable
 * copy); `describe` is the sheet's describe at the CURRENT header row,
 * which is where the preview, the key candidates and the server's warnings
 * come from. While the two are out of step (the header row just moved) the
 * section says it is reading, and the dialog keeps Next off.
 *
 * ── THE HEADER ROW IS DEBOUNCED HERE ────────────────────────────────
 * The stepper edits a local draft; 300 ms after the last change the
 * settled value reaches the selection, and the dialog reads the sheet
 * again at that row. Typing "12" must not read the sheet at row 1 first.
 * Type choices the person made survive the re-read where the column is
 * still the same one (wizardState.mergeColumns).
 *
 * ── ROW NUMBER BY DEFAULT ───────────────────────────────────────────
 * The radio opens on "Row number" — it always works. A key column is
 * offered only where the server found the column unique over the whole
 * sheet (keyCandidates) and it is still text or number; the others are
 * shown, switched off, with the one word that says why. The help line
 * under it is what makes an automation author pick the key column anyway.
 */
export default function SheetSection({ t, s, describe, mark, onChange }) {
    const d = describe || { loading: true, error: null, data: null };
    const data = d.data;
    const columns = s.columns || [];
    const keyCandidates = (data && data.keyCandidates) || [];
    const preview = (data && data.sheet && data.sheet.preview && data.sheet.preview.rows) || [];
    const dupKeys = columns.filter(c => c.duplicateHeader).map(c => c.key);
    const blank = columns.filter(c => c.blankHeader).length;
    // Retyping the key column to something that cannot identify a row (a
    // date, a checkbox) drops it back to the row number — the radio it
    // would leave checked is the disabled one.
    const setType = (col, type) => {
        const next = columns.map(c => (c.col === col ? { ...c, type, typeTouched: true } : c));
        const keyCol = next.find(c => c.col === s.keyColumn);
        onChange(s.sheetKey, { columns: next, ...(keyCol && !keyColumnEligible(keyCol, keyCandidates).ok ? { keyColumn: null } : {}) });
    };
    const setKey = (keyColumn) => onChange(s.sheetKey, { keyColumn });
    // A csv has no sheet (null on the wire); the file name stands in for it.
    const sheetLabel = s.sheetLabel ?? sheetLabelOf(s.sheet, s.fileName);

    return (
        <section className="p-3 space-y-3 rounded-lg" style={{ background: 'var(--bg-secondary)' }} aria-label={`${sheetLabel} — ${s.fileName}`}>
            <div className="flex items-center gap-3 flex-wrap">
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{sheetLabel}</span>
                <HeaderRowStepper t={t} sheet={sheetLabel} value={s.headerRow} onSettle={(headerRow) => onChange(s.sheetKey, { headerRow })} />
                {(d.loading || !data) && !d.error && (
                    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />{t('datatables.nc_reading', 'Reading the columns…')}
                    </span>
                )}
            </div>
            {d.error && (
                <p role="alert" className="text-[11px]" style={{ color: 'var(--warning)' }}>{ssErrorMessage(t, d.error) || d.error.message}</p>
            )}
            {mark && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{mark}</p>}
            {preview.length > 0 && <Preview t={t} sheet={sheetLabel} rows={preview} />}
            {columns.length > 0 && (
                <ul className="space-y-1.5" role="list" aria-label={t('datatables.ss_columns_list', 'Columns of {sheet}', { sheet: sheetLabel })}>
                    {columns.map((c) => (
                        <li key={c.col} className="grid gap-2 items-center" style={{ gridTemplateColumns: 'minmax(0,1fr) 150px' }}>
                            <span className="min-w-0 flex flex-col gap-0.5">
                                <span className="inline-flex items-center gap-1.5 min-w-0 text-xs">
                                    <ColumnKindIcon kind={columnTypeKind(c.type)} size={12} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                                    <span className="truncate" style={{ color: 'var(--text-primary)' }}>
                                        {c.blankHeader ? t('datatables.ss_blank_header', '(no header) → {key}', { key: c.key }) : c.header}
                                    </span>
                                    <code className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-tertiary)' }}>{c.letter || ''}{c.letter ? ' · ' : ''}{c.key}</code>
                                    {c.formula && (
                                        <span className="text-[10px] px-1.5 rounded shrink-0" style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}>
                                            {t('datatables.ss_formula_col', 'formula · read-only')}
                                        </span>
                                    )}
                                </span>
                                {Array.isArray(c.samples) && c.samples.length > 0 && (
                                    <span className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                                        {t('datatables.ss_samples', 'e.g. {samples}', { samples: c.samples.slice(0, 3).map(v => String(v)).join(', ') })}
                                    </span>
                                )}
                            </span>
                            <TypeSelect t={t} value={c.type} onChange={(type) => setType(c.col, type)} types={INFERABLE_TYPES}
                                ariaLabel={`${t('datatables.ss_type_of', 'Type of')} ${c.blankHeader ? c.key : c.header}`} />
                        </li>
                    ))}
                </ul>
            )}
            {columns.length > 0 && (
                <fieldset className="space-y-1">
                    <legend className="text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('datatables.ss_identity_legend', 'How to recognise a row')}</legend>
                    <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                        <input type="radio" name={`identity:${s.sheetKey}`} checked={s.keyColumn === null} onChange={() => setKey(null)}
                            aria-label={t('datatables.ss_identity_rownum_option', 'Row number (default)')} />
                        {t('datatables.ss_identity_rownum_option', 'Row number (default)')}
                    </label>
                    {columns.map((c) => {
                        const e = keyColumnEligible(c, keyCandidates);
                        const title = c.blankHeader ? c.key : c.header;
                        return (
                            <label key={c.col} className={`flex items-center gap-2 text-xs ${e.ok ? 'cursor-pointer' : 'cursor-not-allowed'}`} style={{ color: 'var(--text-primary)', opacity: e.ok ? 1 : 0.6 }}>
                                <input type="radio" name={`identity:${s.sheetKey}`} checked={s.keyColumn === c.col} disabled={!e.ok} onChange={() => setKey(c.col)} aria-label={title} />
                                <span>{title}</span>
                                {!e.ok && <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{reasonWord(t, e.reason)}</span>}
                            </label>
                        );
                    })}
                    <p className="text-[11px] pt-1" style={{ color: 'var(--text-tertiary)' }}>
                        {t('datatables.ss_identity_help', 'A key column keeps a row’s identity when rows are inserted or sorted in the sheet; with the row number, inserting a row above shifts the rows below.')}
                    </p>
                </fieldset>
            )}
            {(dupKeys.length > 0 || blank > 0 || (data && data.warnings && data.warnings.length > 0)) && (
                <ul className="space-y-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {dupKeys.length > 0 && <Warning text={t('datatables.ss_warn_dup_headers', 'Duplicate headers get a number: {keys}.', { keys: dupKeys.join(', ') })} />}
                    {blank > 0 && <Warning text={t('datatables.ss_warn_blank_headers', '{n} columns have no header and are named by their letter.', { n: blank })} />}
                    {((data && data.warnings) || []).map((w, i) => <Warning key={i} text={w} />)}
                </ul>
            )}
        </section>
    );
}

/** The one word beside a key-column radio that is off. */
function reasonWord(t, reason) {
    switch (reason) {
        case 'no_header': return t('datatables.ss_key_no_header', 'no header');
        case 'type': return t('datatables.ss_key_type', 'only text or number');
        default: return t('datatables.ss_key_repeats', 'values repeat');
    }
}

function Warning({ text }) {
    return (
        <li className="flex items-start gap-1.5">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
            <span>{text}</span>
        </li>
    );
}

function HeaderRowStepper({ t, sheet, value, onSettle }) {
    const [draft, setDraft] = useState(value);
    const settled = useDebouncedValue(draft, 300);
    const clamp = (n) => Math.min(HEADER_ROW_MAX, Math.max(HEADER_ROW_MIN, n));
    useEffect(() => {
        if (Number.isInteger(settled) && settled !== value) onSettle(settled);
    }, [settled, value, onSettle]);
    const label = t('datatables.ss_header_row', 'Header row');
    return (
        <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span>{label}</span>
            <button type="button" onClick={() => setDraft(d => clamp((Number(d) || 1) - 1))} aria-label={t('datatables.ss_header_dec', 'One row up')}
                className="p-0.5 rounded border" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                <Minus className="w-3 h-3" aria-hidden="true" />
            </button>
            <input type="number" min={HEADER_ROW_MIN} max={HEADER_ROW_MAX} value={draft}
                onChange={(e) => { const n = parseInt(e.target.value, 10); setDraft(Number.isInteger(n) ? clamp(n) : e.target.value); }}
                aria-label={`${label} — ${sheet}`}
                className="w-12 px-1.5 py-0.5 rounded border text-center text-xs"
                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }} />
            <button type="button" onClick={() => setDraft(d => clamp((Number(d) || 1) + 1))} aria-label={t('datatables.ss_header_inc', 'One row down')}
                className="p-0.5 rounded border" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                <Plus className="w-3 h-3" aria-hidden="true" />
            </button>
        </span>
    );
}

/** The header row and up to five below it, as the file has them. */
function Preview({ t, sheet, rows }) {
    return (
        <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-primary)' }}>
            <table className="text-[11px] w-full">
                <caption className="sr-only">{t('datatables.ss_preview_caption', 'First rows of {sheet}', { sheet })}</caption>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i} style={i === 0 ? { fontWeight: 600, color: 'var(--text-primary)' } : { color: 'var(--text-secondary)' }}>
                            {(r || []).map((v, j) => (i === 0
                                ? <th key={j} scope="col" className="px-2 py-1 text-left whitespace-nowrap max-w-[160px] truncate" style={{ borderBottom: '1px solid var(--border-default)' }}>{previewText(v)}</th>
                                : <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[160px] truncate">{previewText(v)}</td>))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function previewText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}
