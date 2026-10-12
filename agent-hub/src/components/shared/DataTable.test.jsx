import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DataTable, {
    TABLE_FOLD, TABLE_FOLD_NARROW, TABLE_FOLDED_ONLY, TABLE_GRID,
    TableCell, TableHeader, TableRow, accentColor, gridTemplate,
} from './DataTable';

/**
 * The one table pattern (artboards 1b/1c/1d). Pinned:
 *   - header and rows read their grid from the SAME columns[] — the widths
 *     the artboard draws ("18px 1fr 84px 150px 84px 170px") come out as the
 *     same three custom properties on both (--ct-cols, and --ct-cols-1180 /
 *     --ct-cols-900 without the tracks of the columns folded at that width);
 *   - the stripe is an inset 3px box-shadow in the STATUS tone's raw colour,
 *     teal for the selected row, none for a null accent;
 *   - selected and expanded rows are bg-secondary;
 *   - the fold is the literal `@max-[1180px]/ctable:hidden` (or the 900px
 *     one) on both the header cell and the body cell of a foldBelow column;
 *   - a clickable row is a keyboard row (Enter/Space on the row itself, not
 *     on a button inside it);
 *   - loading draws skeletons, empty draws the host's node, mobile draws
 *     cards through renderCard, and so does a card narrower than cardsBelow.
 */

const COLUMNS = [
    { id: 'status', label: '', width: '18px' },
    { id: 'check', label: 'Check', width: '1fr' },
    { id: 'article', label: 'Article', width: '84px', foldBelow: 1180 },
    { id: 'verification', label: 'Verification', width: '150px' },
    { id: 'run', label: 'Last run', width: '84px', align: 'right' },
    { id: 'actions', label: '', width: '170px' },
];
const TEMPLATE = '18px 1fr 84px 150px 84px 170px';
const TEMPLATE_1180 = '18px 1fr 150px 84px 170px';

const cols = (el, tier = '') => el.style.getPropertyValue(`--ct-cols${tier}`);

const ROWS = [
    { id: 'a', title: 'Encryption at rest', status: 'fail' },
    { id: 'b', title: 'Sub-processors', status: 'warn' },
    { id: 'c', title: 'Privacy by default', status: 'pass' },
];

function renderTable(props = {}) {
    return render(
        <DataTable
            columns={COLUMNS}
            rows={ROWS}
            rowKey={(r) => r.id}
            renderRow={(row) => (
                <TableRow columns={COLUMNS} testId={`row-${row.id}`} accent={row.status === 'fail' ? 'error' : row.status === 'warn' ? 'warning' : 'success'}>
                    <TableCell column={COLUMNS[0]}>•</TableCell>
                    <TableCell column={COLUMNS[1]}>{row.title}</TableCell>
                    <TableCell column={COLUMNS[2]} testId={`art-${row.id}`}>Art. 32</TableCell>
                    <TableCell column={COLUMNS[3]}>automated</TableCell>
                    <TableCell column={COLUMNS[4]}>09:12</TableCell>
                    <TableCell column={COLUMNS[5]} />
                </TableRow>
            )}
            testId="t"
            {...props}
        />,
    );
}

