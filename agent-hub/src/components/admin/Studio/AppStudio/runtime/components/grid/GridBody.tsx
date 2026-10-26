import { flexRender } from '@tanstack/react-table';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent } from 'react';
import { tryEvaluate } from '@shared/expr/engine.mjs';
import useTranslation from '@/hooks/useTranslation';
import { roleTextColor } from '../../styleResolver';
import { ROLE_COLORS } from '../../styleResolver.constants';
import { EM_DASH } from '../../uiBits';
import { ALIGN_CLASS } from '../cellValue';
import { CLAMP_STYLE, rowToneStyle } from './gridConstants';
import type { GridAction, GridColumnMeta, GridRecord, GridRow, RunAction } from './gridTypes';

/**
 * The body rows of the App Studio data grid: a record row, the grouping that
 * buckets a page into groups, and a group's header row. Moved out of
 * AppDataGrid.jsx verbatim (they were render functions there).
 */

const ROLES = ROLE_COLORS as Record<string, string>;
type PeekHandler = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => void;

export interface GridBodyRowProps {
    row: GridRow;
    tone: string | null;
    activeWhen: unknown;
    scope: Record<string, unknown>;
    cards: boolean;
    isRun: boolean;
    clickable: boolean;
    fireRowClick: (row: GridRow) => void;
    selectable: string;
    cellPad: string;
    divider: string;
    clampLines: number;
    showPeek: PeekHandler;
    hidePeek: () => void;
    runAction: RunAction;
    rowActions: GridAction[];
}

export function GridBodyRow({
    row, tone, activeWhen, scope, cards, isRun, clickable, fireRowClick, selectable,
    cellPad, divider, clampLines, showPeek, hidePeek, runAction, rowActions,
}: GridBodyRowProps) {
    const { t } = useTranslation();
    const selected = row.getIsSelected();
    // The ACTIVE row (spec: activeWhen) — the same per-row formula contract
    // as list.selectedWhen: `item` and `index` in scope, truthiness wins.
    // This is what makes the vars-driven master/detail pattern visible:
    // onRowClick stores the row in a variable, and the formula marks it.
    const active = activeWhen
        ? !!tryEvaluate(String(activeWhen), { ...scope, item: row.original, index: row.index }).value
        : false;
    return (
        <tr
            data-selected={selected || undefined}
            data-app-row-active={active || undefined}
            data-app-row-tone={tone || (active && cards ? 'primary' : undefined)}
            onClick={clickable ? () => fireRowClick(row) : undefined}
            // A clickable row is a control, so it has to BE one: it was a
            // bare <tr onClick> with no tab stop and no key handler, which
            // made every record in a master/detail app unreachable without
            // a mouse.
            {...(clickable && isRun ? {
                tabIndex: 0,
                role: 'button',
                onKeyDown: (e: KeyboardEvent) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    fireRowClick(row);
                },
            } : {})}
            // A clickable row now LOOKS clickable: the cursor was the only
            // affordance, which reads as a static report rather than a list
            // you can open. The tint lives in app-tokens.css so it follows
            // the app's primary colour.
            className={clickable && isRun ? 'cursor-pointer app-grid-row-clickable app-focusable' : ''}
            // Under 'cards' the tds paint their own card surface, so the
            // selection wash moves to the tds too (app-tokens.css keys it
            // off data-selected) — an inline tr background would be hidden.
            // Selection still wins over a tone: it is the thing the person
            // just did, and it is temporary.
            //
            // Under 'cards' the tone is handed over as a CSS variable and
            // painted onto the tds instead (app-tokens.css): the cells own
            // the card surface, and an inline box-shadow here would replace
            // the card's elevation with the tone bar rather than add to it.
            // Precedence: selection (the person's own, temporary gesture)
            // over active (the app's state) over rowTone. Active takes the
            // wash AND the edge bar — a row cannot carry two edge bars, and
            // "this is the one you are looking at" outranks a status tint.
            style={(selected && !cards
                ? { background: 'var(--app-primary-soft)' }
                : active
                    ? (cards
                        ? { '--app-row-tone': 'var(--app-primary)' }
                        : { background: 'var(--app-primary-soft)', boxShadow: 'inset 3px 0 0 0 var(--app-primary)' })
                    : (tone
                        ? (cards
                            ? { '--app-row-tone': ROLES[tone] }
                            : { ...rowToneStyle(tone), '--app-row-tone': ROLES[tone] })
                        : undefined)) as CSSProperties | undefined}
        >
            {selectable !== 'none' ? (
                <td className={`${cellPad}${divider} align-middle`} style={{ borderColor: 'var(--border-default)' }} onClick={(e: MouseEvent) => e.stopPropagation()}>
                    <input
                        type="checkbox"
                        aria-label={t('studio_apps_runtime.grid.select_row', 'Select row')}
                        checked={selected}
                        onChange={row.getToggleSelectedHandler()}
                        className="accent-[var(--app-primary)]"
                    />
                </td>
            ) : null}
            {row.getVisibleCells().map((cell) => {
                const meta = (cell.column.columnDef.meta || {}) as GridColumnMeta;
                // Either kind of clipping earns the peek: a clamp hides
                // lines, a truncate hides the end of one.
                const clips = !!clampLines || !!meta.truncate;
                return (
                    <td
                        key={cell.id}
                        // align-middle, not align-top: a row mixing a pill, a
                        // date and a number had each sitting on a different
                        // baseline, which is most of why the grid read as
                        // ragged rather than as a table.
                        className={`${cellPad}${divider} align-middle ${ALIGN_CLASS[meta.align || 'left']}${meta.truncate ? ' truncate max-w-0' : ''}`}
                        style={{ borderColor: 'var(--border-default)' }}
                        // The full value stays reachable when it is clamped —
                        // hiding text is only acceptable if nothing is lost.
                        // A native `title` was the first answer and the wrong
                        // one for this: these cells hold a paragraph of AI
                        // reasoning, and an OS tooltip renders that as an
                        // unreadable slab after a second's delay. Focus is
                        // wired alongside hover so the keyboard reaches it.
                        onMouseEnter={clips ? showPeek : undefined}
                        onMouseLeave={clips ? hidePeek : undefined}
                        onFocus={clips ? showPeek : undefined}
                        onBlur={clips ? hidePeek : undefined}
                    >
                        {(() => {
                            const body = clampLines ? (
                                <span className="block overflow-hidden" data-app-clamped="true" style={CLAMP_STYLE[clampLines]}>
                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </span>
                            ) : flexRender(cell.column.columnDef.cell, cell.getContext());
                            // A column carrying an actionId turns its cells
                            // into buttons. stopPropagation so it does not
                            // ALSO fire the row click — two different things
                            // happening from one press is never what anyone
                            // meant.
                            if (!isRun || !meta.actionId) return body;
                            return (
                                <button
                                    type="button"
                                    onClick={(e: MouseEvent) => { e.stopPropagation(); runAction(meta.actionId as string, { formValues: cell.row.original, item: cell.row.original }); }}
                                    className="w-full cursor-pointer bg-transparent p-0 text-left"
                                    title={t('studio_apps_runtime.grid.click_to_edit', 'Click to edit')}
                                >
                                    {body}
                                </button>
                            );
                        })()}
                    </td>
                );
            })}
            {rowActions.length ? (
                <td className={`${cellPad}${divider} align-middle`} style={{ borderColor: 'var(--border-default)' }} onClick={(e: MouseEvent) => e.stopPropagation()}>
                    <div className="flex items-center gap-1.5">
                        {rowActions.map((a, i) => (
                            <button
                                key={i}
                                type="button"
                                // `item` as well as formValues, matching
                                // onRowClick/onRowSelect above and every
                                // other row-context surface (list, kanban).
                                // Without it an action authored as
                                // `item.id` — the obvious spelling, and the
                                // one that works from every OTHER row
                                // control — resolved to nothing here, so the
                                // button ran, reported success and wrote
                                // nothing. A row action that silently does
                                // nothing is worse than one that errors.
                                onClick={() => { if (isRun && a.actionId) runAction(a.actionId, { formValues: row.original, item: row.original }); }}
                                className="px-2 py-0.5 text-xs font-medium border"
                                style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-secondary)' }}
                            >
                                {a.label}
                            </button>
                        ))}
                    </div>
                </td>
            ) : null}
        </tr>
    );
}

