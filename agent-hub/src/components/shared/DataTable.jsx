import React from 'react';
import { TONES } from './statusTone';
import useContainerWidth from './useContainerWidth';

/**
 * DataTable — the ONE table pattern of the Compliance Center (artboards 1b
 * checks, 1c requests, 1d SoA; also incidents, risks, access log): a rounded
 * card, a 10px uppercase header row, grid rows whose columns come from ONE
 * `columns[]` so header and rows can never drift apart, a status stripe as
 * an inset box-shadow (it does not eat a pixel of the first column), an
 * optional footer (a Pager) and a card list for phones.
 *
 * The table is CSS grid, not <table>: the artboard's rows expand in place
 * (1b: a check's "Why it matters · How to fix · History" opens under it as a
 * full-width block), which a real table row cannot do without colspan
 * gymnastics. Roles keep it a table for assistive tech.
 *
 * Column folding: a column with `foldBelow: 1180` (or `900`) disappears
 * when the CARD is narrower than that, a container query, so it folds inside
 * a 1fr column next to an open drawer and not only on a narrow window. A
 * folded column must also give its grid TRACK back, or the empty track keeps
 * squeezing the title column. So the grid is not one inline template but
 * three custom properties, set on the header and every row from the same
 * `columns[]`: `--ct-cols` (every column), `--ct-cols-1180` (without the
 * 1180 folds) and `--ct-cols-900` (without the 900 and 1180 folds), and the
 * literal `TABLE_GRID` classes pick the one that matches the card's width.
 * The fold and grid classes are literals and the container is named `ctable`
 * IN THIS FILE: Tailwind emits only literals it can read, so the one
 * container name this file knows is the one the fold works with (the same
 * trick as StudioSectionHeader's OBJHEAD_FOLD). A host that passes another
 * `containerName` opts out of folding. `TABLE_FOLDED_ONLY[1180|900]` is the
 * opposite class, for a value a host repeats under the title only while its
 * own column is folded.
 *
 * Rows are the host's: `renderRow(row, ctx)` returns a `TableRow` (or
 * several — a row plus its expansion). `TableRow` carries the recipe every
 * register shares: `accent` paints the 3px stripe in the STATUS tone
 * (never the severity — design rule 5), `selected` is the drawer's row
 * (bg-secondary + the area's teal stripe, 1c/1d), `expanded` is 1b's open
 * row (bg-secondary, stripe stays the status'). A row with `onClick` is a
 * keyboard-operable row (Enter/Space), mirroring FindingRow.
 *
 * Phones: the host passes `isMobile` (useViewport) and `renderCard(row)`;
 * the table then renders each row through renderCard inside a >=44px list
 * (artboard 1h), so the register pages get their 390px variant for free.
 * `cardsBelow` (px) does the same on any device whenever the CARD itself is
 * narrower than that (a 1024 window, a table beside an open drawer): the
 * width is observed (useContainerWidth), because a container query can hide
 * a column but cannot swap a row for a card.
 */

export const TABLE_CONTAINER = 'ctable';

/**
 * The fold literals: both the header cell and the body cell of a folding
 * column get one. Spelled out because Tailwind needs it so.
 */
export const TABLE_FOLD = '@max-[1180px]/ctable:hidden';
export const TABLE_FOLD_NARROW = '@max-[900px]/ctable:hidden';

/**
 * "Show this only while column X is folded": a host puts a folded column's
 * value under the title (Owner, Article) with the class of that column's tier,
 * so nothing a wide card shows is lost on a narrow one.
 */
export const TABLE_FOLDED_ONLY = Object.freeze({
    1180: 'hidden @max-[1180px]/ctable:inline',
    900: 'hidden @max-[900px]/ctable:inline',
});

/** The header/row grid: the custom property that matches the card's width. */
export const TABLE_GRID = '[grid-template-columns:var(--ct-cols)] @max-[1180px]/ctable:[grid-template-columns:var(--ct-cols-1180)] @max-[900px]/ctable:[grid-template-columns:var(--ct-cols-900)]';

/** The fold tiers, widest first. A column folds in every tier at or below its own. */
const FOLD_TIERS = Object.freeze([1180, 900]);

function foldsAt(column, tier) {
    const fold = column?.foldBelow;
    return FOLD_TIERS.includes(fold) && fold >= tier;
}

