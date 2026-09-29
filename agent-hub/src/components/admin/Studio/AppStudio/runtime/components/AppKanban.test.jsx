import { render } from '@testing-library/react';
import { act } from 'react';
import { describe, it, expect, vi } from 'vitest';

// Mock @dnd-kit/core: capture DndContext's drag callbacks so the test can fire
// synthetic drags without simulating pointer gestures (flaky in jsdom).
const captured = { onDragStart: null, onDragEnd: null, onDragCancel: null };
vi.mock('@dnd-kit/core', () => ({
    DndContext: ({ children, onDragStart, onDragEnd, onDragCancel }) => {
        captured.onDragStart = onDragStart;
        captured.onDragEnd = onDragEnd;
        captured.onDragCancel = onDragCancel;
        return <div data-dnd-context="true">{children}</div>;
    },
    // The moving copy rides in the overlay (the in-lane card is clipped by the
    // column's scroll container) — render children so tests can see it.
    DragOverlay: ({ children }) => <div data-dnd-overlay="true">{children}</div>,
    PointerSensor: function PointerSensor() {},
    // The cards announce themselves as draggable, so a keyboard user has to
    // be able to drag them — the component registers this sensor too.
    KeyboardSensor: function KeyboardSensor() {},
    pointerWithin: () => [],
    rectIntersection: () => [],
    useSensor: () => null,
    useSensors: (...sensors) => sensors,
    useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, isDragging: false }),
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
}));

const {
    default: AppKanban, kanbanColumns, normalizeAxisRows, resolveCardDrop,
    columnDroppableId, parseColumnDroppableId, rankForSlot, kanbanSwimlanes,
} = await import('./AppKanban');
const { RuntimeProvider, buildScope, DEFAULT_RUNTIME } = await import('../RuntimeContext');

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const ROWS = [
    { id: 'rec_1', title: 'Fix hive', status: 'open', owner: 'Ann', light: 'groen' },
    { id: 'rec_2', title: 'Order frames', status: 'open', owner: 'Bob', light: 'paars' },
    { id: 'rec_3', title: 'Paint boxes', status: 'done', owner: 'Cee', light: null },
];

const TONES = [
    { value: 'groen', label: 'Green', tone: 'success' },
    { value: 'rood', label: 'Red', tone: 'danger' },
];

function kbNode(extra = {}, props = {}) {
    return {
        id: 'cmp_kb', type: 'kanban', visible: true,
        props: {
            source: { kind: 'static', value: ROWS },
            groupByField: 'status',
            columns: [
                { value: 'open', label: 'Open', color: 'info' },
                { value: 'done', label: 'Done', color: 'success' },
            ],
            titleKey: 'title', subtitleKey: 'owner', badgeKey: null, allowDrag: true,
            ...props,
        },
        style: { span: 12 },
        ...extra,
    };
}

describe('kanbanColumns', () => {
    it('keeps the configured order, labels and colours', () => {
        expect(kanbanColumns(
            [{ value: 'done', label: 'Done', color: 'success' }, { value: 'open', label: 'Open', color: 'info' }],
            ROWS,
            'status',
        )).toEqual([
            { value: 'done', label: 'Done', color: 'success', wipLimit: null },
            { value: 'open', label: 'Open', color: 'info', wipLimit: null },
        ]);
    });
    it('appends a column for every value the configured list misses', () => {
        expect(kanbanColumns([{ value: 'a', label: 'A', color: 'info' }], ROWS, 'status'))
            .toEqual([
                { value: 'a', label: 'A', color: 'info', wipLimit: null },
                { value: 'open', label: 'open', color: null, wipLimit: null },
                { value: 'done', label: 'done', color: null, wipLimit: null },
            ]);
    });
    it('derives distinct columns from the rows when unconfigured', () => {
        expect(kanbanColumns([], ROWS, 'status')).toEqual([
            { value: 'open', label: 'open', color: null, wipLimit: null },
            { value: 'done', label: 'done', color: null, wipLimit: null },
        ]);
    });
    it('carries a positive wipLimit through and normalises 0/absent to null', () => {
        expect(kanbanColumns(
            [{ value: 'open', label: 'Open', wipLimit: 3 }, { value: 'done', label: 'Done', wipLimit: 0 }],
            [], 'status',
        )).toEqual([
            { value: 'open', label: 'Open', color: null, wipLimit: 3 },
            { value: 'done', label: 'Done', color: null, wipLimit: null },
        ]);
    });
});

