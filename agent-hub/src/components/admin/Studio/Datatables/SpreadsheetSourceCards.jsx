import { ExternalLink, FileSpreadsheet, KeyRound, Loader2, ListOrdered, RefreshCw } from 'lucide-react';
import React, { useState } from 'react';
import { formatLabel, providerLogoId, sourceErrorMessage, sourceNameOf, sourceWritable, writeReasonText } from './datatableDisplay';
import { getIntegrationLogo } from '../../../../utils/integrationLogos';

/**
 * The three cards only a SPREADSHEET mirror has (the status and relations
 * cards are shared — SourceMirrorPanel.jsx):
 *
 *   FileCard     — which file, which sheet, which header row, when the file
 *                  last changed, and "Re-read the columns".
 *   WriteCard    — whether rows written here reach the file at all, and by
 *                  which mechanism; what that mechanism keeps and loses.
 *   IdentityCard — how a row is told apart from the others: a key column,
 *                  or its row number — and what each means when the sheet
 *                  is edited underneath.
 *
 * Copy states what the SERVER does, in the server's words where it has them
 * (`writeMode`, `writeReason`, `sync.lastError`), so a sentence cannot drift
 * into describing behaviour the engine no longer has.
 */
export function FileCard({ t, rel, table, mirror, canEdit }) {
    const source = mirror?.source || null;
    const sync = mirror?.sync || null;
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState(null);
    const [error, setError] = useState(null);
    const Logo = getIntegrationLogo(providerLogoId(source?.provider, source?.format));

    const relink = async () => {
        setBusy(true); setError(null); setNote(null);
        try {
            await mirror.relink();
            setNote(t('datatables.ss_relink_done', 'The header row and the file’s access were re-read; new columns arrive on the next refresh.'));
        } catch (e) {
            setError(sourceErrorMessage(t, e, table) || e.message);
        } finally { setBusy(false); }
    };

    return (
        <section className="p-4 space-y-2" style={CARD} aria-label={t('datatables.ss_file_title', 'The file')}>
            <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                {Logo
                    ? <span className="shrink-0 inline-flex" aria-hidden="true">{React.createElement(Logo, { size: 16 })}</span>
                    : <FileSpreadsheet className="w-4 h-4" style={{ color: 'var(--type-data)' }} aria-hidden="true" />}
                {source?.webUrl ? (
                    <a href={source.webUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline" style={{ color: 'var(--text-primary)' }}>
                        {source.fileName || source.fileId}
                        <ExternalLink className="w-3 h-3" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    </a>
                ) : <span>{source?.fileName || source?.fileId || ''}</span>}
            </h3>
            <dl className="text-xs grid gap-x-4 gap-y-1" style={{ gridTemplateColumns: 'auto minmax(0,1fr)', color: 'var(--text-secondary)' }}>
                {source?.path && (
                    <>
                        <dt style={{ color: 'var(--text-tertiary)' }}>{t('datatables.ss_file_path', 'Path')}</dt>
                        <dd className="truncate font-mono">{source.path}</dd>
                    </>
                )}
                <dt style={{ color: 'var(--text-tertiary)' }}>{t('datatables.ss_file_format', 'Format')}</dt>
                <dd>{formatLabel(t, source?.format)}</dd>
                <dt style={{ color: 'var(--text-tertiary)' }}>{t('datatables.ss_file_where', 'Stored in')}</dt>
                <dd>{sourceNameOf(table, source)}</dd>
            </dl>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('datatables.ss_file_sheet', 'Sheet: {sheet}', { sheet: source?.sheet || '' })}
                {' · '}
                {t('datatables.ss_file_header_row', 'Header row: {n}', { n: source?.headerRow || 1 })}
                {sync?.sourceModifiedAt && (
                    <>{' · '}{t('datatables.ss_file_changed', 'File last changed {when}', { when: rel(sync.sourceModifiedAt) })}</>
                )}
            </p>
            {canEdit && (
                <div className="flex items-center gap-2 flex-wrap">
                    <button type="button" onClick={relink} disabled={busy}
                        className={`${BTN} border inline-flex items-center gap-1.5 disabled:opacity-50`}
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}>
                        {busy
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
                        {t('datatables.ss_relink', 'Re-read the columns')}
                    </button>
                </div>
            )}
            <p aria-live="polite" className="text-xs" style={{ color: error ? 'var(--warning)' : 'var(--text-secondary)' }}>{error || note}</p>
        </section>
    );
}

