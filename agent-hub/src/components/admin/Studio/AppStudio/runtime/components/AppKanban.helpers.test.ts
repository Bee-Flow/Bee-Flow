import { describe, it, expect } from 'vitest';
import type { Active, Over } from '@dnd-kit/core';
import { NO_LANE, accentFor, bucketCells, cardMovePayload, columnDroppableId, gridStyleFor, toggledInSet } from './AppKanban.helpers';
import type { KanbanRow } from './AppKanban.types';

const rows: KanbanRow[] = [
    { id: 'a', status: 'todo', rank: 1 },
    { id: 'b', status: 'todo', rank: 2 },
    { id: 'c', status: 'done', rank: 3 },
];
const groupOf = (r: KanbanRow) => String(r.status ?? '');
const laneOf = () => NO_LANE;
const cells = bucketCells(rows, laneOf, groupOf);
const cellOf = (lane: string, col: string) => cells.get(`${lane}\u0000${col}`) || [];

const activeCard = (index: number): Active => ({
    id: `appkanban-card:${index}`,
    data: { current: { row: rows[index] } },
    rect: { current: { initial: null, translated: null } },
});
const overId = (id: string): Over => ({
    id,
    rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
    disabled: false,
    data: { current: undefined },
});
const drag = (index: number, target: string) => ({ active: activeCard(index), over: overId(target) });

describe('bucketCells', () => {
    it('buckets every row by lane + column, in source order, with its index', () => {
        expect(cellOf(NO_LANE, 'todo').map((c) => c.index)).toEqual([0, 1]);
        expect(cellOf(NO_LANE, 'done').map((c) => c.row.id)).toEqual(['c']);
    });
});

describe('cardMovePayload', () => {
    const base = { rows, laneOf, groupOf, cellOf, rankKey: 'rank', laned: false };

    it('moves a card to the end of another column, with the rank after its new neighbour', () => {
        const p = cardMovePayload({ ...base, ...drag(0, columnDroppableId(NO_LANE, 'done')) });
        expect(p).toMatchObject({ item: rows[0], value: 'done', lane: null, index: 1, beforeId: 'c', afterId: null });
        expect(typeof p?.rank).toBe('number');
    });

    it('takes the slot of the card it is dropped on', () => {
        const p = cardMovePayload({ ...base, ...drag(1, 'appkanban-card:0') });
        expect(p).toMatchObject({ value: 'todo', index: 0, beforeId: null, afterId: 'a' });
    });

    it('is null for a drop that changes nothing, on itself, or on nothing', () => {
        expect(cardMovePayload({ ...base, ...drag(1, columnDroppableId(NO_LANE, 'todo')) })).toBeNull();
        expect(cardMovePayload({ ...base, ...drag(0, 'appkanban-card:0') })).toBeNull();
        expect(cardMovePayload({ ...base, active: drag(0, 'x').active, over: null })).toBeNull();
    });

    it('sends no rank when the board declares no rankKey', () => {
        expect(cardMovePayload({ ...base, rankKey: null, ...drag(0, columnDroppableId(NO_LANE, 'done')) })?.rank).toBeNull();
    });
});

describe('accentFor / gridStyleFor / toggledInSet', () => {
    it('maps a colour value to its tone, and nothing to null', () => {
        expect(accentFor({ p: 'hi' }, 'p', [{ value: 'hi', tone: 'danger' }])).toBeTruthy();
        expect(accentFor({ p: 'lo' }, 'p', [{ value: 'hi', tone: 'danger' }])).toBeNull();
        expect(accentFor({ p: 'hi' }, null, [])).toBeNull();
    });

    it('shares one column template across lanes', () => {
        expect(gridStyleFor(3).gridTemplateColumns).toBe('repeat(3, minmax(220px, 1fr))');
    });

    it('toggles a value without touching the original set', () => {
        const s = new Set(['a']);
        expect([...toggledInSet(s, 'b')]).toEqual(['a', 'b']);
        expect([...toggledInSet(s, 'a')]).toEqual([]);
        expect([...s]).toEqual(['a']);
    });
});
