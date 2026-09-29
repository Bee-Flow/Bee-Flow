import { Link2, Loader2 } from 'lucide-react';
import React from 'react';
import { formatLabel, providerLogoId, providerName, ssErrorMessage, writeCaveatText } from '../datatableDisplay';
import SheetSection from './SheetSection';
import { describeKeyOf, fileKeyOf, sheetKeyOf, sheetLabelOf } from './wizardState';
import { getIntegrationLogo } from '../../../../../utils/integrationLogos';

/**
 * Step 2 of the link-spreadsheet wizard: which sheets, and what their
 * columns are.
 *
 * One section per file ticked in step 1: what the storage said about the
 * file (can it be written back, and at what cost), its sheets as
 * checkboxes, and — for every sheet ticked — a SheetSection with the header
 * row, a five-row preview, the columns with their types, and how a row is
 * to be recognised.
 *
 * The describes are the dialog's (it owns the maps and the fetching); this
 * step only reads them by key: the file's under `fileKey`, a sheet's under
 * `describeKeyOf(fileKey, sheet, headerRow)`. A sheet ticked in a file
 * with several is read on its own; a file with ONE sheet (a csv, a
 * single-tab workbook) was selected by the dialog the moment the file was
 * read, so there is nothing to tick and the sheet's name is stated instead.
 * A csv's only sheet has NO name on the wire (`null` — the server's reader
 * contract), so the file's name stands in for it (wizardState.sheetLabelOf).
 *
 * ── THE ONLY SHEET IS LINKED ALREADY ────────────────────────────────
 * The dialog does not select a single sheet that another table in this
 * scope already mirrors (the server would answer 409 `already_linked`).
 * There is then nothing on this step to tick and Next stays off — so the
 * sheet line says "already linked", the same chip a linked sheet of a
 * multi-sheet workbook wears, instead of leaving a silent dead end.
 *
 * ── A FILE THAT IS NOT THE LINKER'S ─────────────────────────────────
 * The storage says `owned:false` for a file shared with this account. The
 * server then reads it and writes NOTHING back unless the linker ticks the
 * opt-in here, per file: rows typed in Bee Flow would land in somebody
 * else's storage, and that is a decision, not a default. The opt-in is
 * offered ONLY when ownership is the one thing in the way — the server's
 * `write.reason` is `not_owned`. An .xls/.xlsm/.ods and a share without
 * write permission are refused before ownership is ever asked (reading.js
 * writeModeFor), and a checkbox that changes nothing would contradict the
 * read-only caveat printed right above it.
 */
export default function SheetsStep({ t, files, describes, sheetDescribes, selection, marks, onToggleSheet, onChange, onOptIn, onRetry }) {
    return (
        <div className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('datatables.ss_sheets_intro', 'Tick the sheets to link. Each sheet becomes its own table.')}
            </p>
            {[...files.values()].map((file) => {
                const fileKey = fileKeyOf(file.provider, file.id);
                return (
                    <FileSection key={fileKey} t={t} file={file} fileKey={fileKey} describe={describes.get(fileKey)} sheetDescribes={sheetDescribes}
                        selection={selection} mark={marks.get(fileKey)} marks={marks}
                        onToggleSheet={onToggleSheet} onChange={onChange} onOptIn={onOptIn} onRetry={onRetry} />
                );
            })}
        </div>
    );
}

