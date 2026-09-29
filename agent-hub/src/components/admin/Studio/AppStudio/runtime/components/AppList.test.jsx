import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AppList from './AppList';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * The list is the sidebar picker of any inbox-shaped app. It shipped declaring
 * an onRowClick event that the component never implemented — clicking a row
 * silently did nothing — so the click test here is a regression guard, not a
 * nicety.
 */

const ROWS = [
    { id: 't1', subject: 'Where is my order?', requester: 'jan@x.nl', status: 'open', assignee: 'Ann', at: new Date(Date.now() - 5 * 60000).toISOString(), unread: true },
    { id: 't2', subject: 'Invoice question', requester: 'ana@x.nl', status: 'resolved', assignee: 'Bo', at: new Date(Date.now() - 3 * 3600000).toISOString(), unread: false },
];

const TONES = [
    { value: 'open', label: 'Open', tone: 'primary' },
    { value: 'resolved', label: 'Resolved', tone: 'success' },
];

function node(props = {}, extra = {}) {
    return {
        id: 'cmp_l',
        type: 'list',
        props: { source: { kind: 'static', value: ROWS }, titleKey: 'subject', ...props },
        style: { span: 12 },
        ...extra,
    };
}

function renderList(n, runtime = {}) {
    return render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', ...runtime }}>
            <AppList node={n} />
        </RuntimeProvider>,
    );
}

describe('AppList', () => {
    it('renders titles and the empty state', () => {
        const { getByText } = renderList(node());
        expect(getByText('Where is my order?')).toBeTruthy();

        const empty = renderList(node({ source: { kind: 'static', value: [] }, emptyText: 'Niets.' }));
        expect(empty.getByText('Niets.')).toBeTruthy();
    });

    it('fires onRowClick with the whole row — in run mode only', () => {
        // The bug this guards: the spec declared the event, the component did
        // not implement it, and validation happily accepted the wiring.
        const runAction = vi.fn();
        const { container } = renderList(node({}, { onRowClick: 'act_1' }), { runAction });
        fireEvent.click(container.querySelectorAll('button')[0]);
        expect(runAction).toHaveBeenCalledWith('act_1', { formValues: ROWS[0], item: ROWS[0] });

        runAction.mockClear();
        const edit = renderList(node({}, { onRowClick: 'act_1' }), { runAction, mode: 'edit' });
        expect(edit.container.querySelectorAll('button')).toHaveLength(0);
        expect(runAction).not.toHaveBeenCalled();
    });

    it('is not clickable without an action', () => {
        const { container } = renderList(node());
        expect(container.querySelectorAll('button')).toHaveLength(0);
    });

    it('colours the badge from badgeToneMap and shows its label', () => {
        const { container, getByText } = renderList(node({
            badgeKey: 'status', badgeToneMap: TONES,
        }));
        const badges = [...container.querySelectorAll('[data-app-list-badge]')];
        expect(badges.map((b) => b.getAttribute('data-app-list-badge'))).toEqual(['primary', 'success']);
        expect(getByText('Open')).toBeTruthy();
    });

    it('falls back to neutral for a value with no mapping', () => {
        const { container } = renderList(node({ badgeKey: 'status', badgeToneMap: [] }));
        const badges = [...container.querySelectorAll('[data-app-list-badge]')];
        expect(badges.map((b) => b.getAttribute('data-app-list-badge'))).toEqual(['neutral', 'neutral']);
    });

    it('marks only the unread rows', () => {
        const { container } = renderList(node({ unreadKey: 'unread' }));
        expect(container.querySelectorAll('[data-app-list-unread]')).toHaveLength(1);
    });

    it('shows a short relative timestamp, not a raw date', () => {
        const { getByText } = renderList(node({ timestampKey: 'at' }));
        expect(getByText('5 min')).toBeTruthy();
        expect(getByText('3 u')).toBeTruthy();
    });

    it('shows the meta line', () => {
        const { getByText } = renderList(node({ metaKey: 'assignee' }));
        expect(getByText('Ann')).toBeTruthy();
    });

    it('uses no purple', () => {
        const { container } = renderList(node({ badgeKey: 'status', badgeToneMap: TONES, unreadKey: 'unread' }));
        expect(container.innerHTML).not.toMatch(/indigo|violet|purple/i);
    });
});

/**
 * list.look (spec: server/appStudio/componentSpecs.js). 'rows' is the IDENTITY
 * value: the exact class strings and item styles from before the look prop
 * existed, and no marker attribute — pinned here so a stored definition that
 * canonicalize backfills with look:'rows' cannot drift.
 */
