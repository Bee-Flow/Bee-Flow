import { describe, it, expect } from 'vitest';
import { STYLE_VALUE_CONTROLS, collectStyleValueControls, isBaseValueType } from './styleValueControls';
import { STYLE_KNOBS } from './styleKnobMeta';
import type { StyleValueControlProps } from './styleValueControls';

const Control = (_props: StyleValueControlProps) => null;

describe('style value controls added as files', () => {
    it('every knob in the catalogue can be drawn: a base value type, or one with its control file', () => {
        for (const [knob, spec] of Object.entries(STYLE_KNOBS)) {
            const type = spec?.type ?? '';
            const drawn = isBaseValueType(type) || Object.hasOwn(STYLE_VALUE_CONTROLS, type);
            expect(drawn, `knob ${knob} has value type "${type}": add inspector/styleValueControls/${type}.tsx`).toBe(true);
        }
        for (const [type, control] of Object.entries(STYLE_VALUE_CONTROLS)) {
            expect(isBaseValueType(type), type).toBe(false);
            expect(typeof control, type).toBe('function');
        }
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