function FileSection({ t, file, fileKey, describe, sheetDescribes, selection, mark, marks, onToggleSheet, onChange, onOptIn, onRetry }) {
    const d = describe || { loading: true, error: null, data: null };
    const data = d.data;
    const Logo = getIntegrationLogo(providerLogoId(file.provider, file.format));
    const sheets = (data && data.sheets) || [];
    const single = sheets.length === 1;
    const chosen = [...selection.values()].filter(s => s.fileKey === fileKey);
    const write = (data && data.write) || null;
    // Ownership must be the ONLY thing in the way: a format or permission
    // refusal is decided first on the server, and the tick would be a no-op.
    const notOwned = !!write && write.mode === 'none' && write.reason === 'not_owned';
    const optIn = !!file.sharedWriteOptIn;

    return (
        <section className="p-3 space-y-3" style={{ borderRadius: 12, background: 'var(--bg-primary)', border: '1px solid var(--border-default)' }} aria-label={file.name}>
            <div className="flex items-center gap-2 flex-wrap">
                {Logo
                    ? <span className="shrink-0 inline-flex" aria-hidden="true">{React.createElement(Logo, { size: 16 })}</span>
                    : null}
                <span className="text-sm font-medium truncate min-w-0" style={{ color: 'var(--text-primary)' }}>{file.name}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{formatLabel(t, (data && data.format) || file.format)} · {providerName(file.provider)}</span>
                {d.loading && (
                    <span className="inline-flex items-center gap-1.5 text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />{t('datatables.nc_reading', 'Reading the columns…')}
                    </span>
                )}
            </div>
            {d.error && (
                <p role="alert" className="text-[11px]" style={{ color: 'var(--warning)' }}>
                    {ssErrorMessage(t, d.error, providerName(file.provider)) || d.error.message}{' '}
                    <button type="button" onClick={() => onRetry(fileKey)} className="underline" style={{ color: 'var(--text-primary)' }}>
                        {t('datatables.ss_retry', 'Try again')}
                    </button>
                </p>
            )}
            {mark && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{mark}</p>}
            {write && (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {writeCaveatText(t, write.mode, write.reason)}
                </p>
            )}
            {notOwned && (
                <label className="flex items-start gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                    <input type="checkbox" checked={optIn} onChange={(e) => onOptIn(fileKey, e.target.checked)} className="mt-0.5 shrink-0" />
                    <span>
                        {t('datatables.ss_shared_write_optin', 'Also write rows into this shared file')}
                        <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {t('datatables.ss_shared_write_optin_help', 'The file belongs to someone else. With this on, rows added or changed here land in their storage; without it, the file is only read.')}
                        </span>
                    </span>
                </label>
            )}
            {data && single && <OnlySheetLine t={t} sheet={sheets[0]} fileName={file.name} />}
            {data && !single && (
                <ul className="space-y-1" role="list">
                    {sheets.map((sh) => {
                        const linked = Array.isArray(sh.linkedAs) && sh.linkedAs.length > 0;
                        const checked = selection.has(sheetKeyOf(fileKey, sh.name));
                        return (
                            <li key={sh.name}>
                                <label className={`flex items-center gap-2 text-sm ${linked ? 'cursor-not-allowed' : 'cursor-pointer'}`} style={{ opacity: linked ? 0.6 : 1 }}>
                                    <input type="checkbox" checked={checked} disabled={linked} onChange={() => onToggleSheet(file, sh.name)} aria-label={`${sh.name} — ${file.name}`} />
                                    <span style={{ color: 'var(--text-primary)' }}>{sh.name}</span>
                                    {sh.hidden && <span className="text-[10px] px-1.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{t('datatables.ss_sheet_hidden', 'hidden')}</span>}
                                    {(sh.rows != null || sh.cols != null) && (
                                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                            {t('datatables.nc_table_meta', '{rows} rows · {cols} columns', { rows: sh.rows ?? '?', cols: sh.cols ?? '?' })}
                                        </span>
                                    )}
                                    {linked && (
                                        <span className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                                            <Link2 className="w-3 h-3" aria-hidden="true" />{t('datatables.nc_already_linked', 'already linked')}
                                        </span>
                                    )}
                                </label>
                            </li>
                        );
                    })}
                </ul>
            )}
            {chosen.map((s) => (
                <SheetSection key={s.sheetKey} t={t} s={s} describe={sheetDescribes.get(describeKeyOf(s.fileKey, s.sheet, s.headerRow))}
                    mark={marks.get(s.sheetKey)} onChange={onChange} />
            ))}
        </section>
    );
}

/**
 * The line for a file with ONE sheet: its name — the file's, for a csv's
 * unnamed sheet — and, when a table in this scope already mirrors it, the
 * "already linked" chip a linked sheet of a multi-sheet workbook wears.
 * That chip is the only thing on the step that explains why nothing is
 * selected and Next stays off.
 */
function OnlySheetLine({ t, sheet, fileName }) {
    const linked = Array.isArray(sheet.linkedAs) && sheet.linkedAs.length > 0;
    return (
        <p className="text-xs inline-flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-secondary)', opacity: linked ? 0.6 : 1 }}>
            <span>{t('datatables.ss_file_sheet', 'Sheet: {sheet}', { sheet: sheetLabelOf(sheet.name, fileName) })}</span>
            {linked && (
                <span className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                    <Link2 className="w-3 h-3" aria-hidden="true" />{t('datatables.nc_already_linked', 'already linked')}
                </span>
            )}
        </p>
    );
}