describe('DataTable — card, header, grid', () => {
    it('is the artboard card: rounded-xl, hairline, card bg, sm shadow, a named container', () => {
        renderTable();
        const t = screen.getByTestId('t');
        expect(t.getAttribute('role')).toBe('table');
        expect(t.className).toMatch(/@container\/ctable/);
        expect(t.className).toMatch(/\brounded-xl\b/);
        expect(t.className).toMatch(/border-\[var\(--border-default\)\]/);
        expect(t.className).toMatch(/bg-\[var\(--bg-card\)\]/);
        expect(t.className).toMatch(/\boverflow-hidden\b/);
        expect(t.style.boxShadow).toBe('var(--shadow-sm)');
    });

    it('header: 10px uppercase tracked tertiary row with one columnheader per column, grid from the widths', () => {
        renderTable();
        const head = screen.getByTestId('t-header');
        expect(head.getAttribute('role')).toBe('row');
        expect(head.className).toMatch(/^grid /);
        expect(head.className).toMatch(/gap-3 px-3\.5 py-2 border-b border-\[var\(--border-default\)\] text-\[10px\] uppercase tracking-\[\.08em\] font-semibold text-\[var\(--text-tertiary\)\]/);
        expect(cols(head)).toBe(TEMPLATE);
        expect(head.className).toContain(TABLE_GRID);
        const cells = within(head).getAllByRole('columnheader');
        expect(cells.length).toBe(COLUMNS.length);
        expect(cells[1].textContent).toBe('Check');
        expect(cells[4].className).toMatch(/\btext-right\b/);
    });

    it('rows read the same three grid templates as the header', () => {
        renderTable();
        expect(gridTemplate(COLUMNS)).toBe(TEMPLATE);
        const head = screen.getByTestId('t-header');
        for (const r of ROWS) {
            const row = screen.getByTestId(`row-${r.id}`);
            for (const tier of ['', '-1180', '-900']) expect(cols(row, tier)).toBe(cols(head, tier));
            expect(row.className).toContain(TABLE_GRID);
            expect(row.style.gridTemplateColumns).toBe('');
        }
        expect(gridTemplate([{ id: 'x' }, { id: 'y', width: '80px' }])).toBe('1fr 80px');
    });

    it('a folded column leaves no track behind: --ct-cols-1180 drops the 1180 folds, --ct-cols-900 the 900 ones too', () => {
        const columns = [
            { id: 'title', width: '1fr' },
            { id: 'owner', width: '150px', foldBelow: 1180 },
            { id: 'data', width: '200px', foldBelow: 900 },
            { id: 'when', width: '84px' },
        ];
        render(<TableHeader columns={columns} testId="h3" />);
        const tiers = screen.getByTestId('h3');
        expect(cols(tiers)).toBe('1fr 150px 200px 84px');
        expect(cols(tiers, '-1180')).toBe('1fr 200px 84px');
        expect(cols(tiers, '-900')).toBe('1fr 84px');
        expect(gridTemplate(columns, 900)).toBe('1fr 84px');
        renderTable();
        const head = screen.getByTestId('t-header');
        expect(cols(head, '-1180')).toBe(TEMPLATE_1180);
        expect(cols(head, '-900')).toBe(TEMPLATE_1180);
        // The class picks the template by the CARD's width, three literals.
        expect(TABLE_GRID).toBe('[grid-template-columns:var(--ct-cols)] @max-[1180px]/ctable:[grid-template-columns:var(--ct-cols-1180)] @max-[900px]/ctable:[grid-template-columns:var(--ct-cols-900)]');
    });

    it('the fold literal sits on the header cell AND the body cell of a foldBelow column, nowhere else', () => {
        renderTable();
        const head = screen.getByTestId('t-header');
        const heads = within(head).getAllByRole('columnheader');
        expect(heads[2].className).toContain(TABLE_FOLD);
        expect(heads[1].className).not.toContain('@max-');
        expect(screen.getByTestId('art-a').className).toContain(TABLE_FOLD);
        expect(TABLE_FOLD).toBe('@max-[1180px]/ctable:hidden');
    });

    it('foldBelow 900 gets the narrow fold literal on header and body cell', () => {
        const columns = [{ id: 'title', label: 'Title', width: '1fr' }, { id: 'data', label: 'Data', width: '200px', foldBelow: 900 }];
        render(
            <DataTable
                columns={columns}
                rows={[{ id: 'x' }]}
                renderRow={() => (
                    <TableRow columns={columns} testId="r">
                        <TableCell column={columns[0]}>t</TableCell>
                        <TableCell column={columns[1]} testId="data-cell">d</TableCell>
                    </TableRow>
                )}
                testId="n"
            />,
        );
        expect(TABLE_FOLD_NARROW).toBe('@max-[900px]/ctable:hidden');
        expect(within(screen.getByTestId('n-header')).getAllByRole('columnheader')[1].className).toContain(TABLE_FOLD_NARROW);
        expect(screen.getByTestId('data-cell').className).toContain(TABLE_FOLD_NARROW);
        expect(screen.getByTestId('data-cell').className).not.toContain(TABLE_FOLD);
    });

    it('TABLE_FOLDED_ONLY is the opposite of the fold: hidden until that tier folds', () => {
        expect(TABLE_FOLDED_ONLY[1180]).toBe('hidden @max-[1180px]/ctable:inline');
        expect(TABLE_FOLDED_ONLY[900]).toBe('hidden @max-[900px]/ctable:inline');
    });

    it('another containerName still gets a container but not this file\'s fold', () => {
        renderTable({ containerName: 'other' });
        expect(screen.getByTestId('t').className).toMatch(/@container\/other/);
        expect(screen.getByTestId('t').className).not.toMatch(/@container\/ctable/);
    });

    it('keys rows with rowKey and hands renderRow the columns and index', () => {
        const renderRow = vi.fn((row, ctx) => <TableRow columns={ctx.columns} testId={`r${ctx.index}`}>{row.title}</TableRow>);
        render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} renderRow={renderRow} testId="t" />);
        expect(renderRow).toHaveBeenCalledTimes(3);
        expect(renderRow.mock.calls[1][1]).toMatchObject({ index: 1, columns: COLUMNS, gridTemplateColumns: TEMPLATE, isMobile: false });
        expect(screen.getByTestId('r2').textContent).toBe('Privacy by default');
    });
});

