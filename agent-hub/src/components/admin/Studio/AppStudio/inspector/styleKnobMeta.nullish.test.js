// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    STYLE_KNOBS, TYPE_STYLE_KNOBS, clampKnob, effectiveSizeMode, getKnobsForType, unitRange,
} from './styleKnobMeta';

describe('styleKnobMeta: missing and odd arguments', () => {
    it('getKnobsForType gives an empty list for no type and for an unknown one', () => {
        expect(getKnobsForType(undefined)).toEqual([]);
        expect(getKnobsForType(null)).toEqual([]);
        expect(getKnobsForType('nope')).toEqual([]);
        expect(getKnobsForType('undefined')).toEqual([]);
        expect(getKnobsForType('heading')).toBe(TYPE_STYLE_KNOBS.heading);
    });

    it('unitRange is null without a mode, for an unknown mode and for a knob without units', () => {
        expect(unitRange('widthValue', undefined)).toBeNull();
        expect(unitRange('widthValue', null)).toBeNull();
        expect(unitRange('widthValue', 'span')).toBeNull();
        expect(unitRange('widthValue', 'px')).toEqual(STYLE_KNOBS.widthValue.units.px);
        expect(unitRange('heightValue', 'vh')).toEqual(STYLE_KNOBS.heightValue.units.vh);
        expect(unitRange('span', 'px')).toBeNull();
        expect(unitRange('nope', 'px')).toBeNull();
    });

    it('every unit knob names an enum knob whose values are all strings', () => {
        // effectiveSizeMode only ever asks a string-valued enum for membership.
        for (const [name, spec] of Object.entries(STYLE_KNOBS)) {
            if (spec.type !== 'unitInt') continue;
            const modeSpec = STYLE_KNOBS[spec.modeKnob];
            expect(modeSpec, name).toBeDefined();
            expect(modeSpec.type).toBe('enum');
            expect(modeSpec.values.every((v) => typeof v === 'string')).toBe(true);
            expect(typeof modeSpec.default).toBe('string');
        }
    });

    it('effectiveSizeMode reads the sibling mode, or its default for anything else', () => {
        expect(effectiveSizeMode({ widthMode: 'px' }, 'widthValue')).toBe('px');
        expect(effectiveSizeMode({ widthMode: 'pct' }, 'widthValue')).toBe('pct');
        expect(effectiveSizeMode({ heightMode: 'vh' }, 'heightValue')).toBe('vh');
        for (const mode of [undefined, null, 5, {}, [], 'nope', true]) {
            expect(effectiveSizeMode({ widthMode: mode }, 'widthValue')).toBe('span');
            expect(effectiveSizeMode({ heightMode: mode }, 'heightValue')).toBe('preset');
        }
        expect(effectiveSizeMode(null, 'widthValue')).toBe('span');
        expect(effectiveSizeMode(undefined, 'heightValue')).toBe('preset');
        expect(effectiveSizeMode({}, 'span')).toBeNull();
        expect(effectiveSizeMode({}, 'nope')).toBeNull();
    });

    it('clampKnob clamps a unit knob through the mode', () => {
        expect(clampKnob('widthValue', 5000, { widthMode: 'px' })).toBe(2000);
        expect(clampKnob('widthValue', 1, { widthMode: 'pct' })).toBe(5);
        expect(clampKnob('widthValue', 1, {})).toBeNull();
        expect(clampKnob('widthValue', null, { widthMode: 'px' })).toBeNull();
        expect(clampKnob('widthValue', 'x', { widthMode: 'px' })).toBe(320);
        expect(clampKnob('heightValue', 70, { heightMode: 'vh' })).toBe(70);
        expect(clampKnob('widthMode', 'px')).toBe('px');
        expect(clampKnob('widthMode', 'nope')).toBe('span');
    });
});