describe('AppKanban', () => {
    it('groups cards into columns with counts', () => {
        const { container, getByText } = withRuntime(<AppKanban node={kbNode()} />);
        const openCol = container.querySelector('[data-app-kanban-column="open"]');
        const doneCol = container.querySelector('[data-app-kanban-column="done"]');
        expect(openCol.querySelectorAll('[data-app-kanban-card]').length).toBe(2);
        expect(doneCol.querySelectorAll('[data-app-kanban-card]').length).toBe(1);
        expect(getByText('Fix hive')).toBeTruthy();
        expect(getByText('Ann')).toBeTruthy(); // subtitle
    });

    it('drop on another column fires onCardMove with the move AND its landing slot', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={kbNode({ onCardMove: 'act_move01' })} />, { mode: 'run', runAction });
        expect(typeof captured.onDragEnd).toBe('function');
        act(() => {
            captured.onDragEnd({
                active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } },
                over: { id: 'appkanban-col:done' },
            });
        });
        // `value` is the column, as before; `index`/`beforeId`/`afterId` say
        // WHERE in it, which is what a rank-ordered board needs to persist.
        const payload = { item: ROWS[0], value: 'done', lane: null, index: 1, beforeId: 'rec_3', afterId: null, rank: null };
        expect(runAction).toHaveBeenCalledWith('act_move01', { formValues: payload, ...payload });
    });

    /**
     * A same-column drop used to be discarded wholesale. It cannot be: on a
     * rank-ordered board, dropping a card lower in the column IT IS ALREADY IN
     * is the ordinary way to deprioritise it. Only a drop that changes nothing
     * — the card is already in that slot — and a drop on empty space are no-ops.
     */
    it('a drop that lands where the card already is (or nowhere) is a no-op', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={kbNode({ onCardMove: 'act_move01' })} />, { mode: 'run', runAction });
        act(() => {
            // rec_2 is already last in 'open'; appending it there changes nothing.
            captured.onDragEnd({ active: { id: 'appkanban-card:1', data: { current: { row: ROWS[1] } } }, over: { id: 'appkanban-col:open' } });
            captured.onDragEnd({ active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } }, over: null });
            // Dropped on itself.
            captured.onDragEnd({ active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } }, over: { id: 'appkanban-card:0' } });
        });
        expect(runAction).not.toHaveBeenCalled();
    });

    it('reorders WITHIN a column: dropping the first card on the column appends it', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={kbNode({ onCardMove: 'act_move01' })} />, { mode: 'run', runAction });
        act(() => {
            captured.onDragEnd({ active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } }, over: { id: 'appkanban-col:open' } });
        });
        const payload = { item: ROWS[0], value: 'open', lane: null, index: 1, beforeId: 'rec_2', afterId: null, rank: null };
        expect(runAction).toHaveBeenCalledWith('act_move01', { formValues: payload, ...payload });
    });

    it('dropping ON a card takes that card\'s slot, bracketed by its neighbours', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={kbNode({ onCardMove: 'act_move01' })} />, { mode: 'run', runAction });
        act(() => {
            // rec_3 (done) dropped onto rec_2, the second card of 'open'.
            captured.onDragEnd({
                active: { id: 'appkanban-card:2', data: { current: { row: ROWS[2] } } },
                over: { id: 'appkanban-card:1' },
            });
        });
        const payload = { item: ROWS[2], value: 'open', lane: null, index: 1, beforeId: 'rec_1', afterId: 'rec_2', rank: null };
        expect(runAction).toHaveBeenCalledWith('act_move01', { formValues: payload, ...payload });
    });

    it('card click fires onRowClick with the row as form values', () => {
        const runAction = vi.fn();
        const { getByText } = withRuntime(
            <AppKanban node={kbNode({ onRowClick: 'act_row001' })} />,
            { mode: 'run', runAction },
        );
        getByText('Paint boxes').closest('[data-app-kanban-card]').click();
        expect(runAction).toHaveBeenCalledWith('act_row001', { formValues: ROWS[2], item: ROWS[2] });
    });

    it('the click a drop spawns does NOT open the card', () => {
        const runAction = vi.fn();
        const { getByText } = withRuntime(
            <AppKanban node={kbNode({ onRowClick: 'act_row001', onCardMove: 'act_move01' })} />,
            { mode: 'run', runAction },
        );
        act(() => {
            captured.onDragStart({ active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } } });
            captured.onDragEnd({ active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } }, over: { id: 'appkanban-col:open' } });
        });
        // The browser's synthetic click lands synchronously after pointerup —
        // before the guard's macrotask reset — so this click must be swallowed.
        getByText('Fix hive').closest('[data-app-kanban-card]').click();
        // The drop itself legitimately fires onCardMove; what must NOT happen
        // is the card opening. Assert on the row-click action by name.
        expect(runAction).not.toHaveBeenCalledWith('act_row001', expect.anything());
    });

    it('shows the drag overlay copy while a drag is live', () => {
        const { getAllByText } = withRuntime(
            <AppKanban node={kbNode({ onCardMove: 'act_move01' })} />,
            { mode: 'run', runAction: vi.fn() },
        );
        act(() => {
            captured.onDragStart({ active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } } });
        });
        // The overlay is PORTALED to document.body (a transformed ancestor in
        // the builder chrome would otherwise re-anchor its fixed position and
        // float the copy away from the cursor) — query the document, not the
        // render container.
        expect(document.querySelector('[data-app-kanban-overlay]')).toBeTruthy();
        expect(getAllByText('Fix hive').length).toBe(2); // in-lane card + overlay copy
        act(() => {
            captured.onDragCancel();
        });
        expect(document.querySelector('[data-app-kanban-overlay]')).toBeNull();
    });

    it('a badge value the tone map covers renders as a coloured dot, not text', () => {
        const { container, queryByText } = withRuntime(
            <AppKanban node={kbNode({}, { badgeKey: 'light', badgeToneMap: TONES })} />,
        );
        const dot = container.querySelector('[data-app-kanban-dot]');
        expect(dot).toBeTruthy();
        expect(dot.getAttribute('data-app-kanban-dot')).toBe('success');
        expect(dot.getAttribute('title')).toBe('Green');
        expect(queryByText('groen')).toBeNull(); // the word never renders
    });

    it('a badge value OUTSIDE the tone map keeps the text pill', () => {
        const { container, getByText } = withRuntime(
            <AppKanban node={kbNode({}, { badgeKey: 'light', badgeToneMap: TONES })} />,
        );
        expect(getByText('paars')).toBeTruthy(); // unmapped → visible as text
        expect(container.querySelectorAll('[data-app-kanban-dot]').length).toBe(1);
    });

    it('derives columns from the data when props.columns is empty', () => {
        const { container } = withRuntime(<AppKanban node={kbNode({}, { columns: [] })} />);
        expect(container.querySelectorAll('[data-app-kanban-column]').length).toBe(2);
    });

    it('surfaces cards whose group value matches no configured column', () => {
        const rows = [...ROWS, { id: 'rec_4', title: 'Legacy task', status: 'archived', owner: 'Dee' }];
        const { container, getByText } = withRuntime(
            <AppKanban node={kbNode({}, { source: { kind: 'static', value: rows } })} />,
        );
        expect(getByText('Legacy task')).toBeTruthy();
        const extra = container.querySelector('[data-app-kanban-column="archived"]');
        expect(extra).toBeTruthy();
        expect(extra.querySelectorAll('[data-app-kanban-card]').length).toBe(1);
    });

    it('surfaces cards with an empty group value under (none)', () => {
        const rows = [...ROWS, { id: 'rec_5', title: 'Unsorted', status: null, owner: 'Eve' }];
        const { container, getByText } = withRuntime(
            <AppKanban node={kbNode({}, { source: { kind: 'static', value: rows } })} />,
        );
        expect(getByText('Unsorted')).toBeTruthy();
        expect(getByText('(none)')).toBeTruthy();
        expect(container.querySelector('[data-app-kanban-column=""]')).toBeTruthy();
    });
});

