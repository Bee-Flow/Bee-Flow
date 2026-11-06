import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { QUERY_LOG_PAGE_SIZE, downloadKbQueryLogCsv, useKbQueryLogList, type QueryLogFilters as Filters } from '@/api/queries/kbQueryLog';
import QueryLogDetail from './QueryLogDetail';
import QueryLogFilters from './QueryLogFilters';
import QueryLogTable from './QueryLogTable';

/**
 * "Search log": what people asked this knowledge base, what was found and
 * answered, for the people who manage it. Managers with the `kb_query_log`
 * licence only (the tab is not offered otherwise, and the server answers 404
 * to everyone else).
 */
export default function QueryLogTab({ kbId }: { kbId: string }) {
    const { t } = useTranslation();
    const [filters, setFilters] = useState<Filters>({});
    const [offset, setOffset] = useState(0);
    const [openId, setOpenId] = useState<string | null>(null);
    const [exportError, setExportError] = useState<string | null>(null);
    const list = useKbQueryLogList(kbId, filters, offset);
    // People seen so far, so the person filter keeps offering them after it narrows the list.
    const [seen, setSeen] = useState<Record<string, string>>({});
    const rows = list.data?.rows ?? [];
    // A base that hides names sends a pseudonym instead of the id: the person filter takes that label.
    const who = (r: (typeof rows)[number]) => ({ id: r.askerPseudonymId || r.askerPseudonym || r.userId, name: r.askerPseudonym || r.userName || r.userId });
    const fresh = rows.map(who).filter((p) => p.id && seen[p.id] !== p.name);
    if (fresh.length > 0) setSeen({ ...seen, ...Object.fromEntries(fresh.map((p) => [p.id, p.name])) });
    const total = list.data?.total ?? 0;
    const last = Math.min(offset + QUERY_LOG_PAGE_SIZE, total);

    const exportCsv = async () => {
        setExportError(null);
        try { await downloadKbQueryLogCsv(kbId, filters); } catch (e) {
            setExportError((e as Error).message || t('knowledge.query_log.err_export', 'Could not export the log.'));
        }
    };

    return (
        <div className="flex flex-col gap-4" data-testid="kb-tab-query-log">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <QueryLogFilters
                    value={filters}
                    people={Object.entries(seen).map(([id, name]) => ({ id, name }))}
                    onChange={(next) => { setFilters(next); setOffset(0); }}
                />
                <button type="button" onClick={exportCsv} data-testid="kb-ql-export" className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs [border-color:var(--border-default)] text-[var(--text-secondary)]">
                    <Download className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('knowledge.query_log.export', 'Export CSV')}
                </button>
            </div>
            {exportError && <p className="text-xs text-[var(--error)]" role="alert">{exportError}</p>}
            {list.isError && <p className="text-xs text-[var(--error)]" role="alert">{list.error.message}</p>}
            {list.isPending && <Loader2 className="w-4 h-4 animate-spin text-[var(--text-tertiary)]" aria-label={t('knowledge.loading', 'Loading…')} />}
            {list.data && rows.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)]" data-testid="kb-ql-empty">{t('knowledge.query_log.empty', 'Nothing logged yet for these filters.')}</p>
            )}
            {rows.length > 0 && <QueryLogTable rows={rows} selectedId={openId} onOpen={setOpenId} />}
            {total > 0 && (
                <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
                    <span>{t('knowledge.query_log.range', '{from}–{to} of {total}', { from: offset + 1, to: last, total })}</span>
                    <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - QUERY_LOG_PAGE_SIZE))} data-testid="kb-ql-prev" className="rounded-md border px-2 py-0.5 disabled:opacity-40 [border-color:var(--border-default)]">
                        {t('knowledge.query_log.prev', 'Previous')}
                    </button>
                    <button type="button" disabled={last >= total} onClick={() => setOffset(offset + QUERY_LOG_PAGE_SIZE)} data-testid="kb-ql-next" className="rounded-md border px-2 py-0.5 disabled:opacity-40 [border-color:var(--border-default)]">
                        {t('knowledge.query_log.next', 'Next')}
                    </button>
                </div>
            )}
            <QueryLogDetail kbId={kbId} entry={rows.find((r) => r.id === openId) ?? null} onClose={() => setOpenId(null)} />
        </div>
    );
}
