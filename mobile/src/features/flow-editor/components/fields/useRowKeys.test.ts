import { arrivedName, handOver, pendingRowKey, withKeys, type RowKeyState } from './useRowKeys';

const EMPTY: RowKeyState = { byName: new Map(), drawn: 0 };

describe('row keys', () => {
    it('draws a new key for each new name and keeps the ones it has', () => {
        const first = withKeys(EMPTY, ['a', 'b']);
        expect([...first.byName]).toEqual([
            ['a', 'row-1'],
            ['b', 'row-2'],
        ]);
        expect(withKeys(first, ['b', 'a'])).toBe(first);
        expect(withKeys(first, ['a', 'c']).byName.get('c')).toBe('row-3');
    });

    it('never hands a renamed row’s key to a new row that takes its old name', () => {
        const renamed = handOver(withKeys(EMPTY, ['a']), 'row-1', 'b', 'a');
        const next = withKeys(renamed, ['b', 'a']);
        expect(next.byName.get('b')).toBe('row-1');
        expect(next.byName.get('a')).toBe('row-2');
    });

    it('lets a pending row keep its key when it joins the map', () => {
        const joined = withKeys(handOver(EMPTY, pendingRowKey(2), 'field2'), ['field2']);
        expect(joined.byName.get('field2')).toBe('new-2');
    });

    it('finds where a renamed or joining row went', () => {
        expect(arrivedName({ a: 1, c: 2 }, { a: 1, newname: 2 })).toBe('newname');
        expect(arrivedName({ a: 1 }, { a: 1 })).toBeUndefined();
        expect(arrivedName({}, { constructor: 1 })).toBe('constructor');
    });
});
