import { AlertTriangle, ArrowRight, ClipboardPaste, Loader2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { buildImportRows, importableFields, parsePasted, suggestMapping } from './spreadsheetPaste';

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

const PREVIEW_ROWS = 5;
const NO_IMPORT = '';

const SELECT_CLS = 'rounded-md px-2 py-1 text-xs border bg-[var(--bg-tertiary)] '
    + 'border-[var(--border-default)] text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] focus:border-[var(--accent-primary)]';

const PLACEHOLDER = 'Name\tEmail\tStarts on\nAnna de Vries\tanna@example.com\t2026-03-14';

function Button({ children, onClick, disabled, primary = false, className = '' }) {
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

export default function PasteImportPanel({ table, onCreate, onImported, onClose }) {
    const fields = useMemo(() => importableFields(table?.fields), [table]);
    const [text, setText] = useState('');
    const parsed = useMemo(() => parsePasted(text), [text]);
    const headerKey = parsed.header.join('\u0000');
    const [mapping, setMapping] = useState(() => suggestMapping(parsed.header, fields));
    const [importing, setImporting] = useState(false);
    const [done, setDone] = useState(0);
    const [result, setResult] = useState(null);
    const [paused, setPaused] = useState(null); // { queue, seconds }

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
        () => buildImportRows(parsed, mapping, fields),
        [parsed, mapping, fields],
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
    const setColumn = (index, fieldKey) => {
        setMapping((cur) => cur.map((k, i) => {
            if (i === index) return fieldKey;
            return fieldKey !== NO_IMPORT && k === fieldKey ? NO_IMPORT : k;
        }));
    };

    const send = async (queue, startTally) => {
        setImporting(true);
        setDone(0);
        const created = [];
        const skipped = [...startTally.skipped];
        let added = startTally.added;
        for (let i = 0; i < queue.length; i += 1) {
            const row = queue[i];
            try {
                const res = await onCreate(row.values);
                added += 1;
                if (res?.record) created.push(res.record);
            } catch (err) {
                if (err?.status === 429) {
                    onImported?.(created);
                    setResult({ added, skipped });
                    setPaused({ queue: queue.slice(i), seconds: err.retryAfter || 60 });
                    setImporting(false);
                    return;
                }
                skipped.push({ line: row.line, message: err?.message || 'The app would not take this row.' });
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

    const summary = result
        ? `${result.added} row${result.added === 1 ? '' : 's'} added`
            + (result.skipped.length ? `, ${result.skipped.length} skipped — see why` : '')
        : '';

    return (
        <div className="flex min-h-[22rem] flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    <ClipboardPaste className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                    Paste from a spreadsheet
                </span>
                <Button onClick={onClose} disabled={importing} className="ml-auto">Back to rows</Button>
            </div>

            <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Copy the rows in Excel or Google Sheets — including the header row — and paste them here.
                <textarea
                    className="w-full resize-y rounded-md border px-3 py-2 font-mono text-xs"
                    style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    rows={6}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={PLACEHOLDER}
                    disabled={importing}
                    spellCheck={false}
                    aria-label="Pasted rows"
                />
            </label>

            {parsed.header.length > 0 && !result ? (
                <>
                    <div className="flex flex-col gap-2 rounded-lg border p-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
                        <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                            Where does each column go?
                        </p>
                        {parsed.header.map((name, index) => (
                            <div key={`${name}-${index}`} className="flex items-center gap-2 text-xs">
                                <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
                                    {name || `Column ${index + 1}`}
                                </span>
                                <ArrowRight className="h-3 w-3 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                                <select
                                    className={SELECT_CLS}
                                    value={mapping[index] || NO_IMPORT}
                                    onChange={(e) => setColumn(index, e.target.value)}
                                    disabled={importing}
                                    aria-label={`Where does “${name || `Column ${index + 1}`}” go?`}
                                >
                                    <option value={NO_IMPORT}>Don’t import this one</option>
                                    {fields.map((f) => (
                                        <option key={f.key} value={f.key}>{f.name || f.key}</option>
                                    ))}
                                </select>
                            </div>
                        ))}
                    </div>

                    {previewColumns.length > 0 ? (
                        <div className="flex flex-col gap-1">
                            <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                                The first {Math.min(PREVIEW_ROWS, parsed.rows.length)} of {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'}
                            </p>
                            <div className="w-full overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead>
                                        <tr>
                                            {previewColumns.map((c) => (
                                                <th
                                                    key={c.index}
                                                    scope="col"
                                                    className="border-b px-2 py-1 text-left font-medium"
                                                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
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
                                <p className="flex items-start gap-1.5 text-xs" style={{ color: '#d97706' }}>
                                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    {badRows} of {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} will be skipped — fix them in the spreadsheet and paste again, or import the rest now.
                                </p>
                            ) : null}
                        </div>
                    ) : (
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            Pick a column above to import first — none of them is matched to a field yet.
                        </p>
                    )}

                    <div className="flex items-center gap-2">
                        <Button primary onClick={start} disabled={importing || mappedCount === 0 || parsed.rows.length === 0}>
                            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                            {importing ? `Adding rows… (${done})` : `Import ${parsed.rows.length - badRows} row${parsed.rows.length - badRows === 1 ? '' : 's'}`}
                        </Button>
                    </div>
                </>
            ) : null}

            {result ? (
                <div className="flex flex-col gap-2 rounded-lg border p-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{summary}</p>
                    {result.skipped.length ? (
                        <details>
                            <summary className="cursor-pointer text-xs" style={{ color: 'var(--text-secondary)' }}>
                                Why {result.skipped.length} row{result.skipped.length === 1 ? ' was' : 's were'} skipped
                            </summary>
                            <ul className="mt-1 flex flex-col gap-0.5">
                                {result.skipped.map((s) => (
                                    <li key={s.line} className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                        Row {s.line}: {s.message}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ) : null}

                    {paused ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                            <span>
                                {paused.queue.length} row{paused.queue.length === 1 ? '' : 's'} to go. The app only takes so many new rows a minute
                                {paused.seconds > 0 ? `, so this waits ${paused.seconds}s.` : '.'}
                            </span>
                            <Button primary onClick={resume} disabled={waiting || importing}>
                                Add the rest
                            </Button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2">
                            <Button onClick={() => { setText(''); setResult(null); }}>Paste some more</Button>
                            <Button primary onClick={onClose}>Back to rows</Button>
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}
