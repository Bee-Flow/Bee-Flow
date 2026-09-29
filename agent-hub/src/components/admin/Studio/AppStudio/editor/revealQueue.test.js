// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planReveal, revealEndsAfterMs } from './revealQueue';

const DEF = { screens: [{ id: 'scr_a' }, { id: 'scr_b' }] };

describe('planReveal', () => {
    it('deals cells 1.2 s apart in the server\'s order, screens aside as chapter breaks', () => {
        const diff = { addedIds: new Set(['cmp_1', 'cmp_2', 'scr_b', 'cmp_3']) };
        const plan = planReveal({ diff, definition: DEF, hintIds: ['cmp_3', 'cmp_1'] });
        expect(plan.screens).toEqual(['scr_b']);
        expect(plan.ids).toEqual(['cmp_3', 'cmp_1', 'cmp_2'], 'hinted ids first in hint order, the rest in diff order');
        expect([...plan.delays.entries()]).toEqual([['cmp_3', 0], ['cmp_1', 1200], ['cmp_2', 2400]]);
        expect(plan.animate).toBe(true);
        expect(revealEndsAfterMs(plan)).toBe(3600);
    });

    it('reduced motion keeps the ids and drops every delay', () => {
        const plan = planReveal({ diff: { addedIds: new Set(['cmp_1', 'cmp_2']) }, definition: DEF, reducedMotion: true });
        expect(plan.ids).toEqual(['cmp_1', 'cmp_2']);
        expect(plan.delays.size).toBe(0);
        expect(plan.animate).toBe(false);
        expect(revealEndsAfterMs(plan)).toBe(1200);
    });

    it('nothing added → an empty plan; a big burst compresses to the 15 s budget', () => {
        expect(planReveal({ diff: { addedIds: new Set() }, definition: DEF })).toEqual({ ids: [], screens: [], delays: new Map(), animate: false });
        const many = new Set(Array.from({ length: 31 }, (_, i) => `cmp_${i}`));
        const plan = planReveal({ diff: { addedIds: many }, definition: DEF });
        expect(plan.delays.get('cmp_30')).toBe(15000);
        expect(plan.delays.get('cmp_1')).toBe(500);
    });
});
