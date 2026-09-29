// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { describeDateTime } from './collectionSteps';

/**
 * What a Date & time step offers the variable picker downstream.
 *
 * A step saved with a whole column in "Input date" and no `arrayRef` runs as
 * list mode (BFSF-375), so it emits `{ items, count }` — the picker has to
 * offer that shape, not the single-date `value` the run never produces.
 */

const paths = (group: { fields: Array<{ path: string; children?: unknown[] }> }): string[] => {
    const out: string[] = [];
    const walk = (fields: Array<{ path: string; children?: unknown[] }>) => {
        for (const f of fields) {
            out.push(f.path);
            if (Array.isArray(f.children)) walk(f.children as Array<{ path: string; children?: unknown[] }>);
        }
    };
    walk(group.fields);
    return out;
};

describe('describeDateTime', () => {
    it('offers the list shape for a column saved without list mode', () => {
        const g = describeDateTime({
            id: 'dt1', type: 'datetime', op: 'extract', part: 'day',
            input: 'steps.s.output.results[*].updated',
        });
        expect(g.sample).toHaveProperty('items');
        expect(g.sample).toHaveProperty('count');
        expect(paths(g).some((p) => p.includes('items') && p.endsWith('.day'))).toBe(true);
    });

    it('keeps the single-date shape for one date', () => {
        const g = describeDateTime({ id: 'dt1', type: 'datetime', op: 'extract', part: 'day', input: 'trigger.output.when' });
        expect(g.sample).not.toHaveProperty('items');
        expect(g.sample).toHaveProperty('value');
    });
});