describe('AppList — look', () => {
    const rowOf = (container, i) => container.querySelector(`[data-app-list-row="${i}"]`).firstChild;

    it('rows (default) renders todays exact markup and no look marker', () => {
        const { container } = renderList(node());
        const ul = container.querySelector('[data-app-list]');
        expect(ul.className).toBe('flex flex-col gap-2');
        expect(ul.getAttribute('data-app-list-look')).toBeNull();
        expect(ul.getAttribute('style')).toBeNull();

        const item = rowOf(container, 0);
        expect(item.className).toBe('flex items-center gap-2.5 border w-full text-left px-3 py-2');
        expect(item.style.background).toBe('var(--bg-card)');
        expect(item.style.borderColor).toBe('var(--border-default)');
        expect(item.style.boxShadow).toBe('');
    });

    it('an explicit look:"rows" and an unknown look both take the identity path', () => {
        for (const look of ['rows', 'mosaic-of-tomorrow']) {
            const { container } = renderList(node({ look }));
            const ul = container.querySelector('[data-app-list]');
            expect(ul.className).toBe('flex flex-col gap-2');
            expect(ul.getAttribute('data-app-list-look')).toBeNull();
            expect(rowOf(container, 0).style.boxShadow).toBe('');
        }
    });

    it('cards puts each item on its own elevated card', () => {
        const { container } = renderList(node({ look: 'cards' }));
        const ul = container.querySelector('[data-app-list]');
        expect(ul.getAttribute('data-app-list-look')).toBe('cards');
        expect(ul.className).toBe('flex flex-col gap-3');

        const item = rowOf(container, 0);
        expect(item.style.boxShadow).toBe('var(--app-shadow-1)');
        expect(item.style.borderColor).toBe('transparent');
        expect(item.style.background).toBe('var(--bg-card)');
    });

    it('cards keeps the primary border on the selected row — never tint alone', () => {
        const { container } = renderList(node({ look: 'cards', selectedWhen: 'item.id == "t1"' }));
        const selected = rowOf(container, 0);
        expect(selected.style.borderColor).toBe('var(--app-primary)');
        expect(selected.style.background).toBe('var(--app-primary-soft)');
        expect(rowOf(container, 1).style.borderColor).toBe('transparent');
    });

    it('tiles arranges the items in a responsive grid INSIDE the component', () => {
        const { container } = renderList(node({ look: 'tiles' }));
        const ul = container.querySelector('[data-app-list]');
        expect(ul.getAttribute('data-app-list-look')).toBe('tiles');
        expect(ul.className).toContain('grid');
        expect(ul.style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(200px, 1fr))');

        const item = rowOf(container, 0);
        expect(item.className).toContain('flex-col');
        expect(item.style.boxShadow).toBe('var(--app-shadow-1)');
    });

    it('a fill list keeps its own scroll region in every look', () => {
        for (const look of [undefined, 'cards', 'tiles']) {
            const { container } = renderList(node({ look }, { style: { span: 12, height: 'fill' } }));
            const ul = container.querySelector('[data-app-list]');
            expect(ul.className).toContain('app-fill h-full min-h-0 overflow-y-auto');
        }
    });

    it('rows stay clickable in every look', () => {
        for (const look of ['cards', 'tiles']) {
            const runAction = vi.fn();
            const { container } = renderList(node({ look }, { onRowClick: 'act_1' }), { runAction });
            fireEvent.click(container.querySelectorAll('button')[0]);
            expect(runAction).toHaveBeenCalledWith('act_1', { formValues: ROWS[0], item: ROWS[0] });
        }
    });

    it('looks introduce no purple', () => {
        for (const look of ['cards', 'tiles']) {
            const { container } = renderList(node({ look, badgeKey: 'status', badgeToneMap: TONES }));
            expect(container.innerHTML).not.toMatch(/indigo|violet|purple/i);
        }
    });
});

/**
 * list.groupKey/groupOrder/groupLabelMap (spec: componentSpecs.js).
 * Empty group values stay ungrouped and first (the file_gallery precedent);
 * groupOrder fixes the order, values not in it follow in first-seen order.
 */
