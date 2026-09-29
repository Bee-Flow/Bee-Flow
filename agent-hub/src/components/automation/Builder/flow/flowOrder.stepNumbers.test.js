// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { stepNumbers } from './flowOrder';

describe('stepNumbers — the numbers the cards wear', () => {
    const def = {
        trigger: { id: 't' },
        steps: [{ id: 'b', type: 'ai_step' }, { id: 'n', type: 'note' }, { id: 'a', type: 'set' }],
        edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }],
    };

    it('numbers in run order, trigger first, notes skipped', () => {
        const m = stepNumbers(def);
        expect(m.get('t')).toBe(1);
        expect(m.get('a')).toBe(2);
        expect(m.get('b')).toBe(3);
        expect(m.has('n')).toBe(false);
    });

    it('nests inline children under their parent when given the id helpers', () => {
        const d2 = { ...def, steps: [...def.steps, { id: 'b__x', type: 'set' }], edges: [...def.edges, { from: 'b', to: 'b__x' }] };
        const m = stepNumbers(d2, { isInlineId: id => id.includes('__'), parseInlineId: id => ({ prefix: id.split('__')[0] }) });
        expect(m.get('b__x')).toBe('3·1');
        expect(m.get('b')).toBe(3);
    });

    it('is safe on an empty definition', () => {
        expect(stepNumbers(null).size).toBe(0);
        expect(stepNumbers({}).size).toBe(0);
    });
});