/**
 * The grid template from `columns[].width` ('18px' | '1fr' | '84px' ...).
 * With a `tier` (1180 or 900) the columns that are folded at that width
 * leave no track behind.
 */
export function gridTemplate(columns = [], tier = null) {
    const kept = tier ? columns.filter((c) => !foldsAt(c, tier)) : columns;
    return kept.map((c) => c?.width || '1fr').join(' ') || '1fr';
}

/** The three custom properties TABLE_GRID reads, for a header's or row's style. */
function gridVars(columns = []) {
    return {
        '--ct-cols': gridTemplate(columns),
        '--ct-cols-1180': gridTemplate(columns, 1180),
        '--ct-cols-900': gridTemplate(columns, 900),
    };
}

function foldClass(column) {
    if (column?.foldBelow === 1180) return TABLE_FOLD;
    if (column?.foldBelow === 900) return TABLE_FOLD_NARROW;
    return '';
}

function alignClass(align) {
    if (align === 'right') return 'text-right justify-end';
    if (align === 'center') return 'text-center justify-center';
    return '';
}

/** The stripe colour for a row: status tone raw, or the area's teal for 'kind'. */
export function accentColor(accent) {
    if (accent === 'kind') return 'var(--kind-compliance)';
    return TONES[accent]?.raw ?? null;
}

/** A body cell: min-w-0 so long text truncates, the fold class when its column folds. */
export function TableCell({ column = null, children = null, className = '', align = undefined, testId = undefined }) {
    return (
        <div
            role="cell"
            data-testid={testId}
            className={`min-w-0 ${foldClass(column)} ${alignClass(align || column?.align)} ${className}`.replace(/\s+/g, ' ').trim()}
        >
            {children}
        </div>
    );
}

/** The header row. A column's `ariaSort` ('ascending' | 'descending') marks the column the rows are sorted by. */
export function TableHeader({ columns = [], className = '', testId = undefined }) {
    return (
        <div
            role="row"
            data-testid={testId}
            className={`grid ${TABLE_GRID} gap-3 px-3.5 py-2 border-b border-[var(--border-default)] text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] ${className}`.trim()}
            style={gridVars(columns)}
        >
            {columns.map((c) => (
                <span
                    key={c.id}
                    role="columnheader"
                    data-column={c.id}
                    aria-sort={c.ariaSort || undefined}
                    className={`min-w-0 truncate ${foldClass(c)} ${alignClass(c.align)}`.replace(/\s+/g, ' ').trim()}
                >
                    {c.label}
                </span>
            ))}
        </div>
    );
}

/**
 * A clickable row's hover and keyboard focus. The focus mark is an inset
 * OUTLINE, not a ring: the status stripe is an inline box-shadow, and an
 * inline box-shadow overrides a Tailwind ring, so a ring never showed on a
 * striped row.
 */
const ROW_FOCUS = 'cursor-pointer hover:bg-[var(--bg-secondary)] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--focus-ring)]';

export function TableRow({
    accent = null,
    selected = false,
    expanded = false,
    onClick = null,
    ariaExpanded = undefined,
    columns = [],
    children = null,
    className = '',
    testId = undefined,
    style = undefined,
}) {
    const clickable = typeof onClick === 'function';
    // The selected row wears the area's colour: it is the row the drawer is
    // about, and its status is written in the drawer's own clock block.
    const stripe = selected ? accentColor('kind') : accentColor(accent);
    const tinted = selected || expanded;
    // A row without columns (a host-drawn block) keeps whatever grid its
    // host gives it; a row with columns reads the table's three templates.
    const tracked = Array.isArray(columns) && columns.length > 0;
    // Only the row ITSELF answers the keyboard: a button inside a row (Open
    // fix, Rerun) has its own Enter, and a key pressed there must not also
    // open the row underneath it.
    const interactive = clickable ? {
        tabIndex: 0,
        onClick,
        onKeyDown: (e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
        },
    } : null;
    return (
        <div
            role="row"
            {...interactive}
            aria-expanded={ariaExpanded ?? (expanded ? true : undefined)}
            aria-selected={selected || undefined}
            data-testid={testId}
            data-accent={selected ? 'kind' : accent || undefined}
            data-selected={selected || undefined}
            data-expanded={expanded || undefined}
            className={[
                'grid gap-3 items-center px-3.5 py-2 border-b border-[var(--border-default)] text-xs',
                tracked ? TABLE_GRID : '',
                tinted ? 'bg-[var(--bg-secondary)]' : '',
                clickable ? ROW_FOCUS : '',
                className,
            ].join(' ').replace(/\s+/g, ' ').trim()}
            style={{
                ...(tracked ? gridVars(columns) : null),
                boxShadow: stripe ? `inset 3px 0 0 ${stripe}` : undefined,
                ...style,
            }}
        >
            {children}
        </div>
    );
}

