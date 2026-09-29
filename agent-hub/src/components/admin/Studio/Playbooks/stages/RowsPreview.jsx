import { ExternalLink, Loader2, Table2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { revealSchedule } from '../../../../shared/builder/revealSchedule';
import { kindColorVar } from '../../../../shared/kindColors';
import { cellText } from '../../Datatables/datatableDisplay';
import { datatablesApi } from '../../Datatables/datatablesApi';

const PREVIEW_ROWS = 8;
const ROW_STAGGER_MS = 120;

/**
 * The table's values, so the person SEES what the routine extracted: the
 * first rows of the datatable in a compact grid, one row arriving after
 * another. Reads `GET /api/datatables/:id/rows` (the same page the Datatables
 * section shows); `refreshKey` re-reads (the fill's row count changing).
 * A door to the full table sits in the header.
 */
export default function RowsPreview({ datatableId, fields = [], rowCount = null, refreshKey = 0, t, onNavigate = null, reducedMotion = false, title = null, compact = false }) {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!datatableId) return undefined;
        let alive = true;
        datatablesApi.listRows(datatableId, { limit: PREVIEW_ROWS }).then((body) => {
            if (!alive) return;
            setRows(Array.isArray(body?.rows) ? body.rows : []);
            setError(null);
        }).catch((e) => { if (alive) { setError(e); setRows([]); } });
        return () => { alive = false; };
    }, [datatableId, refreshKey]);

    const columns = (Array.isArray(fields) ? fields : []).filter((f) => f && f.key).slice(0, compact ? 6 : 9);
    const list = Array.isArray(rows) ? rows : [];
    const schedule = revealSchedule(list.map((r, i) => String(r.id || i)), { stagger: ROW_STAGGER_MS });

    return (
        <section className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }} data-testid="playbook-rows-preview">
            <header className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border-default)' }}>
                <Table2 className="w-3.5 h-3.5 shrink-0" style={{ color: kindColorVar('datatable') }} aria-hidden="true" />
                <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{title || t('playbooks.rows.title', 'What landed in the table')}</span>
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                    {rows === null ? '' : t('playbooks.rows.showing', '{shown} of {total}', { shown: list.length, total: Number.isFinite(rowCount) ? rowCount : list.length })}
                </span>
                {onNavigate && (
                    <button type="button" onClick={() => onNavigate(`studio/datatables/${datatableId}`)} className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--type-ai)' }} data-testid="playbook-rows-open">
                        {t('playbooks.rows.open', 'Open the table')}<ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </button>
                )}
            </header>
            {rows === null ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.rows.loading', 'Reading the rows…')}
                </div>
            ) : error ? (
                <p className="px-3 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.rows.err', 'The rows could not be read right now.')}</p>
            ) : list.length === 0 ? (
                <p className="px-3 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.rows.empty', 'No rows yet.')}</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-[11px]" style={{ borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ background: 'var(--bg-primary)' }}>
                                {columns.map((c) => (
                                    <th key={c.key} className="text-left font-semibold px-3 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)' }}>{c.name || c.key}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {list.map((r, i) => {
                                const slot = schedule.get(String(r.id || i));
                                return (
                                    <tr key={r.id || i} className={reducedMotion ? '' : 'pbk-col-in'} style={{ '--pbk-delay': `${slot ? slot.delayMs : 0}ms`, borderBottom: '1px solid var(--border-default)' }} data-testid="playbook-rows-row">
                                        {columns.map((c) => (
                                            <td key={c.key} className="px-3 py-1.5 whitespace-nowrap max-w-[220px] truncate" style={{ color: 'var(--text-primary)' }} title={cellText(r[c.key], c.type)}>
                                                {cellText(r[c.key], c.type)}
                                            </td>
                                        ))}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
