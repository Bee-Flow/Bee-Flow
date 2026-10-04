import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { cellText, rowMatches } from './cellSummary';
import type { OutputColumn } from './columns';
import RowDetail from './RowDetail';
import { JsonTree } from './ScalarValue';
import type { OutputColumnsState } from './useOutputColumns';
import { getByDotted } from './valueHelpers';
import WideGrid from './WideGrid';
import WideHeader from './WideHeader';

const PAGE_SIZE = 25;

interface WideOutputViewProps {
    rows: unknown[];
    cols: OutputColumnsState;
    /** "Continues on · <step label>". */
    stepLabel?: string | null;
    /** Open with this row's details showing. */
    initialRow?: number | null;
    onClose: () => void;
}

/**
 * "Continues on", enlarged (artboard 4d): row search, the column picker,
 * Compact, a pinned first column, pagination and a row detail on the right.
 * Up to 2000 × 1100: on a large screen the enlarged view is really larger.
 */
export default function WideOutputView({ rows, cols, stepLabel = null, initialRow = null, onClose }: WideOutputViewProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [compact, setCompact] = useState(false);
    const [json, setJson] = useState(false);
    const [selected, setSelected] = useState<number | null>(initialRow);
    const [page, setPage] = useState(() => (initialRow != null ? Math.floor(initialRow / PAGE_SIZE) : 0));

    const byKey = useMemo(() => new Map(cols.columns.map(c => [c.key, c])), [cols.columns]);
    const shown = cols.wide.map(k => byKey.get(k)).filter((c): c is OutputColumn => !!c);
    const filtered = useMemo(
        () => rows.map((row, index) => ({ row, index })).filter(r => rowMatches(r.row, query)),
        [rows, query],
    );
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(page, pages - 1);
    const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const from = filtered.length ? safePage * PAGE_SIZE + 1 : 0;
    const to = safePage * PAGE_SIZE + pageRows.length;

    // Position of the selected row inside the filtered list, for ↑/↓.
    const pos = selected == null ? -1 : filtered.findIndex(r => r.index === selected);
    const move = useCallback((delta: number) => {
        if (pos < 0) return;
        const next = filtered[pos + delta];
        if (!next) return;
        setSelected(next.index);
        setPage(Math.floor((pos + delta) / PAGE_SIZE));
    }, [filtered, pos]);

    const focusRef = useCallback((el: HTMLDivElement | null) => { el?.focus(); }, []);
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const typing = (e.target as HTMLElement).tagName === 'INPUT';
        if (e.key === 'Escape') {
            e.stopPropagation();
            if (pickerOpen) setPickerOpen(false);
            else if (selected != null) setSelected(null);
            else onClose();
            return;
        }
        if (typing || selected == null) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    };

    const first = shown[0] || null;
    const detailTitle = selected != null && first ? cellText(getByDotted(rows[selected], first.key), first) : '';

    const body = (
        <div className="fixed inset-0 z-[1000] bg-black/30 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div
                ref={focusRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={t('automations.output.wide_title', 'Continues on · {step}', { step: stepLabel || '' })}
                onKeyDown={onKeyDown}
                className="@container/wideout w-full max-w-[2000px] h-[calc(100vh-64px)] max-h-[1100px] rounded-xl overflow-hidden shadow-2xl bg-[var(--bg-card)] text-[var(--text-primary)] flex flex-col text-xs outline-none"
                data-testid="output-wide-view"
            >
                <WideHeader
                    stepLabel={stepLabel}
                    rowCount={rows.length}
                    cols={cols}
                    shownCount={shown.length}
                    query={query}
                    onQuery={(q) => { setQuery(q); setPage(0); }}
                    pickerOpen={pickerOpen}
                    onTogglePicker={() => setPickerOpen(o => !o)}
                    compact={compact}
                    onToggleCompact={() => setCompact(c => !c)}
                    json={json}
                    onJson={setJson}
                    onClose={onClose}
                />
                {json ? (
                    <div className="flex-1 min-h-0"><JsonTree value={rows} /></div>
                ) : (
                    <div className={`flex-1 min-h-0 grid ${selected != null ? 'grid-cols-[minmax(0,1fr)_400px] @max-[900px]/wideout:grid-cols-1' : 'grid-cols-1'}`}>
                        <div className={`flex flex-col min-w-0 min-h-0 ${selected != null ? '@max-[900px]/wideout:hidden' : ''}`}>
                            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
                                {pageRows.length
                                    ? <WideGrid rows={pageRows} columns={shown} compact={compact} selected={selected} onSelect={setSelected} />
                                    : <div className="p-6 text-[var(--text-tertiary)] italic">{t('automations.output.no_rows_match', 'No row matches "{q}".', { q: query })}</div>}
                            </div>
                            <div className="h-[38px] shrink-0 flex items-center gap-3 px-3.5 border-t border-[var(--border-default)] text-[var(--text-secondary)]">
                                <span>{t('automations.output.rows_range', 'Rows {from} to {to} of {total}', { from, to, total: filtered.length })}</span>
                                <span className="text-[var(--text-tertiary)] truncate @max-[700px]/wideout:hidden">{t('automations.output.row_hint', 'Click a row for all its details')}</span>
                                <span className="ml-auto flex gap-1">
                                    <button type="button" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)} aria-label={t('automations.output.prev_page', 'Previous page')} className="w-6 h-6 rounded-md border border-[var(--border-default)] grid place-items-center disabled:opacity-40"><ChevronLeft size={13} /></button>
                                    <button type="button" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)} aria-label={t('automations.output.next_page', 'Next page')} className="w-6 h-6 rounded-md border border-[var(--border-default)] grid place-items-center disabled:opacity-40"><ChevronRight size={13} /></button>
                                </span>
                            </div>
                        </div>
                        {selected != null && rows[selected] !== undefined && (
                            <RowDetail
                                row={rows[selected]}
                                title={detailTitle}
                                index={selected}
                                total={rows.length}
                                canPrev={pos > 0}
                                canNext={pos >= 0 && pos < filtered.length - 1}
                                onPrev={() => move(-1)}
                                onNext={() => move(1)}
                                onClose={() => setSelected(null)}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
    return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}