describe('AppList — grouping', () => {
    const GROUP_ROWS = [
        { id: 'a', subject: 'A', bucket: 'todo' },
        { id: 'b', subject: 'B', bucket: 'done' },
        { id: 'c', subject: 'C', bucket: 'todo' },
        { id: 'd', subject: 'D', bucket: '' },
    ];

    const tokensOf = (container) => {
        const ul = container.querySelector('[data-app-list]');
        return [...ul.children].map((li) => (
            li.getAttribute('data-app-list-group')
                ? `H:${li.getAttribute('data-app-list-group')}`
                : `R:${li.getAttribute('data-app-list-row')}`
        ));
    };

    it('renders ungrouped rows first, then a header per group in groupOrder', () => {
        const { container } = renderList(node({
            source: { kind: 'static', value: GROUP_ROWS },
            groupKey: 'bucket',
            groupOrder: ['todo', 'done'],
            groupLabelMap: [{ value: 'todo', label: 'To do' }, { value: 'done', label: 'Done' }],
        }));
        // D (empty bucket) is loose and first; then To do (A, C), then Done (B).
        expect(tokensOf(container)).toEqual(['R:3', 'H:todo', 'R:0', 'R:2', 'H:done', 'R:1']);
    });

    it('labels the header from groupLabelMap and shows its count', () => {
        const { container } = renderList(node({
            source: { kind: 'static', value: GROUP_ROWS },
            groupKey: 'bucket',
            groupOrder: ['todo', 'done'],
            groupLabelMap: [{ value: 'todo', label: 'To do' }],
        }));
        const todo = container.querySelector('[data-app-list-group="todo"]');
        expect(todo.textContent).toContain('To do');
        expect(todo.textContent).toContain('· 2');
        // No label mapping → the raw value is the header.
        const done = container.querySelector('[data-app-list-group="done"]');
        expect(done.textContent).toContain('done');
        expect(done.textContent).toContain('· 1');
    });

    it('puts a value missing from groupOrder after the listed ones, first-seen', () => {
        const { container } = renderList(node({
            source: { kind: 'static', value: GROUP_ROWS },
            groupKey: 'bucket',
            groupOrder: ['done'],
        }));
        // done is pinned first; todo (unlisted) follows in first-seen order.
        expect(tokensOf(container)).toEqual(['R:3', 'H:done', 'R:1', 'H:todo', 'R:0', 'R:2']);
    });

    it('without a groupKey there are no group headers', () => {
        const { container } = renderList(node({ source: { kind: 'static', value: GROUP_ROWS } }));
        expect(container.querySelectorAll('[data-app-list-group]')).toHaveLength(0);
    });
});

/**
 * list.badgePlacement + selectedDetailKey (spec: componentSpecs.js). The
 * default 'meta' keeps the badge on the third line; 'subtitle' moves it to the
 * subtitle line. selectedDetailKey renders one accent line, only when selected.
 */
