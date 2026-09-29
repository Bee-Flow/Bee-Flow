import React from 'react';
import { TONES } from './statusTone';

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
 * Column folding: a column with `foldBelow: 1180` disappears when the CARD
 * is narrower than 1180px — a container query, so it folds inside a
 * 1fr-column next to an open drawer and not only on a narrow window. The
 * fold class is the literal `@max-[1180px]/ctable:hidden` and the container
 * is named `ctable` IN THIS FILE — Tailwind emits only literals it can read,
 * so the one container name this file knows is the one the fold works with
 * (the same trick as StudioSectionHeader's OBJHEAD_FOLD). A host that passes
 * another `containerName` opts out of folding.
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
 * the table then renders each row through renderCard inside a ≥44px list
 * (artboard 1h) — the register pages get their 390px variant for free.
 */

export const TABLE_CONTAINER = 'ctable';

/**
 * The fold literal — both the header cell and the body cell of a
 * `foldBelow: 1180` column get it. Spelled out because Tailwind needs it so.
 */
export const TABLE_FOLD = '@max-[1180px]/ctable:hidden';

/** The header/body grid from `columns[].width` ('18px' | '1fr' | '84px' …). */
export function gridTemplate(columns = []) {
    return columns.map((c) => c?.width || '1fr').join(' ');
}

function foldClass(column) {
    return column?.foldBelow === 1180 ? TABLE_FOLD : '';
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

export function TableHeader({ columns = [], className = '', testId = undefined }) {
    return (
        <div
            role="row"
            data-testid={testId}
            className={`grid gap-3 px-3.5 py-2 border-b border-[var(--border-default)] text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] ${className}`.trim()}
            style={{ gridTemplateColumns: gridTemplate(columns) }}
        >
            {columns.map((c) => (
                <span
                    key={c.id}
                    role="columnheader"
                    data-column={c.id}
                    className={`min-w-0 truncate ${foldClass(c)} ${alignClass(c.align)}`.replace(/\s+/g, ' ').trim()}
                >
                    {c.label}
                </span>
            ))}
        </div>
    );
}

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
                tinted ? 'bg-[var(--bg-secondary)]' : '',
                clickable ? 'cursor-pointer hover:bg-[var(--bg-secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent-primary)]' : '',
                className,
            ].join(' ').replace(/\s+/g, ' ').trim()}
            style={{
                gridTemplateColumns: gridTemplate(columns),
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
            className="grid gap-3 items-center px-3.5 py-2.5 border-b border-[var(--border-default)] animate-pulse"
            style={{ gridTemplateColumns: gridTemplate(columns) }}
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
    loading = false,
    skeletonRows = 6,
    empty = null,
    footer = null,
    containerName = TABLE_CONTAINER,
    className = '',
    ariaLabel = undefined,
    testId = undefined,
}) {
    const cards = isMobile && typeof renderCard === 'function';
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
