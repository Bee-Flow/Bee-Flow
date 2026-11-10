import { describe, it, expect } from 'vitest';
import { STYLE_VALUE_CONTROLS, collectStyleValueControls, isBaseValueType } from './styleValueControls';
import { STYLE_KNOBS } from './styleKnobMeta';
import type { StyleValueControlProps } from './styleValueControls';

const Control = (_props: StyleValueControlProps) => null;

describe('style value controls added as files', () => {
    it('ships empty, and every knob in the catalogue is a base value type', () => {
        expect(STYLE_VALUE_CONTROLS).toEqual({});
        for (const [knob, spec] of Object.entries(STYLE_KNOBS)) expect(isBaseValueType(spec?.type ?? ''), knob).toBe(true);
    });

    it('keys a control by its file name', () => {
        const controls = collectStyleValueControls({
            './styleValueControls/css.tsx': { default: Control },
            './styleValueControls/asset.tsx': { default: Control },
        });
        expect(Object.keys(controls)).toEqual(['asset', 'css']);
    });

    it('refuses a base value type and a file without a component', () => {
        expect(() => collectStyleValueControls({ './styleValueControls/enum.tsx': { default: Control } })).toThrow(/StyleSection itself/);
        expect(() => collectStyleValueControls({ './styleValueControls/asset.tsx': {} })).toThrow(/control component/);
    });
});
