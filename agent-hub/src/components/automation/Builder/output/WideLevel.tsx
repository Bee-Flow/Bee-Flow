import { useLayoutEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { cellText } from './cellSummary';
import type { OutputColumn } from './columns';
import type { Crumb, Drill, Level, Opener, PageView, Return } from './levels';
import { cellOf, isPerItemRows, runNoteOf } from './perItem';
import RowDetail from './RowDetail';
import RunNote from './RunNote';
import { JsonTree } from './ScalarValue';
import useOutputColumns, { type OutputColumnsState } from './useOutputColumns';
import WideGrid from './WideGrid';
import WideHeader from './WideHeader';

const NO_FIELDS: readonly string[] = [];

/** What the shell hands every level: where it is, and how to move. */
export interface LevelNav {
    crumbs: Crumb[];
    onCrumb: (target: number) => void;
    /** Up one level; null at the top. */
    onBack: (() => void) | null;
    onDrill: (drill: Drill) => void;
    /** The list this level was just returned to from: it opens again in that row's details. */
    reveal: Return | null;
    /** Change this level's search, page or selected row. */
    onPatch: (patch: Partial<Level>) => void;
    /** ↑/↓ through the rows that match the search. */
    onMove: (delta: number) => void;
    json: boolean;
    onJson: (json: boolean) => void;
    compact: boolean;
    onToggleCompact: () => void;
    pickerOpen: boolean;
    onTogglePicker: () => void;
    onClose: () => void;
    /** Puts focus back in the view when a re-render here removed the focused button. */
    keepFocus: () => void;
}

interface WideLevelProps {
    /** This level's rows (resolved from the root by the shell). */
    rows: unknown[];
    cols: OutputColumnsState;
    level: Level;
    /** The search and page of `rows` (levels.ts pageView). */
    view: PageView;
    depth: number;
    /** The step's own value, for the run sentence at the top level. */
    source?: unknown;
    nav: LevelNav;
}

/** The text of a row's pinned cell, as the grid shows it. */
function titleOf(row: unknown, pinned: OutputColumn | null): string {
    return pinned ? cellText(cellOf(row, pinned, true), pinned) : '';
}

/**
 * What a row's crumb says: its pinned text, with "(row n)" when another row
 * of the same list shows the same text (four mails with one subject), or
 * "Row n" when it has none.
 */
export function rowNameOf(rows: unknown[], index: number, pinned: OutputColumn | null, t: TranslateFn): string {
    const title = titleOf(rows[index], pinned);
    if (!title) return t('automations.output.row_n', 'Row {n}', { n: index + 1 });
    const repeats = rows.some((r, i) => i !== index && titleOf(r, pinned) === title);
    return repeats ? t('automations.output.crumb_row', '{title} (row {n})', { title, n: index + 1 }) : title;
}

/**
 * One level of the large view: the toolbar, the grid (or the level's raw
 * JSON), the footer and the open row's details. The same component serves
 * the step's own rows and every list opened below them.
 */
export default function WideLevel({ rows, cols, level, view, depth, source, nav }: WideLevelProps) {
    const { t } = useTranslation();
    const byKey = useMemo(() => new Map(cols.columns.map(c => [c.key, c])), [cols.columns]);
    const shown = cols.wide.map(k => byKey.get(k)).filter((c): c is OutputColumn => !!c);
    const pinned = shown[0] || null;
    const perItem = isPerItemRows(rows);
    const selected = level.selected != null && rows[level.selected] !== undefined ? level.selected : null;
    const pos = selected == null ? -1 : view.filtered.findIndex(r => r.index === selected);
    const drill = (fromRow: number, key: string, label: string, from: Opener) => nav.onDrill({ fromRow, key, label, rowName: rowNameOf(rows, fromRow, pinned, t), from });
    // A level re-renders on its own (its columns live here when nested):
    // a ticked-off column's button is gone, and focus must not fall to <body>.
    useLayoutEffect(() => nav.keepFocus());

    return (
        <>
            <WideHeader
                crumbs={nav.crumbs}
                onCrumb={nav.onCrumb}
                onBack={nav.onBack}
                rowCount={rows.length}
                cols={cols}
                shownCount={shown.length}
                query={level.query}
                onQuery={(query) => nav.onPatch({ query, page: 0 })}
                pickerOpen={nav.pickerOpen}
                onTogglePicker={nav.onTogglePicker}
                compact={nav.compact}
                onToggleCompact={nav.onToggleCompact}
                json={nav.json}
                onJson={nav.onJson}
                onClose={nav.onClose}
            />
            {nav.json ? (
                <div className="flex-1 min-h-0"><JsonTree key={depth} value={rows} /></div>
            ) : (
                <div className={`flex-1 min-h-0 grid ${selected != null ? 'grid-cols-[minmax(0,1fr)_400px] @max-[900px]/wideout:grid-cols-1' : 'grid-cols-1'}`}>
                    <div className={`flex flex-col min-w-0 min-h-0 ${selected != null ? '@max-[900px]/wideout:hidden' : ''}`}>
                        <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
                            {view.pageRows.length
                                ? <WideGrid rows={view.pageRows} columns={shown} compact={nav.compact} selected={selected} onSelect={(i) => nav.onPatch({ selected: i })} onOpenList={(i, c) => drill(i, c.key, c.label, 'cell')} />
                                : <div className="p-6 text-[var(--text-tertiary)] italic">{t('automations.output.no_rows_match', 'No row matches "{q}".', { q: level.query })}</div>}
                        </div>
                        <LevelFooter view={view} source={depth === 0 ? source : undefined} onPage={(page) => nav.onPatch({ page })} />
                    </div>
                    {selected != null && (
                        <RowDetail
                            row={rows[selected]}
                            title={titleOf(rows[selected], pinned)}
                            index={selected}
                            total={rows.length}
                            canPrev={pos > 0}
                            canNext={pos >= 0 && pos < view.filtered.length - 1}
                            onPrev={() => nav.onMove(-1)}
                            onNext={() => nav.onMove(1)}
                            onClose={() => nav.onPatch({ selected: null })}
                            perItem={perItem}
                            onOpenList={(path, label) => drill(selected, path, label, 'detail')}
                            revealPath={nav.reveal?.row === selected ? nav.reveal.path : null}
                        />
                    )}
                </div>
            )}
        </>
    );
}

interface LevelFooterProps {
    view: PageView;
    /** The step's value at the top level (the run sentence); undefined deeper down. */
    source?: unknown;
    onPage: (page: number) => void;
}

/** "Rows 1 to 4 of 4 · Ran 4 times · all worked · Click a row for all its details", and paging. */
function LevelFooter({ view, source, onPage }: LevelFooterProps) {
    const { t } = useTranslation();
    const ran = runNoteOf(source) != null;
    const dot = <span aria-hidden className="text-[var(--text-tertiary)]">·</span>;
    return (
        <div className="h-[38px] shrink-0 flex items-center gap-2 px-3.5 border-t border-[var(--border-default)] text-[var(--text-secondary)] min-w-0">
            <span className="shrink-0">{t('automations.output.rows_range', 'Rows {from} to {to} of {total}', { from: view.from, to: view.to, total: view.filtered.length })}</span>
            {ran && <>{dot}<RunNote value={source} /></>}
            <span className="flex items-center gap-2 min-w-0 @max-[700px]/wideout:hidden">
                {dot}
                <span className="text-[var(--text-tertiary)] truncate">{t('automations.output.row_hint', 'Click a row for all its details')}</span>
            </span>
            <span className="ml-auto flex gap-1 shrink-0">
                <button type="button" disabled={view.safePage <= 0} onClick={() => onPage(view.safePage - 1)} aria-label={t('automations.output.prev_page', 'Previous page')} className="w-6 h-6 rounded-md border border-[var(--border-default)] grid place-items-center disabled:opacity-40"><ChevronLeft size={13} /></button>
                <button type="button" disabled={view.safePage >= view.pages - 1} onClick={() => onPage(view.safePage + 1)} aria-label={t('automations.output.next_page', 'Next page')} className="w-6 h-6 rounded-md border border-[var(--border-default)] grid place-items-center disabled:opacity-40"><ChevronRight size={13} /></button>
            </span>
        </div>
    );
}

/**
 * A list opened below the step's rows. Its columns are its own and are
 * remembered per list SHAPE (`<step>>output.attachments`), so a choice made
 * in mail 1's attachments holds in mail 2's, and never touches the step's.
 */
export function NestedLevel({ storageKey, ...props }: Omit<WideLevelProps, 'cols'> & { storageKey: string | null }) {
    const cols = useOutputColumns(props.rows, storageKey, NO_FIELDS);
    return <WideLevel {...props} cols={cols} />;
}