describe('TableRow — stripe, selected, expanded, keyboard', () => {
    it('paints the stripe as an inset 3px box-shadow in the status tone\'s RAW colour', () => {
        renderTable();
        expect(screen.getByTestId('row-a').style.boxShadow).toBe('inset 3px 0 0 var(--error)');
        expect(screen.getByTestId('row-b').style.boxShadow).toBe('inset 3px 0 0 var(--warning)');
        expect(screen.getByTestId('row-c').style.boxShadow).toBe('inset 3px 0 0 var(--success)');
    });

    it('neutral is the bg-tertiary stripe (an n/a row), kind is the area teal, null is no stripe', () => {
        render(
            <>
                <TableRow columns={COLUMNS} accent="neutral" testId="n" />
                <TableRow columns={COLUMNS} accent="kind" testId="k" />
                <TableRow columns={COLUMNS} testId="none" />
                <TableRow columns={COLUMNS} accent="bogus" testId="bogus" />
            </>,
        );
        expect(screen.getByTestId('n').style.boxShadow).toBe('inset 3px 0 0 var(--bg-tertiary)');
        expect(screen.getByTestId('k').style.boxShadow).toBe('inset 3px 0 0 var(--kind-compliance)');
        expect(screen.getByTestId('none').style.boxShadow).toBe('');
        expect(screen.getByTestId('bogus').style.boxShadow).toBe('');
        expect(accentColor('error')).toBe('var(--error)');
        expect(accentColor(null)).toBeNull();
    });

    it('selected: bg-secondary and the kind stripe, whatever the status accent said', () => {
        render(<TableRow columns={COLUMNS} accent="error" selected testId="r" />);
        const r = screen.getByTestId('r');
        expect(r.className).toMatch(/bg-\[var\(--bg-secondary\)\]/);
        expect(r.style.boxShadow).toBe('inset 3px 0 0 var(--kind-compliance)');
        expect(r.getAttribute('aria-selected')).toBe('true');
        expect(r.dataset.accent).toBe('kind');
    });

    it('expanded: bg-secondary, the status stripe stays, aria-expanded true', () => {
        render(<TableRow columns={COLUMNS} accent="warning" expanded testId="r" />);
        const r = screen.getByTestId('r');
        expect(r.className).toMatch(/bg-\[var\(--bg-secondary\)\]/);
        expect(r.style.boxShadow).toBe('inset 3px 0 0 var(--warning)');
        expect(r.getAttribute('aria-expanded')).toBe('true');
    });

    it('a plain row is not tinted and has no aria-expanded/selected', () => {
        render(<TableRow columns={COLUMNS} accent="success" testId="r" />);
        const r = screen.getByTestId('r');
        expect(r.className).not.toMatch(/bg-\[var\(--bg-secondary\)\]/);
        expect(r.className).toMatch(/\bgrid gap-3 items-center px-3\.5 py-2 border-b border-\[var\(--border-default\)\]/);
        expect(r.getAttribute('aria-expanded')).toBeNull();
        expect(r.getAttribute('aria-selected')).toBeNull();
        expect(r.getAttribute('tabindex')).toBeNull();
    });

    it('a clickable row is a keyboard row: tabIndex 0, Enter and Space activate, click activates', async () => {
        const user = userEvent.setup();
        const onClick = vi.fn();
        render(<TableRow columns={COLUMNS} onClick={onClick} ariaExpanded={false} testId="r"><span>x</span></TableRow>);
        const r = screen.getByTestId('r');
        expect(r.getAttribute('role')).toBe('row');
        expect(r.getAttribute('tabindex')).toBe('0');
        expect(r.getAttribute('aria-expanded')).toBe('false');
        expect(r.className).toMatch(/\bcursor-pointer\b/);
        // An outline, because the stripe's inline box-shadow would hide a ring.
        expect(r.className).toContain('focus-visible:outline-[var(--focus-ring)]');
        expect(r.className).toContain('focus-visible:-outline-offset-2');
        await user.tab();
        expect(r).toHaveFocus();
        await user.keyboard('{Enter}');
        await user.keyboard(' ');
        await user.keyboard('a');
        expect(onClick).toHaveBeenCalledTimes(2);
        await user.click(r);
        expect(onClick).toHaveBeenCalledTimes(3);
    });

    it('a key pressed on a button INSIDE the row does not open the row', async () => {
        const user = userEvent.setup();
        const onClick = vi.fn();
        const onFix = vi.fn();
        render(
            <TableRow columns={COLUMNS} onClick={onClick} testId="r">
                <button type="button" onClick={(e) => { e.stopPropagation(); onFix(); }}>Open fix</button>
            </TableRow>,
        );
        screen.getByRole('button', { name: 'Open fix' }).focus();
        await user.keyboard('{Enter}');
        expect(onFix).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Open fix' }));
        expect(onFix).toHaveBeenCalledTimes(2);
        expect(onClick).not.toHaveBeenCalled();
    });

    it('a row without columns keeps its host\'s own grid (no table templates)', () => {
        render(<TableRow testId="r" className="grid-cols-[1fr_1fr]" />);
        const r = screen.getByTestId('r');
        expect(r.className).not.toContain(TABLE_GRID);
        expect(cols(r)).toBe('');
    });

    it('TableCell is a min-w-0 cell that honours the column\'s alignment', () => {
        render(
            <>
                <TableCell column={{ id: 'x', align: 'right' }} testId="c1">1</TableCell>
                <TableCell column={{ id: 'y' }} align="center" testId="c2">2</TableCell>
            </>,
        );
        expect(screen.getByTestId('c1').getAttribute('role')).toBe('cell');
        expect(screen.getByTestId('c1').className).toMatch(/\bmin-w-0\b/);
        expect(screen.getByTestId('c1').className).toMatch(/\btext-right\b/);
        expect(screen.getByTestId('c2').className).toMatch(/\btext-center\b/);
    });

    it('TableHeader alone renders with the grid of its columns', () => {
        render(<TableHeader columns={COLUMNS.slice(0, 2)} testId="h" />);
        expect(cols(screen.getByTestId('h'))).toBe('18px 1fr');
    });
});

