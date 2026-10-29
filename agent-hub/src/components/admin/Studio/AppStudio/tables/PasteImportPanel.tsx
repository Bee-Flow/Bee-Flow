import { ArrowRight, ClipboardPaste, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import type { RowRecord } from './recordsApi';
import { Button, ImportPreview, ImportResult, PREVIEW_ROWS, type ImportTally, type PausedImport } from './PasteImportParts';
import { buildImportRows, importableFields, parsePasted, suggestMapping } from './spreadsheetPaste';
import type { ImportRow, ImportTable } from './spreadsheetPaste';
import useTranslation, { TranslateParams } from '@/hooks/useTranslation';
import { errorStatus, messageOf } from '@/utils/caughtError';

/**
 * App Studio — "paste from a spreadsheet": a block copied out of Excel or
 * Google Sheets becomes rows in the table.
 *
 * Three steps in one panel: paste → say which column goes where (pre-matched on
 * the header names) → confirm, with the first rows previewed and anything that
 * will not convert flagged before a single row is sent.
 *
 * The rows go in ONE AT A TIME through the ordinary create endpoint (there is no
 * bulk one), which is rate limited to a score of rows a minute per person and
 * app. Hitting that limit is expected on a big paste and is NOT a failure: the
 * import pauses, keeps everything still to come, and carries on when the wait
 * is over — so a paste of a thousand rows finishes without the user re-pasting.
 */

const NO_IMPORT = '';

const SELECT_CLS = 'rounded-md px-2 py-1 text-xs border bg-[var(--bg-tertiary)] '
    + 'border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] focus:border-[var(--accent-primary)]';

const PLACEHOLDER = 'Name\tEmail\tStarts on\nAnna de Vries\tanna@example.com\t2026-03-14';

interface PasteImportPanelProps {
    table?: ImportTable | null;
    onCreate: (values: Record<string, unknown>) => Promise<{ record?: RowRecord } | null | undefined>;
    onImported?: (created: RowRecord[]) => void;
    onClose: () => void;
}

/** The Retry-After seconds recordsApi puts on a 429 error, or undefined. */
function retryAfterOf(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null || !('retryAfter' in err)) return undefined;
    return typeof err.retryAfter === 'number' ? err.retryAfter : undefined;
}