function SkeletonRows({ columns, count }) {
    return Array.from({ length: count }).map((_, i) => (
        <div
            key={i}
            role="row"
            aria-hidden="true"
            data-testid="table-skeleton-row"
            className={`grid ${TABLE_GRID} gap-3 items-center px-3.5 py-2.5 border-b border-[var(--border-default)] animate-pulse`}
            style={gridVars(columns)}
        >
            {columns.map((c) => (
                <span key={c.id} className={`block h-2.5 rounded bg-[var(--bg-tertiary)] ${foldClass(c)}`.trim()} style={{ width: c.width === '1fr' ? '60%' : '80%' }} />
            ))}
        </div>
    ));
}

export default function DataTable({
    columns = [],
    rows = [],
    rowKey = (row, i) => row?.id ?? i,
    renderRow,
    renderCard = null,
    isMobile = false,
    cardsBelow = 0,
    loading = false,
    skeletonRows = 6,
    empty = null,
    footer = null,
    containerName = TABLE_CONTAINER,
    className = '',
    ariaLabel = undefined,
    testId = undefined,
}) {
    // The card list on a phone, and on any device while the card is
    // narrower than `cardsBelow` (unknown width = the table).
    const observe = cardsBelow > 0 && typeof renderCard === 'function';
    const [rootRef, width] = useContainerWidth(observe);
    const narrow = observe && width !== null && width < cardsBelow;
    const cards = (isMobile || narrow) && typeof renderCard === 'function';
    // The container class must be a literal for Tailwind; only `ctable` is
    // emitted here. Another name still gets a container (for a host's own
    // CSS), just not this file's fold.
    const containerClass = containerName === TABLE_CONTAINER ? '@container/ctable' : `@container/${containerName}`;
    const ctx = { columns, isMobile: cards, gridTemplateColumns: gridTemplate(columns) };
    const list = Array.isArray(rows) ? rows : [];

    let body;
    if (loading) {
        body = cards
            ? <div role="list" aria-busy="true" className="flex flex-col"><SkeletonRows columns={columns.slice(0, 1)} count={Math.min(skeletonRows, 4)} /></div>
            : <SkeletonRows columns={columns} count={skeletonRows} />;
    } else if (list.length === 0) {
        body = empty ? <div className="px-3.5 py-6" data-testid={testId ? `${testId}-empty` : undefined}>{empty}</div> : null;
    } else if (cards) {
        body = (
            <div role="list" className="flex flex-col">
                {list.map((row, i) => (
                    <div key={rowKey(row, i)} role="listitem" className="min-h-[44px] flex items-center px-3.5 py-2.5 border-b border-[var(--border-default)] last:border-b-0">
                        {renderCard(row, { ...ctx, index: i })}
                    </div>
                ))}
            </div>
        );
    } else {
        body = list.map((row, i) => (
            <React.Fragment key={rowKey(row, i)}>{renderRow(row, { ...ctx, index: i })}</React.Fragment>
        ));
    }

    return (
        <div
            ref={rootRef}
            role={cards ? undefined : 'table'}
            aria-label={ariaLabel}
            aria-busy={loading || undefined}
            data-testid={testId}
            data-view={cards ? 'cards' : 'table'}
            className={`${containerClass} rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden ${className}`.trim()}
            style={{ boxShadow: 'var(--shadow-sm)' }}
        >
            {!cards && <TableHeader columns={columns} testId={testId ? `${testId}-header` : undefined} />}
            {body}
            {footer && <div data-testid={testId ? `${testId}-footer` : undefined}>{footer}</div>}
        </div>
    );
}