describe('DataTable — loading, empty, footer, cards', () => {
    it('loading draws skeletonRows pulsing rows on the same grid and marks the table busy', () => {
        renderTable({ loading: true, rows: [], skeletonRows: 4 });
        const sk = screen.getAllByTestId('table-skeleton-row');
        expect(sk.length).toBe(4);
        expect(sk[0].className).toMatch(/\banimate-pulse\b/);
        expect(cols(sk[0])).toBe(TEMPLATE);
        expect(cols(sk[0], '-1180')).toBe(TEMPLATE_1180);
        expect(sk[0].className).toContain(TABLE_GRID);
        expect(screen.getByTestId('t').getAttribute('aria-busy')).toBe('true');
        expect(screen.queryByTestId('row-a')).toBeNull();
    });

    it('no rows and not loading → the host\'s empty node; no empty node → nothing', () => {
        const { unmount } = renderTable({ rows: [], empty: <p>No checks yet</p> });
        expect(screen.getByTestId('t-empty').textContent).toBe('No checks yet');
        unmount();
        renderTable({ rows: [] });
        expect(screen.queryByTestId('t-empty')).toBeNull();
        expect(screen.getByTestId('t-header')).toBeInTheDocument();
    });

    it('the empty node is NOT shown while loading (an empty list is not yet a fact)', () => {
        renderTable({ rows: [], loading: true, empty: <p>No checks yet</p> });
        expect(screen.queryByTestId('t-empty')).toBeNull();
    });

    it('tolerates a non-array rows (a failed read hands the host\'s own state, never a crash)', () => {
        renderTable({ rows: null, empty: <p>Could not load</p> });
        expect(screen.getByTestId('t-empty').textContent).toBe('Could not load');
    });

    it('the footer slot renders below the rows', () => {
        renderTable({ footer: <div>Rows 1–3 of 3</div> });
        const t = screen.getByTestId('t');
        expect(t.lastElementChild).toBe(screen.getByTestId('t-footer'));
        expect(screen.getByTestId('t-footer').textContent).toBe('Rows 1–3 of 3');
    });

    it('isMobile + renderCard: no header, no table roles, one ≥44px list item per row', () => {
        renderTable({ isMobile: true, renderCard: (row) => <span data-testid={`card-${row.id}`}>{row.title}</span> });
        const t = screen.getByTestId('t');
        expect(t.dataset.view).toBe('cards');
        expect(t.getAttribute('role')).toBeNull();
        expect(screen.queryByTestId('t-header')).toBeNull();
        expect(screen.queryByTestId('row-a')).toBeNull();
        const items = screen.getAllByRole('listitem');
        expect(items.length).toBe(3);
        expect(items[0].className).toMatch(/min-h-\[44px\]/);
        expect(screen.getByTestId('card-b').textContent).toBe('Sub-processors');
    });

    it('isMobile WITHOUT renderCard keeps the table (a host that has no card yet is not broken)', () => {
        renderTable({ isMobile: true });
        expect(screen.getByTestId('t').dataset.view).toBe('table');
        expect(screen.getByTestId('row-a')).toBeInTheDocument();
    });
});

