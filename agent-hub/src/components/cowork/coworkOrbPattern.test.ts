import { expect, it } from 'vitest';
import { advanceLayers, updatePattern } from './coworkOrbPattern';
import type { OrbPattern } from './coworkOrbFrame';
import type { NeuralGlyph } from './coworkOrbGlyph';

it('signals a reported step once, converges for AI, and goes quiet while waiting', () => {
    const marks = ['mail', 'summary'].map(id => ({ id }) as NeuralGlyph);
    const layers: OrbPattern[] = [];
    const progress = { id: '' };
    const layout = { ordered: true, reduced: false, target: 0 };
    updatePattern(layers, marks, { ...layout, step: { id: 'mail', kind: 'fixed' } }, progress);
    expect(layers[0]).toMatchObject({ active: 0, from: -1, phase: 0, converge: false });
    advanceLayers(layers, 0, 3);
    updatePattern(layers, marks, { ...layout, step: { id: 'mail', kind: 'fixed' } }, progress);
    expect(layers[0].phase).toBe(1);
    updatePattern(layers, marks, layout, progress);
    expect(layers[0].active).toBe(-1);
    updatePattern(layers, marks, { ...layout, step: { id: 'mail', kind: 'fixed' } }, progress);
    expect(layers[0]).toMatchObject({ active: 0, from: -1, phase: 0 });
    updatePattern(layers, marks, { ...layout, target: 1, step: { id: 'summary', kind: 'ai' } }, progress);
    expect(layers[0]).toMatchObject({ active: 1, from: 0, phase: 0, converge: true });
});
