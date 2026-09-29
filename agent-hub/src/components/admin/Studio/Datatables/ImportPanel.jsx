import { AlertTriangle, ArrowRight, ClipboardPaste, Loader2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import {
    buildImportRows, importableFields, parsePasted, suggestMapping,
} from '../AppStudio/tables/spreadsheetPaste';

/**
 * Datatables — "paste from a spreadsheet".
 *
 * The PARSING is App Studio's, unchanged and shared on purpose: sniffing tab
 * vs semicolon vs comma (a .csv saved on a Dutch machine is semicolon-
 * separated), the quoting rules Excel actually writes, ja/nee → true/false, and
 * "1.234,56" and "1,234.56" as the same amount. Re-deriving any of that here
 * would be a second implementation to get wrong.
 *
 * What is NOT shared is the sending. App Studio's PasteImportPanel posts one
 * row at a time because the app data API has no bulk endpoint; datatables do,
 * so the whole file goes in ONE request that answers with per-row errors and
 * their line numbers. A thousand rows is one round trip against a 120/minute
 * rate limit instead of a thousand.
 */

const PREVIEW_ROWS = 5;
const NO_IMPORT = '';

const SELECT_CLS = 'rounded-md px-2 py-1 text-xs border bg-[var(--bg-tertiary)] '
    + 'border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none '
    + 'focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] focus:border-[var(--accent-primary)]';

const PLACEHOLDER = 'Name;Email;Starts on\nAnna de Vries;anna@example.com;14-03-2026';

function Button({ children, onClick, disabled, primary = false, className = '' }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${primary ? '' : 'border hover:bg-[var(--bg-tertiary)]'} ${className}`}
            style={primary
                ? { background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)', outlineColor: 'var(--accent-primary)' }
                : { borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
        >
            {children}
        </button>
    );
}

export default function ImportPanel({ columns, onImport, onDone, onClose }) {
    const { t } = useTranslation();
    const fields = useMemo(() => importableFields(columns), [columns]);
    const [text, setText] = useState('');
    const parsed = useMemo(() => parsePasted(text), [text]);
    const headerKey = parsed.header.join('\u0000');
    const [mapping, setMapping] = useState(() => suggestMapping(parsed.header, fields));
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);

    // A fresh paste re-matches from scratch; editing the mapping afterwards is
    // the person's business.
    const [matched, setMatched] = useState({ headerKey, fields });
    if (matched.headerKey !== headerKey || matched.fields !== fields) {
        setMatched({ headerKey, fields });
        setMapping(suggestMapping(parsed.header, fields));
        setResult(null);
        setError(null);
    }

    const built = useMemo(() => buildImportRows(parsed, mapping, fields), [parsed, mapping, fields]);
    const mappedCount = mapping.filter(k => k !== NO_IMPORT).length;

    // One field per column: picking a field already used elsewhere MOVES it,
    // rather than quietly writing two columns into the same one.
    const setColumn = (index, fieldKey) => {
        setMapping(cur => cur.map((k, i) => {
            if (i === index) return fieldKey;
            return fieldKey !== NO_IMPORT && k === fieldKey ? NO_IMPORT : k;
        }));
    };

    const start = async () => {
        // Rows the CLIENT could not convert (a date that is not a date, a
        // choice that is not one of the choices) never leave the browser — but
        // they are reported by the same line number the server uses, so the two
        // halves of the answer read as one list.
        const local = built
            .filter(r => r.problems.length > 0)
            .map(r => ({
                line: r.line,
                error: r.problems.map(p => `${p.column}: ${p.message}`).join(' · '),
            }));
        const good = built.filter(r => r.problems.length === 0 && Object.keys(r.values).length > 0);
        if (!good.length) {
            setResult({ inserted: 0, errors: local });
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const res = await onImport(good.map(r => r.values));
            // The server counts from 1 over the rows IT was sent; map that back
            // to the line in the spreadsheet the person is looking at.
            const serverErrors = (res?.errors || []).map(e => ({
                line: good[e.line - 1]?.line ?? e.line,
                error: e.error,
            }));
            setResult({ inserted: res?.inserted || 0, errors: [...local, ...serverErrors].sort((a, b) => a.line - b.line) });
            onDone?.();
        } catch (e) {
            setError(e?.message || t('datatables.err_import', 'Could not import these rows'));
        } finally {
            setBusy(false);
        }
    };

    const previewRows = parsed.rows.slice(0, PREVIEW_ROWS);
    const previewColumns = mapping.map((key, index) => ({ key, index })).filter(c => c.key !== NO_IMPORT);

    return (
        <div className="flex flex-col gap-3 rounded-lg border p-3"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
                    {t('datatables.import_title', 'Paste from a spreadsheet')}
                </span>
                <Button onClick={onClose} disabled={busy} className="ml-auto">{t('datatables.import_back', 'Back to rows')}</Button>
            </div>

            <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                {t('datatables.import_help', 'Copy the rows in Excel or Google Sheets — including the header row — and paste them here.')}
                <textarea
                    className="w-full resize-y rounded-md border px-3 py-2 font-mono text-xs"
                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                    rows={5}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={PLACEHOLDER}
                    disabled={busy}
                    spellCheck={false}
                    aria-label={t('datatables.import_textarea', 'Pasted rows')}
                />
            </label>

            {parsed.header.length > 0 && !result && (
                <>
                    <div className="flex flex-col gap-2">
                        <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                            {t('datatables.import_mapping', 'Where does each column go?')}
                        </p>
                        {parsed.header.map((name, index) => (
                            <div key={`${name}-${index}`} className="flex items-center gap-2 text-xs">
                                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                                    {name || t('datatables.import_column_n', 'Column {n}', { n: index + 1 })}
                                </span>
                                <ArrowRight className="h-3 w-3 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                                <select
                                    className={SELECT_CLS}
                                    value={mapping[index] || NO_IMPORT}
                                    onChange={(e) => setColumn(index, e.target.value)}
                                    disabled={busy}
                                    aria-label={t('datatables.import_column_target', 'Where does “{name}” go?', { name: name || t('datatables.import_column_n', 'Column {n}', { n: index + 1 }) })}
                                >
                                    <option value={NO_IMPORT}>{t('datatables.import_skip_column', 'Don’t import this one')}</option>
                                    {fields.map(f => <option key={f.key} value={f.key}>{f.name || f.key}</option>)}
                                </select>
                            </div>
                        ))}
                    </div>

                    {previewColumns.length > 0 && (
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr>
                                        {previewColumns.map(c => (
                                            <th key={c.index} className="px-2 py-1 text-left font-medium"
                                                style={{ color: 'var(--text-secondary)' }}>
                                                {fields.find(f => f.key === c.key)?.name || c.key}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {previewRows.map((cells, i) => (
                                        <tr key={i}>
                                            {previewColumns.map(c => (
                                                <td key={c.index} className="px-2 py-1 align-top"
                                                    style={{ color: 'var(--text-primary)' }}>
                                                    {cells[c.index] ?? ''}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <Button primary onClick={start} disabled={busy || mappedCount === 0 || parsed.rows.length === 0}>
                            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                            {parsed.rows.length === 1
                                ? t('datatables.import_one', 'Import 1 row')
                                : t('datatables.import_n', 'Import {n} rows', { n: parsed.rows.length })}
                        </Button>
                        {mappedCount === 0 && (
                            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {t('datatables.import_unmapped', 'Point at least one column at a field first.')}
                            </span>
                        )}
                    </div>
                </>
            )}

            {/* aria-live over both answers: an import finishes with no focus
                change at all, so its result is otherwise visual only. */}
            <div aria-live="polite" className="flex flex-col gap-3">
            {error && (
                <p className="text-xs px-2 py-1.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--warning)' }}>
                    {error}
                </p>
            )}

            {result && (
                <div className="flex flex-col gap-1.5 text-xs">
                    <p style={{ color: 'var(--text-primary)' }}>
                        {result.inserted === 1
                            ? t('datatables.import_done_one', '1 row imported')
                            : t('datatables.import_done', '{n} rows imported', { n: result.inserted })}
                        {result.errors.length
                            ? `, ${t('datatables.import_skipped', '{n} skipped', { n: result.errors.length })}`
                            : ''}.
                    </p>
                    {result.errors.length > 0 && (
                        <ul className="flex flex-col gap-1">
                            {result.errors.map(e => (
                                <li key={e.line} className="flex items-start gap-1.5" style={{ color: 'var(--warning)' }}>
                                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
                                    <span>{t('datatables.import_line', 'Line {n}', { n: e.line })}: {e.error}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div><Button onClick={() => { setText(''); setResult(null); }}>{t('datatables.import_again', 'Paste another block')}</Button></div>
                </div>
            )}
            </div>
        </div>
    );
}