export default function PasteImportPanel({ table, onCreate, onImported, onClose }: PasteImportPanelProps) {
    const { t } = useTranslation();
    const fields = useMemo(() => importableFields(table?.fields), [table]);
    const [text, setText] = useState('');
    const parsed = useMemo(() => parsePasted(text), [text]);
    const headerKey = parsed.header.join('\u0000');
    const [mapping, setMapping] = useState(() => suggestMapping(parsed.header, fields));
    const [importing, setImporting] = useState(false);
    const [done, setDone] = useState(0);
    const [result, setResult] = useState<ImportTally | null>(null);
    const [paused, setPaused] = useState<PausedImport | null>(null); // { queue, seconds }

    // A fresh paste re-matches from scratch; editing the mapping afterwards is
    // the user's business.
    const [matched, setMatched] = useState({ headerKey, fields });
    if (matched.headerKey !== headerKey || matched.fields !== fields) {
        setMatched({ headerKey, fields });
        setMapping(suggestMapping(parsed.header, fields));
        setResult(null);
        setPaused(null);
    }

    const built = useMemo(
        () => buildImportRows(parsed, mapping, fields, t),
        [parsed, mapping, fields, t],
    );
    const mappedCount = mapping.filter((k) => k !== NO_IMPORT).length;
    const badRows = built.filter((r) => r.problems.length > 0).length;

    const waiting = !!paused && paused.seconds > 0;
    useEffect(() => {
        if (!waiting) return undefined;
        const timer = setInterval(() => {
            setPaused((p) => (p && p.seconds > 0 ? { ...p, seconds: p.seconds - 1 } : p));
        }, 1000);
        return () => clearInterval(timer);
    }, [waiting]);

    // One field per column: picking a field that is already used elsewhere moves
    // it, rather than quietly writing two columns into the same one.
    const setColumn = (index: number, fieldKey: string) => {
        setMapping((cur) => cur.map((k, i) => {
            if (i === index) return fieldKey;
            return fieldKey !== NO_IMPORT && k === fieldKey ? NO_IMPORT : k;
        }));
    };

    const send = async (queue: ImportRow[], startTally: ImportTally) => {
        setImporting(true);
        setDone(0);
        const created: RowRecord[] = [];
        const skipped = [...startTally.skipped];
        let added = startTally.added;
        for (let i = 0; i < queue.length; i += 1) {
            const row = queue[i];
            try {
                const res = await onCreate(row.values);
                added += 1;
                if (res?.record) created.push(res.record);
            } catch (err) {
                if (errorStatus(err) === 429) {
                    onImported?.(created);
                    setResult({ added, skipped });
                    setPaused({ queue: queue.slice(i), seconds: retryAfterOf(err) || 60 });
                    setImporting(false);
                    return;
                }
                skipped.push({ line: row.line, message: messageOf(err, t('studio_apps_tables.paste.row_rejected', 'The app would not take this row.')) });
            }
            setDone(i + 1);
        }
        onImported?.(created);
        setResult({ added, skipped });
        setPaused(null);
        setImporting(false);
    };

    const start = () => {
        const good = built.filter((r) => r.problems.length === 0 && Object.keys(r.values).length > 0);
        const skipped = built
            .filter((r) => r.problems.length > 0)
            .map((r) => ({ line: r.line, message: r.problems.map((p) => `${p.column}: ${p.message}`).join(' · ') }));
        send(good, { added: 0, skipped });
    };

    const resume = () => {
        const queue = paused?.queue || [];
        const tally = { added: result?.added || 0, skipped: result?.skipped || [] };
        setPaused(null);
        setResult(null);
        send(queue, tally);
    };

    const previewRows = parsed.rows.slice(0, PREVIEW_ROWS);
    const previewColumns = mapping
        .map((key, index) => ({ key, index }))
        .filter((c) => c.key !== NO_IMPORT);

    let summary = '';
    if (result) {
        const one = result.added === 1;
        if (result.skipped.length) {
            summary = one
                ? t('studio_apps_tables.paste.summary_added_skipped_one', '{n} row added, {skipped} skipped — see why', { n: result.added, skipped: result.skipped.length })
                : t('studio_apps_tables.paste.summary_added_skipped_many', '{n} rows added, {skipped} skipped — see why', { n: result.added, skipped: result.skipped.length });
        } else {
            summary = one
                ? t('studio_apps_tables.paste.summary_added_one', '{n} row added', { n: result.added })
                : t('studio_apps_tables.paste.summary_added_many', '{n} rows added', { n: result.added });
        }
    }
    const importCount = parsed.rows.length - badRows;

    return (
        <div className="flex min-h-[22rem] flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
                    <ClipboardPaste className="h-4 w-4 text-[var(--accent-primary)]" aria-hidden="true" />
                    {t('studio_apps_tables.paste.title', 'Paste from a spreadsheet')}
                </span>
                <Button onClick={onClose} disabled={importing} className="ml-auto">{t('studio_apps_tables.paste.back', 'Back to rows')}</Button>
            </div>

            <PasteImportPanelSection t={t} text={text} setText={setText} importing={importing} />

            {parsed.header.length > 0 && !result ? (
                <>
                    <div className="flex flex-col gap-2 rounded-lg border p-3 border-[var(--border-default)] bg-[var(--bg-secondary)]">
                        <p className="text-xs font-semibold text-[var(--text-secondary)]">
                            {t('studio_apps_tables.paste.where_each', 'Where does each column go?')}
                        </p>
                        {parsed.header.map((name, index) => (
                            <div key={`${name}-${index}`} className="flex items-center gap-2 text-xs">
                                <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                                    {name || t('studio_apps_tables.paste.column_n', 'Column {n}', { n: index + 1 })}
                                </span>
                                <ArrowRight className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                                <select
                                    className={SELECT_CLS}
                                    value={mapping[index] || NO_IMPORT}
                                    onChange={(e) => setColumn(index, e.target.value)}
                                    disabled={importing}
                                    aria-label={t('studio_apps_tables.paste.where_aria', 'Where does “{name}” go?', { name: name || t('studio_apps_tables.paste.column_n', 'Column {n}', { n: index + 1 }) })}
                                >
                                    <option value={NO_IMPORT}>{t('studio_apps_tables.paste.dont_import', 'Don’t import this one')}</option>
                                    {fields.map((f) => (
                                        <option key={f.key} value={f.key}>{f.name || f.key}</option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>

                    {previewColumns.length > 0 ? (
                        <ImportPreview t={t} parsed={parsed} built={built} fields={fields} previewColumns={previewColumns} previewRows={previewRows} badRows={badRows} />
                    ) : (
                        <p className="text-xs text-[var(--text-tertiary)]">
                            {t('studio_apps_tables.paste.pick_column', 'Pick a column above to import first — none of them is matched to a field yet.')}
                        </p>
                    )}

                    <div className="flex items-center gap-2">
                        <Button primary onClick={start} disabled={importing || mappedCount === 0 || parsed.rows.length === 0}>
                            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                            {importing
                                ? t('studio_apps_tables.paste.adding', 'Adding rows… ({done})', { done })
                                : (importCount === 1
                                    ? t('studio_apps_tables.paste.import_one', 'Import {n} row', { n: importCount })
                                    : t('studio_apps_tables.paste.import_many', 'Import {n} rows', { n: importCount }))}
                        </Button>
                    </div>
                </>
            ) : null}

            {result ? (
                <ImportResult t={t} result={result} summary={summary} paused={paused} waiting={waiting} importing={importing}
                    onResume={resume} onPasteMore={() => { setText(''); setResult(null); }} onClose={onClose} />
            ) : null}
        </div>
    );
}

function PasteImportPanelSection({ t, text, setText, importing }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; text: string; setText: React.Dispatch<React.SetStateAction<string>>; importing: boolean; }) {
    return <label className="flex flex-col gap-1 text-xs font-medium text-[var(--text-secondary)]">
        {t('studio_apps_tables.paste.instructions', 'Copy the rows in Excel or Google Sheets — including the header row — and paste them here.')}
        <textarea
            className="w-full resize-y rounded-md border px-3 py-2 font-mono text-xs [background:var(--bg-tertiary)] [border-color:var(--border-default)] [color:var(--text-primary)]!"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            disabled={importing}
            spellCheck={false}
            aria-label={t('studio_apps_tables.paste.pasted_aria', 'Pasted rows')} />
    </label>;
}
