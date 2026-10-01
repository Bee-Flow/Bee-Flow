import { describe, expect, it } from 'vitest';
import previewBinding, { previewBindingShape } from './bindingPreview';

const sample = {
    trigger: { output: { name: 'Ada', tags: ['x', 'y'], rows: [{ item: 'Stoel' }, { item: 'Tafel' }] } },
    steps: {},
    secrets: { key: 'hush' },
};
const pick = (path: string[], extra: object = {}) => ({ kind: 'pick', v: 1, from: { root: 'trigger', path }, take: 'one', as: 'native', ...extra });

describe('previewBinding: every kind through the shared resolver', () => {
    it('previews a pick and a compose (they used to give nothing)', () => {
        expect(previewBinding(pick(['name']), sample)).toBe('Ada');
        expect(previewBinding(pick(['rows', 'item'], { take: 'all', as: 'text', join: 'comma' }), sample)).toBe('Stoel, Tafel');
        expect(previewBinding({ kind: 'compose', v: 1, parts: ['Hoi ', pick(['name'])] }, sample)).toBe('Hoi Ada');
        expect(previewBinding(pick(['missing']), sample)).toBeNull();
        expect(previewBinding(pick(['name']), null)).toBeNull();
    });

    it('keeps the legacy kinds and their raw fallbacks', () => {
        expect(previewBinding({ kind: 'literal', value: 'hi' }, sample)).toBe('hi');
        expect(previewBinding({ kind: 'ref', path: 'trigger.output.name' }, sample)).toBe('Ada');
        expect(previewBinding({ kind: 'ref', path: 'trigger.output.nope' }, sample)).toBe('(no sample for trigger.output.nope)');
        expect(previewBinding({ kind: 'ref', path: 'trigger.output.nope' }, sample, { raw: false })).toBeNull();
        expect(previewBinding({ kind: 'expr', value: 'upper(trigger.output.name)' }, sample)).toBe('ADA');
        expect(previewBinding({ kind: 'expr', value: 'nope(' }, sample)).toBe('expr: nope(');
        expect(previewBinding({ kind: 'template', value: 'Hi {{trigger.output.name}}' }, sample)).toBe('Hi Ada');
        expect(previewBinding({ kind: 'template', value: 'Hi {{trigger.output.nope}}' }, sample)).toBe('Hi {{trigger.output.nope}}');
        expect(previewBinding({ kind: 'template', value: 'Hi {{trigger.output.nope}}' }, sample, { raw: false })).toBeNull();
    });

    it('never shows a secret, as the run never puts one in a user-visible field', () => {
        expect(previewBinding({ kind: 'ref', path: 'secrets.key' }, sample, { raw: false })).toBeNull();
        expect(previewBinding({ kind: 'template', value: '{{secrets.key}}' }, sample, { raw: false })).toBeNull();
    });

    it('gives the shape of a pick too', () => {
        expect(previewBindingShape(pick(['tags'], { take: 'all', as: 'list' }), sample)).toEqual({ isList: true, count: 2, empty: false, first: 'x' });
        expect(previewBindingShape({ kind: 'ref', path: 'trigger.output.name' }, sample)).toEqual({ isList: false, count: null, empty: false, first: 'Ada' });
    });
});