export interface GridGroup {
    value: string;
    label: string;
    tone: string;
    rows: GridRow[];
}

// Grouping buckets the CURRENT page's rows (spec: groupBy). Deliberately
// page-local: sorting and pagination keep exactly their meaning, and a
// header counts what is on screen. Bucketing is stable, so the tanstack
// sort order is preserved WITHIN each group untouched.
export function groupPageRows(pageRows: GridRow[], groupBy: string, groupOrder: unknown): GridGroup[] {
    const byVal = new Map<string, GridRow[]>();
    for (const row of pageRows) {
        const raw = row.original ? row.original[groupBy] : null;
        const val = raw == null || raw === '' ? '' : String(raw);
        if (!byVal.has(val)) byVal.set(val, []);
        byVal.get(val)!.push(row);
    }
    const out: GridGroup[] = [];
    const seen = new Set<string>();
    for (const g of (Array.isArray(groupOrder) ? groupOrder : []) as Array<GridRecord | null>) {
        if (!g || g.value == null) continue;
        const val = String(g.value);
        if (seen.has(val) || !byVal.has(val)) continue;
        seen.add(val);
        out.push({ value: val, label: g.label || val, tone: g.tone || 'neutral', rows: byVal.get(val)! });
    }
    // Values the author did not list follow the listed ones, in data order.
    for (const [val, rows] of byVal) {
        if (!seen.has(val)) out.push({ value: val, label: val === '' ? EM_DASH : val, tone: 'neutral', rows });
    }
    return out;
}

export interface GridGroupHeaderRowProps {
    g: GridGroup;
    open: boolean;
    onToggle: (value: string) => void;
    colSpan: number;
}

export function GridGroupHeaderRow({ g, open, onToggle, colSpan }: GridGroupHeaderRowProps) {
    return (
        <tr data-app-grid-group={g.value} data-app-grid-group-open={open || undefined}>
            <td
                colSpan={colSpan}
                className="p-0"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
            >
                <button
                    type="button"
                    onClick={() => onToggle(g.value)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left font-semibold uppercase"
                    // roleTextColor, not the raw role hex: the header is
                    // TEXT on a quiet surface and has to read in dark mode.
                    style={{
                        fontSize: 11,
                        letterSpacing: '0.03em',
                        color: g.tone && g.tone !== 'neutral' && ROLES[g.tone]
                            ? roleTextColor(g.tone)
                            : 'var(--text-secondary)',
                    }}
                >
                    {open
                        ? <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
                        : <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />}
                    <span>{g.label} · {g.rows.length}</span>
                </button>
            </td>
        </tr>
    );
}