/**
 * THE BOARD AS DATA.
 *
 * `columns` is authored into the app definition, so changing it means opening
 * the builder — the wrong person for the job. A team lead adding an "In review"
 * column is configuration, not development. `columnsSource` binds the axis to a
 * table so the people using the app own it, and the rows are read leniently
 * because that table is theirs: a board config table is allowed to call its
 * columns `state`/`name`/`position`.
 */
describe('normalizeAxisRows', () => {
    it('reads the canonical keys', () => {
        expect(normalizeAxisRows([{ value: 'todo', label: 'To do', color: 'info' }]))
            .toEqual([{ value: 'todo', label: 'To do', color: 'info' }]);
    });

    it('accepts the aliases a customer-owned table is likely to use', () => {
        expect(normalizeAxisRows([{ state: 'todo', name: 'To do', colour: 'info' }]))
            .toEqual([{ value: 'todo', label: 'To do', color: 'info' }]);
        expect(normalizeAxisRows([{ key: 'todo', title: 'To do', tone: 'info' }]))
            .toEqual([{ value: 'todo', label: 'To do', color: 'info' }]);
    });

    it('sorts by an order column when any row carries one', () => {
        expect(normalizeAxisRows([
            { value: 'c', position: 3 }, { value: 'a', position: 1 }, { value: 'b', position: 2 },
        ]).map((c) => c.value)).toEqual(['a', 'b', 'c']);
    });

    it('keeps the given order when NO row carries one', () => {
        expect(normalizeAxisRows([{ value: 'c' }, { value: 'a' }]).map((c) => c.value)).toEqual(['c', 'a']);
    });

    it('reads wipLimit only when asked, under either spelling', () => {
        expect(normalizeAxisRows([{ value: 'doing', wip_limit: 3 }], { withWip: true })[0].wipLimit).toBe(3);
        expect(normalizeAxisRows([{ value: 'doing', wipLimit: 3 }], { withWip: true })[0].wipLimit).toBe(3);
        expect(normalizeAxisRows([{ value: 'doing', wip_limit: 3 }])[0].wipLimit).toBeUndefined();
    });

    it('drops a row with no resolvable value rather than merging cards under one blank column', () => {
        expect(normalizeAxisRows([{ label: 'Orphan' }, { value: 'ok' }]).map((c) => c.value)).toEqual(['ok']);
    });

    it('is null for a non-array, so an unloaded binding falls back to the literal columns', () => {
        expect(normalizeAxisRows(undefined)).toBeNull();
        expect(normalizeAxisRows(null)).toBeNull();
    });
});

