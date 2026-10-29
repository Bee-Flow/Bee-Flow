import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { buildImportRows, importableFields, parsePasted, ImportRow } from './spreadsheetPaste';
import type { TranslateFn } from '@/hooks/useTranslation';

// The pieces of PasteImportPanel: its button, the mapped-rows preview and the import result.

export const PREVIEW_ROWS = 5;

export interface ButtonProps {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    primary?: boolean;
    className?: string;
}

export function Button({ children, onClick, disabled, primary = false, className = '' }: ButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${primary ? 'text-white' : 'border hover:bg-[var(--bg-tertiary)]'} ${className}`}
            style={primary
                ? { background: 'var(--accent-primary)' }
                : { borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
        >
            {children}
        </button>
    );
}

/** A row the import left out, with the sentence that says why. */
export interface SkippedRow {
    line: number;
    message: string;
}

/** What the import has done so far. */
export interface ImportTally {
    added: number;
    skipped: SkippedRow[];
}

/** An import waiting out the rate limit: the rows still to send, and the seconds left. */
export interface PausedImport {
    queue: ImportRow[];
    seconds: number;
}

interface ImportPreviewProps {
    t: TranslateFn;
    parsed: ReturnType<typeof parsePasted>;
    built: ReturnType<typeof buildImportRows>;
    fields: ReturnType<typeof importableFields>;
    previewColumns: { key: string; index: number }[];
    previewRows: ReturnType<typeof parsePasted>['rows'];
    badRows: number;
}

/** The first rows as they would be imported, every value that will not convert marked, and how many rows will be skipped. */
export function ImportPreview({ t, parsed, built, fields, previewColumns, previewRows, badRows }: ImportPreviewProps) {
    return (
            <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold text-[var(--text-secondary)]">
                    {parsed.rows.length === 1
                        ? t('studio_apps_tables.paste.preview_one', 'The first {shown} of {total} row', { shown: Math.min(PREVIEW_ROWS, parsed.rows.length), total: parsed.rows.length })
                        : t('studio_apps_tables.paste.preview_many', 'The first {shown} of {total} rows', { shown: Math.min(PREVIEW_ROWS, parsed.rows.length), total: parsed.rows.length })}
                </p>
                <div className="w-full overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead>
                            <tr>
                                {previewColumns.map((c) => (
                                    <th
                                        key={c.index}
                                        scope="col"
                                        className="border-b px-2 py-1 text-left font-medium border-[var(--border-default)] text-[var(--text-secondary)]"
                                    >
                                        {fields.find((f) => f.key === c.key)?.name || c.key}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {previewRows.map((cells, rowIndex) => (
                                <tr key={built[rowIndex]?.line ?? rowIndex}>
                                    {previewColumns.map((c) => {
                                        const problem = built[rowIndex]?.problems.find((p) => p.fieldKey === c.key) || null;
                                        return (
                                            <td
                                                key={c.index}
                                                className="border-b px-2 py-1 align-top"
                                                style={{ borderColor: 'var(--border-default)', color: problem ? 'var(--error)' : 'var(--text-primary)' }}
                                            >
                                                <span className="block truncate">{cells[c.index] || '—'}</span>
                                                {problem ? <span className="block text-[11px]">{problem.message}</span> : null}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {badRows > 0 ? (
                    <p className="flex items-start gap-1.5 text-xs [color:#d97706]!">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {parsed.rows.length === 1
                            ? t('studio_apps_tables.paste.bad_rows_one', '{bad} of {total} row will be skipped — fix them in the spreadsheet and paste again, or import the rest now.', { bad: badRows, total: parsed.rows.length })
                            : t('studio_apps_tables.paste.bad_rows_many', '{bad} of {total} rows will be skipped — fix them in the spreadsheet and paste again, or import the rest now.', { bad: badRows, total: parsed.rows.length })}
                    </p>
                ) : null}
            </div>
    );
}

interface ImportResultProps {
    t: TranslateFn;
    result: ImportTally;
    summary: string;
    paused: PausedImport | null;
    waiting: boolean;
    importing: boolean;
    onResume: () => void;
    onPasteMore: () => void;
    onClose: () => void;
}

/** What the import did, why rows were skipped, and — paused on the rate limit — how many are still to go. */
export function ImportResult({ t, result, summary, paused, waiting, importing, onResume, onPasteMore, onClose }: ImportResultProps) {
    return (
            <div className="flex flex-col gap-2 rounded-lg border p-3 border-[var(--border-default)] bg-[var(--bg-secondary)]">
                <p className="text-sm font-medium text-[var(--text-primary)]">{summary}</p>
                {result.skipped.length ? (
                    <details>
                        <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">
                            {result.skipped.length === 1
                                ? t('studio_apps_tables.paste.why_one', 'Why {n} row was skipped', { n: result.skipped.length })
                                : t('studio_apps_tables.paste.why_many', 'Why {n} rows were skipped', { n: result.skipped.length })}
                        </summary>
                        <ul className="mt-1 flex flex-col gap-0.5">
                            {result.skipped.map((s) => (
                                <li key={s.line} className="text-xs text-[var(--text-tertiary)]">
                                    {t('studio_apps_tables.paste.row_line', 'Row {line}: {message}', { line: s.line, message: s.message })}
                                </li>
                            ))}
                        </ul>
                    </details>
                ) : null}

                {paused ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <span>
                            {paused.seconds > 0
                                ? (paused.queue.length === 1
                                    ? t('studio_apps_tables.paste.to_go_wait_one', '{n} row to go. The app only takes so many new rows a minute, so this waits {seconds}s.', { n: paused.queue.length, seconds: paused.seconds })
                                    : t('studio_apps_tables.paste.to_go_wait_many', '{n} rows to go. The app only takes so many new rows a minute, so this waits {seconds}s.', { n: paused.queue.length, seconds: paused.seconds }))
                                : (paused.queue.length === 1
                                    ? t('studio_apps_tables.paste.to_go_one', '{n} row to go. The app only takes so many new rows a minute.', { n: paused.queue.length })
                                    : t('studio_apps_tables.paste.to_go_many', '{n} rows to go. The app only takes so many new rows a minute.', { n: paused.queue.length }))}
                        </span>
                        <Button primary onClick={onResume} disabled={waiting || importing}>
                            {t('studio_apps_tables.paste.add_rest', 'Add the rest')}
                        </Button>
                    </div>
                ) : (
                    <div className="flex items-center gap-2">
                        <Button onClick={onPasteMore}>{t('studio_apps_tables.paste.paste_more', 'Paste some more')}</Button>
                        <Button primary onClick={onClose}>{t('studio_apps_tables.paste.back', 'Back to rows')}</Button>
                    </div>
                )}
            </div>
    );
}
