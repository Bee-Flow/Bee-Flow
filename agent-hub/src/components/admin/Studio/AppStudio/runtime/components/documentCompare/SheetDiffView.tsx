// Two spreadsheets compared per tab. The rows come ALIGNED from the server
// (an inserted row is one added row, not every row below it changed), so each
// row of the answer is one row here:
//
//   side    the left sheet's cells | the right sheet's cells, changed cells marked
//   inline  one grid, a changed cell showing old → new, added rows green, removed struck
//
// A formula that changed carries both formulas in the cell's tooltip.

import { useMemo, useRef, useState } from 'react';
import type { CellChange, ColumnPair, RowPair, SheetCompare, TabCompare } from '@/api/queries/studioAppDocuments';
import useTranslation from '@/hooks/useTranslation';
import type { CompareMode } from './CompareToolbar';
import type { TFn } from './summary';
import { useDomStepper, type RegisterStep } from './useStepper';

const HEAD = 'sticky top-0 z-10 border-b border-r border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-left text-[11px] font-medium text-[var(--text-secondary)]';
const NUM = 'border-b border-r border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-right text-[11px] tabular-nums text-[var(--text-secondary)]';
const CELL = 'max-w-[14rem] truncate border-b border-r border-[var(--border-subtle)] px-2 py-1 text-[12px]';
const ADDED = 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)]';
const REMOVED = 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] line-through decoration-[var(--error-ink)]';
const CHANGED = 'bg-[color-mix(in_srgb,var(--warning)_20%,transparent)] font-medium';
const SPLIT = 'border-l-2 border-l-[var(--border-default)]';

function colTitle(c: ColumnPair, side: 'left' | 'right'): string {
    const letter = side === 'left' ? c.left : c.right;
    return [letter, c.header].filter(Boolean).join(' · ');
}

function formulaTip(t: TFn, change: CellChange | undefined): string | undefined {
    if (!change || (!change.beforeFormula && !change.afterFormula)) return undefined;
    return t('studio_app_documents.formula_tip', 'Formula: {before} → {after}', { before: change.beforeFormula || change.before || '∅', after: change.afterFormula || change.after || '∅' });
}

function rowClass(row: RowPair, side: 'left' | 'right'): string {
    if (row.op === 'added' && side === 'right') return ADDED;
    if (row.op === 'removed' && side === 'left') return REMOVED;
    return '';
}