describe('resolveCardDrop', () => {
    const cell = [
        { index: 0, row: { id: 'a' } },
        { index: 1, row: { id: 'b' } },
        { index: 2, row: { id: 'c' } },
    ];

    it('appends when the drop is on the column itself', () => {
        expect(resolveCardDrop({ cell, activeIndex: 9, overIndex: null }))
            .toEqual({ index: 3, beforeId: 'c', afterId: null });
    });

    it('takes the hovered card\'s slot, bracketed by its neighbours', () => {
        expect(resolveCardDrop({ cell, activeIndex: 9, overIndex: 1 }))
            .toEqual({ index: 1, beforeId: 'a', afterId: 'b' });
    });

    /**
     * The moved card is lifted out BEFORE the slot is counted. Without that,
     * dragging a card downward inside its own column brackets it between itself
     * and its neighbour, and the midpoint rank an action computes from that is
     * the rank it already had — the card springs back.
     */
    it('lifts the moved card out first, so a downward move inside one column is real', () => {
        expect(resolveCardDrop({ cell, activeIndex: 0, overIndex: 2 }))
            .toEqual({ index: 1, beforeId: 'b', afterId: 'c' });
    });

    it('and an upward move inside one column', () => {
        expect(resolveCardDrop({ cell, activeIndex: 2, overIndex: 0 }))
            .toEqual({ index: 0, beforeId: null, afterId: 'a' });
    });

    it('brackets with nulls at both ends of an empty column', () => {
        expect(resolveCardDrop({ cell: [], activeIndex: 4, overIndex: null }))
            .toEqual({ index: 0, beforeId: null, afterId: null });
    });
});