describe('AppList — badgePlacement and selectedDetailKey', () => {
    it('default keeps the badge with the meta line', () => {
        const { container } = renderList(node({ metaKey: 'assignee', badgeKey: 'status', badgeToneMap: TONES }));
        const badge = container.querySelector('[data-app-list-badge]');
        const line = badge.closest('div');
        expect(line.textContent).toContain('Ann'); // the assignee meta sits beside it
    });

    it('badgePlacement subtitle moves the badge onto the subtitle line', () => {
        const { container } = renderList(node({
            subtitleKey: 'requester', metaKey: 'assignee',
            badgeKey: 'status', badgeToneMap: TONES, badgePlacement: 'subtitle',
        }));
        const row = container.querySelector('[data-app-list-row="0"]');
        const badge = row.querySelector('[data-app-list-badge]');
        const line = badge.closest('div');
        // The badge now shares the subtitle line, not the meta line.
        expect(line.textContent).toContain('jan@x.nl');
        expect(line.textContent).not.toContain('Ann');
    });

    it('shows the selected-detail line only on the selected row', () => {
        const rows = [
            { id: 't1', subject: 'One', note: 'Waiting on the customer since 14 Aug' },
            { id: 't2', subject: 'Two', note: 'other' },
        ];
        const { container } = renderList(node({
            source: { kind: 'static', value: rows },
            selectedWhen: 'item.id == "t1"', selectedDetailKey: 'note',
        }));
        const details = [...container.querySelectorAll('[data-app-list-detail]')];
        expect(details).toHaveLength(1);
        expect(details[0].textContent).toContain('Waiting on the customer since 14 Aug');
        const selectedRow = container.querySelector('[data-app-list-selected]');
        expect(selectedRow.contains(details[0])).toBe(true);
    });

    it('renders no detail line when nothing is selected', () => {
        const { container } = renderList(node({ selectedDetailKey: 'subject' }));
        expect(container.querySelectorAll('[data-app-list-detail]')).toHaveLength(0);
    });
    // ── The peek ─────────────────────────────────────────────────────────────
    // A sidebar row that says "needs attention" and makes you open it to learn
    // WHAT needs attention has spent the click it exists to save.

    const PEEK_ROWS = [
        { id: 't1', subject: 'One', status: 'open' },
        { id: 't2', subject: 'Two', status: 'resolved' },
    ];
    const PEEK_LINES = [
        { thread: 't1', check: 'onvolledig', name: 'A', note: 'no material' },
        { thread: 't1', check: 'onvolledig', name: 'B', note: 'no thickness' },
        { thread: 't1', check: 'controleren', name: 'C', note: 'marked' },
    ];
    const peekNode = (extra = {}) => node({
        source: { kind: 'static', value: PEEK_ROWS },
        badgeKey: 'status', badgeToneMap: TONES,
        peekSource: { kind: 'static', value: PEEK_LINES },
        peekMatchKey: 'thread', peekRowKey: 'id',
        peekGroupKey: 'check', peekTitleKey: 'name', peekTextKey: 'note',
        peekBadge: true,
        ...extra,
    }, { onRowClick: 'act_1' });

    it('counts the related rows into the badge, and leaves rows with none alone', () => {
        const { container } = renderList(peekNode());
        const badges = [...container.querySelectorAll('[data-app-list-badge]')];
        expect(badges[0].textContent).toBe('3 onvolledig');
        // t2 has nothing behind it: "0 onvolledig" would be noise on exactly
        // the row that is fine.
        expect(badges[1].textContent).toBe('Resolved');
        expect(badges[1].getAttribute('data-app-list-peek')).toBe(null);
    });

    it('keeps the plain badge until peekBadge is switched on', () => {
        const { container } = renderList(peekNode({ peekBadge: false }));
        expect(container.querySelectorAll('[data-app-list-badge]')[0].textContent).toBe('Open');
        // The panel is still available — the count in the badge is a separate
        // decision from the panel on hover.
        expect(container.querySelectorAll('[data-app-list-peek]')).toHaveLength(1);
    });

    it('opens the panel on hover and closes it again', () => {
        const { container, queryByRole } = renderList(peekNode({ peekTitle: 'Wat mist er', peekLimit: 2, peekMoreText: 'nog {count}' }));
        expect(queryByRole('tooltip')).toBe(null);

        const badge = container.querySelector('[data-app-list-peek]');
        fireEvent.mouseEnter(badge);
        const panel = queryByRole('tooltip');
        expect(panel.textContent).toContain('Wat mist er');
        expect(panel.textContent).toContain('no material');
        // Capped at two rows, and honest about the third.
        expect(panel.textContent).not.toContain('marked');
        expect(panel.textContent).toContain('nog 1');

        fireEvent.mouseLeave(badge);
        expect(queryByRole('tooltip')).toBe(null);
    });

    it('opens the panel from keyboard focus on the row', () => {
        const { container, queryByRole } = renderList(peekNode());
        const row = container.querySelectorAll('button')[0];
        fireEvent.focus(row);
        expect(queryByRole('tooltip')).toBeTruthy();
        fireEvent.blur(row);
        expect(queryByRole('tooltip')).toBe(null);
    });

    it('lets the naming group recolour the badge, but only with the count', () => {
        // The case that forced this: a row whose own status says "fine" while
        // fourteen of its records are flagged was showing "14 to check" in the
        // green of "fine".
        const withTone = peekNode({
            peekGroupLabelMap: [{ value: 'onvolledig', label: 'onvolledig', tone: 'warning' }],
        });
        const { container } = renderList(withTone);
        const badges = [...container.querySelectorAll('[data-app-list-badge]')];
        expect(badges[0].getAttribute('data-app-list-badge')).toBe('warning');
        // The row with nothing behind it keeps its own tone.
        expect(badges[1].getAttribute('data-app-list-badge')).toBe('success');

        // Without peekBadge the tone is not read either: a peek added for the
        // panel alone changes nothing about how the list looks.
        const quiet = renderList(peekNode({
            peekBadge: false,
            peekGroupLabelMap: [{ value: 'onvolledig', label: 'onvolledig', tone: 'warning' }],
        }));
        expect(quiet.container.querySelectorAll('[data-app-list-badge]')[0].getAttribute('data-app-list-badge')).toBe('primary');
    });

    it('renders exactly as before when no peek is configured', () => {
        const { container } = renderList(node({ badgeKey: 'status', badgeToneMap: TONES }));
        expect(container.querySelectorAll('[data-app-list-peek]')).toHaveLength(0);
        expect(container.querySelectorAll('[data-app-list-badge]')[0].textContent).toBe('Open');
    });
});
