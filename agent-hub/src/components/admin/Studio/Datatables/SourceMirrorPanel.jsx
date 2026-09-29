import { AlertTriangle, ExternalLink, Loader2, RefreshCw, Zap } from 'lucide-react';
import React, { useState } from 'react';
import { isNcMirror, isSpreadsheetMirror, sourceErrorMessage, sourceKindSpec, sourceNameOf, sourceUrlOf, sourceWritable } from './datatableDisplay';
import RelationsCard from './RelationsCard';
import { sourceGlyphOf } from './sourceGlyphs';
import { FileCard, IdentityCard, WriteCard } from './SpreadsheetSourceCards';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';

/**
 * The source tab of a mirrored table — "Nextcloud" or "Spreadsheet" — as
 * cards:
 *
 *   1. Kept in step with {source} — whether the copy is live, when it was
 *      last proven equal to the source, the server's own sentence when a
 *      pass failed, Refresh now, and the deep link into the source.
 *   2. Changes go both ways — the two rules a person has to know: rows
 *      changed here go to the source first, and the columns are the source's.
 *      A spreadsheet adds which file, how it is written, how rows are
 *      recognised (SpreadsheetSourceCards.jsx).
 *   3. Relations — the source's own (locked) and the ones declared here.
 *
 * One panel for both kinds. Every sentence with a `{source}` word is a
 * shared `src_*` key filled by `sourceNameOf`; what differs in SHAPE per
 * kind comes from the SOURCE_KINDS registry. Copy states what the SERVER
 * does, in the server's words where it has them (`sync.lastError`,
 * `warnings`), so a sentence cannot drift into describing behaviour the
 * engine no longer has.
 */
export default function SourceMirrorPanel({ table, mirror, canEdit, canWrite, onChanged }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState(null);
    const [error, setError] = useState(null);
    const source = mirror?.source || null;
    const sync = mirror?.sync || null;
    const spec = sourceKindSpec(table);
    const sourceName = sourceNameOf(table, source);
    const Glyph = sourceGlyphOf(table);
    const url = sourceUrlOf(table, source);

    const refresh = async () => {
        setBusy(true); setError(null); setNote(null);
        try {
            const body = await mirror.refreshNow();
            if (body?.alreadyRunning) setNote(t('datatables.nc_already_running', 'A refresh is already running.'));
            else if (body?.warnings?.length) setNote(body.warnings.join(' '));
            onChanged?.();
        } catch (e) {
            setError(sourceErrorMessage(t, e, table) || e.message);
        } finally { setBusy(false); }
    };

    return (
        <div className="space-y-4">
            <section className="p-4 space-y-3" style={CARD} aria-label={t('datatables.src_status_title', 'Kept in step with {source}', { source: sourceName })}>
                <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                    {Glyph && React.createElement(Glyph, { className: 'w-4 h-4', style: { color: 'var(--type-data)' }, 'aria-hidden': 'true' })}
                    {t('datatables.src_status_title', 'Kept in step with {source}', { source: sourceName })}
                </h3>
                <StatusLine t={t} rel={rel} sync={sync} sourceName={sourceName} />
                <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {spec ? spec.liveExplain(t) : null}
                </p>
                {sync?.truncated && spec && (
                    <p className="text-xs flex items-start gap-2" style={{ color: 'var(--warning)' }}>
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                        {spec.truncated(t, new Intl.NumberFormat().format(source?.rowCap || 10000))}
                    </p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                    {canWrite && (
                        <button type="button" onClick={refresh} disabled={busy || sync?.status === 'running'}
                            className={`${BTN} border inline-flex items-center gap-1.5 disabled:opacity-50`}
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}>
                            {busy || sync?.status === 'running'
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                                : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />}
                            {t('datatables.nc_refresh_now', 'Refresh now')}
                        </button>
                    )}
                    {url && (
                        <a href={url} target="_blank" rel="noopener noreferrer"
                            className="text-xs inline-flex items-center gap-1 ml-auto" style={{ color: 'var(--text-secondary)' }}>
                            <ExternalLink className="w-3 h-3" aria-hidden="true" />
                            {t('datatables.src_open_in', 'Open in {source}', { source: sourceName })}
                        </a>
                    )}
                </div>
                {source?.linkedByUserId && (
                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {t('datatables.src_linked_by', '{source} is read and written as the account that linked this table.', { source: sourceName })}
                        {source.linkedAt ? ` ${t('datatables.nc_linked_at', 'Linked {when}.', { when: rel(source.linkedAt) })}` : ''}
                    </p>
                )}
                <p aria-live="polite" className="text-xs" style={{ color: error ? 'var(--warning)' : 'var(--text-secondary)' }}>{error || note}</p>
            </section>

            {isNcMirror(table) && (
                <section className="p-4 space-y-2" style={CARD} aria-label={t('datatables.nc_write_title', 'Changes go both ways')}>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('datatables.nc_write_title', 'Changes go both ways')}</h3>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('datatables.nc_write_body', 'Rows added, changed or deleted here are written to Nextcloud first, and this copy is refreshed from what Nextcloud answered. When Nextcloud refuses a change — no permission there, a required column left empty — the refusal is shown here and nothing changes on either side.')}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('datatables.nc_columns_body', 'The columns are Nextcloud’s. Change them in Nextcloud; the next refresh brings them here.')}{' '}
                        {t('datatables.nc_no_retention', 'Rows are not aged out here — they stay as long as they are in Nextcloud.')}
                    </p>
                </section>
            )}

            {isSpreadsheetMirror(table) && (
                <>
                    <FileCard t={t} rel={rel} table={table} mirror={mirror} canEdit={canEdit} />
                    <WriteCard t={t} table={table} mirror={mirror} />
                    <IdentityCard t={t} mirror={mirror} />
                </>
            )}

            <RelationsCard t={t} table={table} mirror={mirror} canEdit={canEdit} onRefresh={refresh} />
        </div>
    );
}