describe('AppKanban — board configured from data', () => {
    const CONFIG = [
        { value: 'done', name: 'Klaar', colour: 'success', position: 2 },
        { value: 'open', name: 'Open', colour: 'info', position: 1 },
    ];

    it('bound columns replace the authored ones, in their own order', () => {
        const { container, getByText } = withRuntime(
            <AppKanban node={kbNode({}, { columnsSource: { kind: 'static', value: CONFIG } })} />,
        );
        const headers = [...container.querySelectorAll('[data-app-kanban-header]')]
            .map((el) => el.getAttribute('data-app-kanban-header'));
        expect(headers).toEqual(['open', 'done']);
        expect(getByText('Klaar')).toBeTruthy();   // the customer's label, not ours
    });

    it('falls back to the authored columns while the binding has nothing', () => {
        const { getByText } = withRuntime(
            <AppKanban node={kbNode({}, { columnsSource: { kind: 'static', value: [] } })} />,
        );
        expect(getByText('Open')).toBeTruthy();    // the authored label
    });

    it('shows a WIP limit and flags the column that is over it', () => {
        const { container } = withRuntime(<AppKanban node={kbNode({}, {
            columnsSource: { kind: 'static', value: [{ value: 'open', name: 'Open', wip_limit: 1 }, { value: 'done', name: 'Done' }] },
        })} />);
        const open = container.querySelector('[data-app-kanban-count="open"]');
        expect(open.textContent).toBe('2/1');
        expect(open.getAttribute('data-app-kanban-overwip')).toBe('true');
        const done = container.querySelector('[data-app-kanban-count="done"]');
        expect(done.textContent).toBe('1');
        expect(done.getAttribute('data-app-kanban-overwip')).toBeNull();
    });
});

describe('AppKanban — swimlanes', () => {
    it('splits the board into lanes and keeps the columns aligned across them', () => {
        const { container } = withRuntime(
            <AppKanban node={kbNode({}, { swimlaneField: 'owner' })} />,
        );
        const laneIds = [...container.querySelectorAll('[data-app-kanban-swimlane]')]
            .map((el) => el.getAttribute('data-app-kanban-swimlane'));
        expect(laneIds).toEqual(['Ann', 'Bob', 'Cee']);
        // Every lane renders every column, so a card can be dragged into any of
        // them — one cell per lane per column.
        expect(container.querySelectorAll('[data-app-kanban-column]').length).toBe(laneIds.length * 2);
    });

    it('a lane drop reports which lane it landed in', () => {
        const runAction = vi.fn();
        withRuntime(
            <AppKanban node={kbNode({ onCardMove: 'act_move01' }, { swimlaneField: 'owner' })} />,
            { mode: 'run', runAction },
        );
        act(() => {
            captured.onDragEnd({
                active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } },
                over: { id: columnDroppableId('Bob', 'done') },
            });
        });
        expect(runAction).toHaveBeenCalledWith('act_move01', expect.objectContaining({
            value: 'done', lane: 'Bob',
        }));
    });

    it('lane is null when the board has no swimlane field', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={kbNode({ onCardMove: 'act_move01' })} />, { mode: 'run', runAction });
        act(() => {
            captured.onDragEnd({
                active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } },
                over: { id: 'appkanban-col:done' },
            });
        });
        expect(runAction).toHaveBeenCalledWith('act_move01', expect.objectContaining({ lane: null }));
    });
});

describe('AppKanban — card content', () => {
    const ROWS_RICH = [
        { id: 'rec_1', title: 'Fix hive', status: 'open', points: 5, assignee: 'Ann', kind: 'bug' },
        { id: 'rec_2', title: 'Order frames', status: 'open', points: null, assignee: null, kind: 'story' },
    ];

    const richNode = (props = {}) => kbNode({}, {
        source: { kind: 'static', value: ROWS_RICH },
        cardFields: [
            { key: 'points', label: 'Points', slot: 'chip', format: 'number' },
            { key: 'assignee', label: 'Assignee', slot: 'meta', format: 'text' },
        ],
        ...props,
    });

    it('renders the extra card fields, and skips the ones with no value', () => {
        const { container, getByText } = withRuntime(<AppKanban node={richNode()} />);
        expect(getByText('5')).toBeTruthy();
        expect(getByText('Ann')).toBeTruthy();
        // rec_2 has neither, so it contributes no field chips at all.
        expect(container.querySelectorAll('[data-app-kanban-field]').length).toBe(2);
    });

    it('names each field for a screen reader, so a bare number still means something', () => {
        const { container } = withRuntime(<AppKanban node={richNode()} />);
        const chip = container.querySelector('[data-app-kanban-field="points"]');
        expect(chip.textContent).toContain('Points: ');
        expect(chip.getAttribute('title')).toBe('Points: 5');
    });

    it('accents the card edge by the colour map, and leaves unmapped values plain', () => {
        const { container } = withRuntime(<AppKanban node={richNode({
            colorKey: 'kind',
            cardColorMap: [{ value: 'bug', label: 'Bug', tone: 'danger' }],
        })} />);
        const cards = [...container.querySelectorAll('[data-app-kanban-card]')];
        expect(cards[0].style.borderLeft).toBeTruthy();
        expect(cards[1].style.borderLeft).toBe('');
    });

    it('collapses a column when asked, and only when asked', () => {
        const plain = withRuntime(<AppKanban node={kbNode()} />);
        expect(plain.container.querySelector('[data-app-kanban-collapse]')).toBeNull();

        const { container } = withRuntime(<AppKanban node={kbNode({}, { collapsible: true })} />);
        const toggle = container.querySelector('[data-app-kanban-collapse="open"]');
        expect(container.querySelector('[data-app-kanban-column="open"]')).toBeTruthy();
        act(() => { toggle.click(); });
        expect(container.querySelector('[data-app-kanban-column="open"]')).toBeNull();
        // The header — and its count — survive, so a folded column is still readable.
        expect(container.querySelector('[data-app-kanban-count="open"]').textContent).toBe('2');
    });

    it('uses the authored empty text when there is nothing to show', () => {
        const { getByText } = withRuntime(<AppKanban node={kbNode({}, {
            source: { kind: 'static', value: [] }, columns: [], emptyText: 'Nog geen werk ingepland.',
        })} />);
        expect(getByText('Nog geen werk ingepland.')).toBeTruthy();
    });
});