function SideTable({ tab, rows }: { tab: TabCompare; rows: RowPair[] }) {
    const { t } = useTranslation();
    const cols = tab.columns;
    const byCol = (row: RowPair) => new Map(row.cells.map((c) => [c.col, c]));
    return (
        <table className="border-separate border-spacing-0">
            <thead>
                <tr>
                    <th className={HEAD} scope="col"><span className="sr-only">{t('studio_app_documents.row', 'Row')}</span></th>
                    {cols.map((c, i) => <th key={`l${i}`} className={`${HEAD} ${c.op === 'removed' ? REMOVED : ''}`} scope="col">{c.op === 'added' ? '' : colTitle(c, 'left')}</th>)}
                    <th className={`${HEAD} ${SPLIT}`} scope="col"><span className="sr-only">{t('studio_app_documents.row', 'Row')}</span></th>
                    {cols.map((c, i) => <th key={`r${i}`} className={`${HEAD} ${c.op === 'added' ? ADDED : ''}`} scope="col">{c.op === 'removed' ? '' : colTitle(c, 'right')}</th>)}
                </tr>
            </thead>
            <tbody>
                {rows.map((row, ri) => {
                    const changes = byCol(row);
                    return (
                        <tr key={ri} data-sheet-row={row.op} {...(row.op !== 'equal' ? { 'data-sheet-change': 'true' } : {})}>
                            <th className={NUM} scope="row">{row.left ?? ''}</th>
                            {cols.map((c, i) => (
                                <td key={`l${i}`} className={`${CELL} ${rowClass(row, 'left')} ${changes.has(i) ? CHANGED : ''}`} title={formulaTip(t, changes.get(i)) ?? (row.before[i] || undefined)}>{c.op === 'added' ? '' : row.before[i]}</td>
                            ))}
                            <th className={`${NUM} ${SPLIT}`} scope="row">{row.right ?? ''}</th>
                            {cols.map((c, i) => (
                                <td key={`r${i}`} className={`${CELL} ${rowClass(row, 'right')} ${changes.has(i) ? CHANGED : ''} ${c.op === 'added' ? ADDED : ''}`} title={formulaTip(t, changes.get(i)) ?? (row.after[i] || undefined)}>{c.op === 'removed' ? '' : row.after[i]}</td>
                            ))}
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function InlineTable({ tab, rows }: { tab: TabCompare; rows: RowPair[] }) {
    const { t } = useTranslation();
    return (
        <table className="border-separate border-spacing-0">
            <thead>
                <tr>
                    <th className={HEAD} scope="col"><span className="sr-only">{t('studio_app_documents.row', 'Row')}</span></th>
                    {tab.columns.map((c, i) => <th key={i} className={`${HEAD} ${c.op === 'added' ? ADDED : ''} ${c.op === 'removed' ? REMOVED : ''}`} scope="col">{colTitle(c, c.op === 'removed' ? 'left' : 'right')}</th>)}
                </tr>
            </thead>
            <tbody>
                {rows.map((row, ri) => {
                    const changes = new Map(row.cells.map((c) => [c.col, c]));
                    const tone = row.op === 'added' ? ADDED : (row.op === 'removed' ? REMOVED : '');
                    return (
                        <tr key={ri} data-sheet-row={row.op} {...(row.op !== 'equal' ? { 'data-sheet-change': 'true' } : {})}>
                            <th className={NUM} scope="row">{row.right ?? row.left ?? ''}</th>
                            {tab.columns.map((c, i) => {
                                const change = changes.get(i);
                                if (change) {
                                    return (
                                        <td key={i} className={`${CELL} ${CHANGED}`} title={formulaTip(t, change)}>
                                            {change.before ? <del className="text-[var(--error-ink)]">{change.before}</del> : null}
                                            {change.before && change.after ? ' → ' : null}
                                            {change.after ? <ins className="no-underline text-[var(--success-ink)]">{change.after}</ins> : null}
                                        </td>
                                    );
                                }
                                const value = row.op === 'removed' || c.op === 'removed' ? row.before[i] : row.after[i];
                                return <td key={i} className={`${CELL} ${tone} ${c.op === 'added' ? ADDED : ''} ${c.op === 'removed' ? REMOVED : ''}`}>{value}</td>;
                            })}
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

function tabOpLabel(t: TFn, op: TabCompare['op']): string {
    if (op === 'added') return t('studio_app_documents.op_added', 'Added');
    if (op === 'removed') return t('studio_app_documents.op_removed', 'Removed');
    if (op === 'changed') return t('studio_app_documents.op_changed', 'Changed');
    return t('studio_app_documents.op_same', 'Same');
}

export default function SheetDiffView({ result, mode, onlyChanges, registerStep }: {
    result: SheetCompare; mode: CompareMode; onlyChanges: boolean; registerStep: RegisterStep;
}) {
    const { t } = useTranslation();
    const firstChange = Math.max(0, result.tabs.findIndex((tb) => tb.op !== 'equal'));
    // A new compare remounts this view (its parent keys it), so the first changed tab is the start.
    const [selected, setSelected] = useState(firstChange);
    const tab = result.tabs[Math.min(selected, result.tabs.length - 1)];
    const rows = useMemo(() => (tab ? tab.rows.filter((r) => !onlyChanges || r.op !== 'equal') : []), [tab, onlyChanges]);
    const ref = useRef<HTMLDivElement | null>(null);
    useDomStepper(ref, '[data-sheet-change]', registerStep, `${selected}:${mode}:${onlyChanges}`);
    if (!tab) return <p className="m-0 p-6 text-center text-sm text-[var(--text-muted)]">{t('studio_app_documents.sheet_empty', 'This tab is empty.')}</p>;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {result.tabs.length > 1 ? (
                <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-default)] px-2 py-1" role="tablist" aria-label={t('studio_app_documents.tabs', 'Tabs')}>
                    {result.tabs.map((tb, i) => (
                        <button key={i} type="button" role="tab" aria-selected={i === selected} onClick={() => setSelected(i)} data-tab-op={tb.op}
                            className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-secondary)] aria-selected:bg-[var(--bg-tertiary)] aria-selected:text-[var(--text-primary)]">
                            {tb.name}
                            {tb.op !== 'equal' ? <span className="text-[10.5px] text-[var(--text-muted)]">({tabOpLabel(t, tb.op)})</span> : null}
                        </button>
                    ))}
                </div>
            ) : null}
            <div ref={ref} className="min-h-0 flex-1 overflow-auto [&_[data-current-change]>*]:outline [&_[data-current-change]>*]:outline-1 [&_[data-current-change]>*]:outline-[var(--app-accent,#2563eb)]">
                {rows.length ? (mode === 'side' ? <SideTable tab={tab} rows={rows} /> : <InlineTable tab={tab} rows={rows} />)
                    : <p className="m-0 p-6 text-center text-sm text-[var(--text-muted)]" data-compare-same="true">{t('studio_app_documents.tab_same', 'Nothing changed on this tab.')}</p>}
                {tab.hiddenRows > 0 ? <p className="m-0 p-2 text-xs text-[var(--text-muted)]">{t('studio_app_documents.rows_hidden', '{n} unchanged rows are not shown.', { n: tab.hiddenRows })}</p> : null}
            </div>
        </div>
    );
}
