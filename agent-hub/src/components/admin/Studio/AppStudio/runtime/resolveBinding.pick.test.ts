// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveBinding, dataCacheKey } from './resolveBinding';
import { stub } from '@/test/mocks';

// A saved view answers with ROWS; a stat tile means one value out of them.
const ROWS = [
    { month: '2026-01', open_count: 12 },
    { month: '2026-02', open_count: 7 },
];

function stateFor(binding: Parameters<typeof dataCacheKey>[0], entry: unknown) {
    return { dataState: { [dataCacheKey(binding) as string]: entry } };
}

describe('resolveBinding — pick (one value out of a row-shaped result)', () => {
    const base = { kind: 'dataset', datasetId: 'ds_1' };
    const loaded = { status: 'success', result: ROWS, datasetId: 'ds_1' };

    it('without pick the dataset still resolves to the whole row array', () => {
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(base), stateFor(stub<Parameters<typeof stateFor>[0]>(base), loaded)))
            .toEqual({ value: ROWS, isLoading: false, error: null, errorCode: null });
    });

    it('first/last row × column', () => {
        const first = { ...base, pick: { row: 'first', column: 'open_count' } };
        const last = { ...base, pick: { row: 'last', column: 'open_count' } };
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(first), stateFor(stub<Parameters<typeof stateFor>[0]>(base), loaded)).value).toBe(12);
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(last), stateFor(stub<Parameters<typeof stateFor>[0]>(base), loaded)).value).toBe(7);
    });

    it('an unnamed column yields the whole row, so a half-set pick is harmless', () => {
        const noColumn = { ...base, pick: { row: 'first' } };
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(noColumn), stateFor(stub<Parameters<typeof stateFor>[0]>(base), loaded)).value).toEqual(ROWS[0]);
        const emptyColumn = { ...base, pick: { row: 'first', column: '' } };
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(emptyColumn), stateFor(stub<Parameters<typeof stateFor>[0]>(base), loaded)).value).toEqual(ROWS[0]);
    });

    it('a column that is not in the answer resolves to undefined, never throws', () => {
        const gone = { ...base, pick: { row: 'first', column: 'nope' } };
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(gone), stateFor(stub<Parameters<typeof stateFor>[0]>(base), loaded)).value).toBeUndefined();
    });

    it('an empty answer picks nothing', () => {
        const b = { ...base, pick: { row: 'first', column: 'open_count' } };
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(b), stateFor(stub<Parameters<typeof stateFor>[0]>(base), { status: 'success', result: [], datasetId: 'ds_1' })).value).toBeUndefined();
    });

    it('loading and error pass through untouched', () => {
        const b = { ...base, pick: { row: 'first', column: 'open_count' } };
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(b), stateFor(stub<Parameters<typeof stateFor>[0]>(base), { status: 'loading' })))
            .toEqual({ value: undefined, isLoading: true, error: null, errorCode: null });
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(b), stateFor(stub<Parameters<typeof stateFor>[0]>(base), { status: 'error', error: 'boom' })))
            .toEqual({ value: undefined, isLoading: false, error: 'boom', errorCode: null });
        // No entry at all is "not started", exactly as without a pick.
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(b), { dataState: {} }))
            .toEqual({ value: undefined, isLoading: true, error: null, errorCode: null });
    });

    it('a single-row source needs no row step', () => {
        const rec = { kind: 'record', tableId: 't1' };
        const picked = { ...rec, pick: { row: 'first', column: 'open_count' } };
        expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>(picked), stateFor(stub<Parameters<typeof stateFor>[0]>(rec), { status: 'success', result: ROWS[0], tableId: 't1' })).value).toBe(12);
    });

    it('a malformed pick is ignored rather than fatal', () => {
        for (const pick of [null, 'first', 42, ['open_count']]) {
            expect(resolveBinding(stub<Parameters<typeof resolveBinding>[0]>({ ...base, pick }), stateFor(stub<Parameters<typeof stateFor>[0]>(base), loaded)).value).toEqual(ROWS);
        }
    });

    it('pick is a read-side lens: two tiles over one view share a cache key', () => {
        const a = { ...base, pick: { row: 'first', column: 'open_count' } };
        const b = { ...base, pick: { row: 'last', column: 'month' } };
        expect(dataCacheKey(stub<Parameters<typeof dataCacheKey>[0]>(a))).toBe(dataCacheKey(stub<Parameters<typeof dataCacheKey>[0]>(base)));
        expect(dataCacheKey(stub<Parameters<typeof dataCacheKey>[0]>(b))).toBe(dataCacheKey(stub<Parameters<typeof dataCacheKey>[0]>(base)));
    });
});