/**
 * The lane/column droppable id was first separated by a space, which every
 * value these axes carry can contain — "In review", "Ann Smith". A drop then
 * parsed as lane "Ann" / column "Smith done" and went nowhere.
 */
describe('column droppable ids survive the values customers actually use', () => {
    it('round-trips lanes and columns containing spaces and colons', () => {
        for (const [lane, value] of [
            ['Ann Smith', 'In review'],
            ['EPIC-12: onboarding', 'Ready: QA'],
            ['', ''],
            ['__all__', 'done'],
        ]) {
            expect(parseColumnDroppableId(columnDroppableId(lane, value))).toEqual({ lane, value });
        }
    });

    it('reads a laneless id as the single implicit lane', () => {
        expect(parseColumnDroppableId('appkanban-col:done')).toEqual({ lane: '__all__', value: 'done' });
    });

    it('ignores ids that are not columns', () => {
        expect(parseColumnDroppableId('appkanban-card:3')).toBeNull();
        expect(parseColumnDroppableId(null)).toBeNull();
    });
});

/**
 * The rank a drop lands on.
 *
 * The arithmetic lives in the component because it is the only place with the
 * neighbouring ROWS: a server step can resolve form/vars/item but cannot read
 * another record, so an action handed only beforeId/afterId would need a join
 * the query engine does not have.
 */
describe('rankForSlot', () => {
    it('splits the difference between two neighbours', () => {
        expect(rankForSlot(10, 20)).toBe(15);
        expect(rankForSlot(10, 11)).toBe(10.5);
    });

    it('steps past the end it was dropped at', () => {
        expect(rankForSlot(10, null)).toBe(11);   // dropped at the bottom
        expect(rankForSlot(null, 10)).toBe(9);    // dropped at the top
    });

    it('starts an empty column at 0', () => {
        expect(rankForSlot(null, null)).toBe(0);
    });

    /**
     * A row written before the board had a rank column has no usable rank.
     * Reading that as 0 would slam the card into the middle of the column
     * instead of the end the person dropped it at.
     */
    it('treats an unusable neighbour rank as absent, not as zero', () => {
        expect(rankForSlot(NaN, 20)).toBe(19);
        expect(rankForSlot(10, undefined)).toBe(11);
        expect(rankForSlot('nonsense', 'also nonsense')).toBe(0);
    });

    it('never renumbers: repeated inserts between the same pair keep splitting', () => {
        let lo = 1; const hi = 2;
        for (let i = 0; i < 10; i += 1) {
            const next = rankForSlot(lo, hi);
            expect(next).toBeGreaterThan(lo);
            expect(next).toBeLessThan(hi);
            lo = next;
        }
    });
});