/**
 * Whether, and how, rows written here reach the file. The title changes with
 * the answer: "Changes go both ways" is a promise, and over a file the server
 * cannot write it would be a false one.
 */
export function WriteCard({ t, table, mirror }) {
    const source = mirror?.source || null;
    const writable = sourceWritable(table, source);
    const sourceName = sourceNameOf(table, source);
    const title = writable
        ? t('datatables.nc_write_title', 'Changes go both ways')
        : t('datatables.ss_readonly_title', 'Rows are read from the file');
    return (
        <section className="p-4 space-y-2" style={CARD} aria-label={title}>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {writeModeText(t, writable ? source?.writeMode : 'none', sourceName)}
            </p>
            {!writable && writeReasonText(t, source?.writeReason) && (
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{writeReasonText(t, source?.writeReason)}</p>
            )}
            {writable && source?.owned === false && (
                // The privacy rule made visible: rows typed by Bee Flow editors
                // are landing in storage the linker does not own, because the
                // linker said so per file. It is not the default, so say it.
                <p className="text-xs" style={{ color: 'var(--warning)' }}>
                    {t('datatables.ss_shared_write_on', 'The file belongs to someone else. The account that linked this table chose to write rows into it anyway; rows changed here land in their storage.')}
                </p>
            )}
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('datatables.ss_columns_body', 'The columns are the sheet’s header row. Change them in the file; “Re-read the columns” brings them here.')}{' '}
                {t('datatables.ss_no_retention', 'Rows are not aged out here — they stay as long as they are in the file.')}
            </p>
        </section>
    );
}

/** The sentence per write MECHANISM — the server's `source.writeMode`. */
function writeModeText(t, writeMode, source) {
    switch (writeMode) {
        case 'sheets_api':
            return t('datatables.ss_write_sheets_api', 'Rows added, changed or deleted here are written to the Google Sheet first, cell by cell; this copy is refreshed from what the sheet answered. When the sheet refuses a change, the refusal is shown here and nothing changes on either side.');
        case 'graph_workbook':
            return t('datatables.ss_write_graph_workbook', 'Rows added, changed or deleted here are written into the Excel workbook in OneDrive first, cell by cell, so formatting is kept; this copy is refreshed from what the workbook answered.');
        case 'exceljs_put':
            return t('datatables.ss_write_exceljs_put', 'Rows added, changed or deleted here are written into the file in {source} first. Cell styles, column widths and number formats are kept; charts, pivot tables and macros are not. If the file changed in between, nothing is written and the row is refreshed instead.', { source });
        case 'csv_put':
            return t('datatables.ss_write_csv_put', 'Rows added, changed or deleted here rewrite the whole CSV file in {source} first — same delimiter, encoding and line endings as found. If the file changed in between, nothing is written and the row is refreshed instead.', { source });
        default:
            return t('datatables.ss_write_none', 'Rows of this table are read from the file; they cannot be changed from here. Change them in the file — the next refresh brings them here.');
    }
}

/**
 * A key column keeps a row's identity when rows are inserted or sorted in
 * the sheet; a row number does not — and an automation that stored an id
 * needs to know which of the two it holds.
 */
export function IdentityCard({ t, mirror }) {
    const source = mirror?.source || null;
    const key = source?.keyColumn || null;
    return (
        <section className="p-4 space-y-2" style={CARD} aria-label={t('datatables.ss_identity_title', 'How rows are recognised')}>
            <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                {key
                    ? <KeyRound className="w-4 h-4" style={{ color: 'var(--type-data)' }} aria-hidden="true" />
                    : <ListOrdered className="w-4 h-4" style={{ color: 'var(--type-data)' }} aria-hidden="true" />}
                {t('datatables.ss_identity_title', 'How rows are recognised')}
            </h3>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {key
                    ? t('datatables.ss_identity_key', 'Each row is recognised by its {column}. A row keeps its place here when rows are inserted or sorted in the sheet; a changed {column} counts as a new row.', { column: key.header || key.fieldId })
                    : t('datatables.ss_identity_rownum', 'Each row is recognised by its row number in the sheet. Inserting or deleting a row above shifts the rows below it — an automation that keeps a row id should use a key column instead.')}
            </p>
        </section>
    );
}

const CARD = { borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' };
const BTN = 'px-3 py-2 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
