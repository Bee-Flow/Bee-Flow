import { describe, it, expect } from 'vitest';
import { buildInsertItems } from './insertItems';

describe('buildInsertItems', () => {
    const items = buildInsertItems((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key));

    it('lists the blocks in menu order, with translated labels', () => {
        expect(items.map((i) => i.key)).toEqual(['h1', 'h2', 'h3', 'bullet', 'ordered', 'task', 'quote', 'code', 'table', 'divider', 'image', 'math']);
        expect(items[0].label).toBe('Heading 1');
    });

    it('keeps the fixed-size table in the slash menu only (BFSF-316)', () => {
        expect(items.filter((i) => i.slashOnly).map((i) => i.key)).toEqual(['table']);
    });

    it('leaves image and math to the editor, everything else extends the chain', () => {
        expect(items.filter((i) => i.action).map((i) => [i.key, i.action])).toEqual([['image', 'image'], ['math', 'math']]);
        const calls: unknown[][] = [];
        const chain = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { calls.push([name, ...args]); return chain; } });
        items.find((i) => i.key === 'h2')!.apply!(chain);
        items.find((i) => i.key === 'table')!.apply!(chain);
        expect(calls).toEqual([['toggleHeading', { level: 2 }], ['insertTable', { rows: 3, cols: 3, withHeaderRow: true }]]);
    });
});