describe('AppKanban — the drop carries a ready-to-write rank', () => {
    const RANKED = [
        { id: 'rec_1', title: 'One', status: 'open', rank: 10 },
        { id: 'rec_2', title: 'Two', status: 'open', rank: 20 },
        { id: 'rec_3', title: 'Three', status: 'done', rank: 30 },
    ];
    const rankedNode = () => kbNode(
        { onCardMove: 'act_move01' },
        { source: { kind: 'static', value: RANKED }, rankKey: 'rank' },
    );

    it('midpoints between the new neighbours when dropped onto a card', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={rankedNode()} />, { mode: 'run', runAction });
        act(() => {
            // rec_3 dropped onto rec_2 → lands between rec_1 (10) and rec_2 (20).
            captured.onDragEnd({
                active: { id: 'appkanban-card:2', data: { current: { row: RANKED[2] } } },
                over: { id: 'appkanban-card:1' },
            });
        });
        expect(runAction).toHaveBeenCalledWith('act_move01', expect.objectContaining({ rank: 15, value: 'open' }));
    });

    it('steps past the last card when dropped on the column', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={rankedNode()} />, { mode: 'run', runAction });
        act(() => {
            captured.onDragEnd({
                active: { id: 'appkanban-card:2', data: { current: { row: RANKED[2] } } },
                over: { id: 'appkanban-col:open' },
            });
        });
        expect(runAction).toHaveBeenCalledWith('act_move01', expect.objectContaining({ rank: 21 }));
    });

    it('is null when the board declares no rankKey, so no phantom column is written', () => {
        const runAction = vi.fn();
        withRuntime(<AppKanban node={kbNode({ onCardMove: 'act_move01' })} />, { mode: 'run', runAction });
        act(() => {
            captured.onDragEnd({
                active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } },
                over: { id: 'appkanban-col:done' },
            });
        });
        expect(runAction).toHaveBeenCalledWith('act_move01', expect.objectContaining({ rank: null }));
    });
});

/**
 * The degenerate midpoint.
 *
 * `(b + a) / 2` is only a midpoint when it lands strictly between. Two
 * neighbours sharing a rank have no gap; float64 runs out of room after ~52
 * halvings of one interval. In both cases the old maths returned a neighbour's
 * own rank, the update wrote the value the card already had, and the card sprang
 * back on the next refresh — a drag that visibly does nothing, forever.
 */
describe('rankForSlot never returns a neighbour\'s own rank', () => {
    it('steps past a tie instead of landing on it', () => {
        expect(rankForSlot(0, 0)).not.toBe(0);
        expect(rankForSlot(0, 0)).toBe(1);
        expect(rankForSlot(100, 100)).toBe(101);
    });

    it('survives an interval halved past float64 resolution', () => {
        let lo = 1;
        const hi = 2;
        for (let i = 0; i < 200; i += 1) {
            const next = rankForSlot(lo, hi);
            expect(next).not.toBe(lo);
            lo = next;
        }
    });

    it('still splits a real gap', () => {
        expect(rankForSlot(10, 20)).toBe(15);
        expect(rankForSlot(1, 2)).toBe(1.5);
    });
});

/**
 * When the columns come from a table the customer edits, two rows naming the
 * same state is an ordinary typo — and an undeduplicated list rendered the
 * column twice, mounted every card in it twice, and registered the same dnd-kit
 * droppable and draggable ids twice.
 */
describe('a duplicated configuration row does not duplicate the board', () => {
    it('keeps the first entry and drops the repeat', () => {
        expect(kanbanColumns(
            [{ value: 'todo', label: 'To do' }, { value: 'todo', label: 'To do (oops)' }, { value: 'done', label: 'Done' }],
            [], 'status',
        ).map((c) => [c.value, c.label])).toEqual([['todo', 'To do'], ['done', 'Done']]);
    });

    it('does the same for swimlanes', () => {
        expect(kanbanSwimlanes(
            [{ value: 'a', label: 'A' }, { value: 'a', label: 'A again' }],
            [], 'lane',
        ).map((c) => c.value)).toEqual(['a']);
    });

    it('renders one column and one card per row when the config repeats itself', () => {
        const { container, getAllByText } = withRuntime(<AppKanban node={kbNode({}, {
            columnsSource: {
                kind: 'static',
                value: [{ state: 'open', name: 'Open' }, { state: 'open', name: 'Open again' }, { state: 'done', name: 'Done' }],
            },
        })} />);
        expect(container.querySelectorAll('[data-app-kanban-column="open"]').length).toBe(1);
        expect(getAllByText('Fix hive').length).toBe(1);
    });
});