/** The one-line version above the rows grid. */
export function SourceSyncStrip({ table, mirror, canWrite }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [busy, setBusy] = useState(false);
    const sync = mirror?.sync || null;
    const sourceName = sourceNameOf(table, mirror?.source);
    const Glyph = sourceGlyphOf(table);
    return (
        <div className="flex items-center gap-2 flex-wrap text-xs px-3 py-2 rounded-lg mb-3" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
            {Glyph && React.createElement(Glyph, { className: 'w-3.5 h-3.5 shrink-0', style: { color: 'var(--type-data)' }, 'aria-hidden': 'true' })}
            <StatusLine t={t} rel={rel} sync={sync} sourceName={sourceName} compact />
            {canWrite && (
                <button type="button" disabled={busy || sync?.status === 'running'}
                    onClick={async () => { setBusy(true); try { await mirror.refreshNow(); } catch { /* shown on the tab */ } finally { setBusy(false); } }}
                    className="inline-flex items-center gap-1 underline disabled:opacity-50" style={{ color: 'var(--text-primary)' }}>
                    <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {t('datatables.nc_refresh_now', 'Refresh now')}
                </button>
            )}
            <span className="ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                {sourceWritable(table, mirror?.source)
                    ? t('datatables.src_strip_write', 'Rows you change here are changed in {source}.', { source: sourceName })
                    : t('datatables.ss_strip_readonly', 'Rows cannot be changed here — change them in the file.')}
            </span>
        </div>
    );
}

function StatusLine({ t, rel, sync, sourceName, compact = false }) {
    const cls = compact ? '' : 'text-sm';
    if (!sync || sync.status === 'running') {
        return (
            <span className={`${cls} inline-flex items-center gap-1.5`} style={{ color: 'var(--text-secondary)' }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                {t('datatables.src_status_running', 'Refreshing from {source}…', { source: sourceName })}
            </span>
        );
    }
    if (sync.status === 'error') {
        return (
            <span className={`${cls} inline-flex items-start gap-1.5`} style={{ color: 'var(--warning)' }}>
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{t('datatables.nc_status_error', 'The last refresh failed: {error}', { error: sync.lastError || sync.lastErrorCode || '?' })}</span>
            </span>
        );
    }
    // Live: the ⚡, always. "checked" is the last successful pass — the
    // moment the copy was proven equal to the source.
    return (
        <span className={`${cls} inline-flex items-center gap-1.5`} style={{ color: 'var(--text-secondary)' }}>
            <Zap className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} aria-hidden="true" />
            {t('datatables.src_status_live', 'Live · in step with {source}', { source: sourceName })}
            <span style={{ color: 'var(--text-tertiary)' }}>
                {t('datatables.nc_live_last', '· checked {when}', { when: rel(sync.lastSuccessAt || sync.lastSyncAt) })}
            </span>
        </span>
    );
}

const CARD = { borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)' };
const BTN = 'px-3 py-2 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