describe('DataTable — cardsBelow: cards whenever the card is narrow', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // jsdom lays nothing out; this observer reports the width the test asks for.
    function stubWidth(width) {
        const observe = vi.fn();
        vi.stubGlobal('ResizeObserver', class {
            constructor(cb) { this.cb = cb; }
            observe(el) { observe(el); this.cb([{ contentRect: { width }, borderBoxSize: [{ inlineSize: width }] }]); }
            disconnect() {}
        });
        return observe;
    }
    const card = (row) => <span data-testid={`card-${row.id}`}>{row.title}</span>;

    it('a card narrower than cardsBelow renders renderCard, even on desktop', () => {
        const observe = stubWidth(700);
        renderTable({ cardsBelow: 860, renderCard: card });
        expect(observe).toHaveBeenCalledWith(screen.getByTestId('t'));
        expect(screen.getByTestId('t').dataset.view).toBe('cards');
        expect(screen.queryByTestId('t-header')).toBeNull();
        expect(screen.getByTestId('card-a').textContent).toBe('Encryption at rest');
    });

    it('a card at or above cardsBelow stays a table', () => {
        stubWidth(1112);
        renderTable({ cardsBelow: 860, renderCard: card });
        expect(screen.getByTestId('t').dataset.view).toBe('table');
        expect(screen.getByTestId('row-a')).toBeInTheDocument();
    });

    it('an unmeasured card (width unknown) stays a table, and without cardsBelow nothing is observed', () => {
        const observe = vi.fn();
        vi.stubGlobal('ResizeObserver', class { observe(el) { observe(el); } disconnect() {} });
        renderTable({ cardsBelow: 860, renderCard: card });
        expect(screen.getByTestId('t').dataset.view).toBe('table');
        observe.mockClear();
        renderTable({ renderCard: card, testId: 'u' });
        expect(observe).not.toHaveBeenCalled();
    });
});