/**
 * kanban.cardLook (spec: server/appStudio/componentSpecs.js). 'default' is the
 * IDENTITY value: the exact card style from before the prop existed and no
 * marker attribute — pinned so a stored board backfilled with
 * cardLook:'default' renders byte-identically. cardLook styles EVERY card the
 * same way; colorKey/cardColorMap keep coloring individual cards BY DATA, and
 * the two must coexist.
 */
describe('AppKanban — cardLook', () => {
    const cardsOf = (container) => [...container.querySelectorAll('[data-app-kanban-card]')];

    // jsdom quirk (pre-existing, unrelated to the look): React writes '' for
    // the undefined borderLeft, and cssstyle then drops border-color from the
    // serialized attribute — so the identity pin is the WHOLE serialized style,
    // exactly as the pre-look component produced it in this same environment.
    const IDENTITY_CARD_STYLE = 'background: var(--bg-card); border-radius: var(--app-radius); opacity: 1; touch-action: none;';

    it('default renders todays exact card surface and no look marker', () => {
        const { container } = withRuntime(<AppKanban node={kbNode()} />);
        const card = cardsOf(container)[0];
        expect(card.getAttribute('data-app-kanban-cardlook')).toBeNull();
        expect(card.getAttribute('style')).toBe(IDENTITY_CARD_STYLE);
        expect(card.style.boxShadow).toBe('');
    });

    it('an explicit "default" and an unknown value both take the identity path', () => {
        for (const cardLook of ['default', 'neon']) {
            const { container } = withRuntime(<AppKanban node={kbNode({}, { cardLook })} />);
            const card = cardsOf(container)[0];
            expect(card.getAttribute('data-app-kanban-cardlook')).toBeNull();
            expect(card.getAttribute('style')).toBe(IDENTITY_CARD_STYLE);
        }
    });

    it('tinted washes every card with the primary tint when no colorKey accents it', () => {
        const { container } = withRuntime(<AppKanban node={kbNode({}, { cardLook: 'tinted' })} />);
        for (const card of cardsOf(container)) {
            expect(card.getAttribute('data-app-kanban-cardlook')).toBe('tinted');
            expect(card.style.background).toBe('var(--app-primary-soft)');
        }
    });

    it('tinted follows the cards OWN accent when colorKey maps it — by-data color wins the wash', () => {
        const { container } = withRuntime(<AppKanban node={kbNode({}, {
            cardLook: 'tinted',
            source: { kind: 'static', value: [{ id: 'rec_1', title: 'Fix hive', status: 'open', kind: 'bug' }] },
            colorKey: 'kind',
            cardColorMap: [{ value: 'bug', label: 'Bug', tone: 'danger' }],
        })} />);
        const card = cardsOf(container)[0];
        expect(card.style.background).toContain('color-mix');
        expect(card.style.background).toContain('var(--bg-card)');
        // The 3px accent edge — the by-data mechanism — survives the look.
        expect(card.style.borderLeft).toBeTruthy();
    });

    it('raised elevates every card on shadow-2 with a slightly larger radius', () => {
        const { container } = withRuntime(<AppKanban node={kbNode({}, { cardLook: 'raised' })} />);
        const card = cardsOf(container)[0];
        expect(card.getAttribute('data-app-kanban-cardlook')).toBe('raised');
        expect(card.style.boxShadow).toBe('var(--app-shadow-2)');
        expect(card.style.borderRadius).toBe('calc(var(--app-radius) * 1.25)');
        expect(card.style.background).toBe('var(--bg-card)');
    });

    it('drag-drop keeps working under a non-default look', () => {
        const runAction = vi.fn();
        withRuntime(
            <AppKanban node={kbNode({ onCardMove: 'act_move01' }, { cardLook: 'raised' })} />,
            { mode: 'run', runAction },
        );
        act(() => {
            captured.onDragEnd({
                active: { id: 'appkanban-card:0', data: { current: { row: ROWS[0] } } },
                over: { id: 'appkanban-col:done' },
            });
        });
        expect(runAction).toHaveBeenCalledWith('act_move01', expect.objectContaining({ value: 'done' }));
    });

    it('looks introduce no purple', () => {
        for (const cardLook of ['tinted', 'raised']) {
            const { container } = withRuntime(<AppKanban node={kbNode({}, { cardLook })} />);
            expect(container.innerHTML).not.toMatch(/indigo|violet|purple|#6366f1|#4f46e5|#818cf8|#7c3aed|#a855f7/i);
        }
    });
});
