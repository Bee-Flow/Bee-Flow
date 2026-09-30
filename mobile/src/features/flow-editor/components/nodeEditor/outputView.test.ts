import { outputView } from './outputView';

describe('outputView', () => {
    it('draws a table, fields, a list or prose readably, with the raw tree one tap away', () => {
        for (const value of [[{ a: 1 }], { a: 1 }, ['x', 'y'], 'Dear Ann, thanks for the order.']) {
            expect(outputView(value, false)).toEqual({ body: 'preview', readableTree: false, canToggle: true });
            expect(outputView(value, true)).toEqual({ body: 'tree', readableTree: false, canToggle: true });
        }
    });

    it('draws a value too nested for those as a tree in words, and as JSON on request', () => {
        const nested = { messages: [{ id: 1, labels: ['INBOX'] }], count: 1 };
        expect(outputView(nested, false)).toEqual({ body: 'tree', readableTree: true, canToggle: true });
        expect(outputView(nested, true)).toEqual({ body: 'tree', readableTree: false, canToggle: true });
    });

    it('offers no toggle for a single literal, and draws nothing for nothing', () => {
        expect(outputView(42, true)).toEqual({ body: 'preview', readableTree: false, canToggle: false });
        expect(outputView(null, false).body).toBe('none');
        expect(outputView(undefined, true).body).toBe('none');
        expect(outputView({}, false).body).toBe('none');
    });
});
