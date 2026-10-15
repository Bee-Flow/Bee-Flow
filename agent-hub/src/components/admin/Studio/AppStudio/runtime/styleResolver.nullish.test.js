// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    ROLE_COLORS, clampSpan, resolveHeightCss, resolveNodeStyle, resolveWidthCss, roleTextColor,
    spanGridColumn, spaceSteps,
} from './styleResolver';

/**
 * What the knob translators do with a value that is missing, non-numeric or
 * not a known key. The JS answered all of these by lookup/`Number.isFinite`
 * accident; the typed version spells the guards out, and this pins that the
 * answers did not move.
 */
describe('styleResolver: missing and odd knob values', () => {
    it('spaceSteps treats anything but a finite number as zero steps', () => {
        for (const n of [undefined, null, NaN, Infinity, -Infinity, '5', '', {}, [], true, 10n]) {
            expect(spaceSteps(n)).toBe('0px');
        }
        expect(spaceSteps(0)).toBe('0px');
        expect(spaceSteps(-2)).toBe('0px');
        expect(spaceSteps(2)).toBe('calc(8px * var(--app-space, 1))');
        expect(spaceSteps(1.5)).toBe('calc(6px * var(--app-space, 1))');
    });

    it('roleTextColor falls back to the primary role for a missing or unknown tone', () => {
        const primary = ROLE_COLORS.primary;
        const mixed = `color-mix(in srgb, ${primary} 55%, var(--text-primary))`;
        for (const tone of [undefined, null, 'nope', 'undefined', 'null']) expect(roleTextColor(tone)).toBe(mixed);
        expect(roleTextColor('primary')).toBe(primary);
        expect(roleTextColor('neutral')).toBe(ROLE_COLORS.neutral);
        expect(roleTextColor('warning')).toBe(`color-mix(in srgb, ${ROLE_COLORS.warning} 55%, var(--text-primary))`);
    });

    it('clampSpan keeps a finite span inside 1..12 and gives full width to anything else', () => {
        for (const s of [undefined, null, NaN, Infinity, '4', {}, []]) expect(clampSpan(s)).toBe(12);
        expect(clampSpan(0)).toBe(1);
        expect(clampSpan(-3)).toBe(1);
        expect(clampSpan(4.5)).toBe(4.5);
        expect(clampSpan(99)).toBe(12);
        expect(spanGridColumn(undefined)).toBe('span 12 / span 12');
        expect(spanGridColumn(3)).toBe('span 3 / span 3');
    });

    it('width and height CSS ignore a non-numeric value and a missing style', () => {
        expect(resolveWidthCss(undefined)).toBeNull();
        expect(resolveWidthCss(null)).toBeNull();
        expect(resolveWidthCss({ widthMode: 'px' })).toBeNull();
        expect(resolveWidthCss({ widthMode: 'px', widthValue: '320' })).toBeNull();
        expect(resolveWidthCss({ widthMode: 'px', widthValue: NaN })).toBeNull();
        expect(resolveWidthCss({ widthMode: 'px', widthValue: 320.4 })).toBe('320px');
        expect(resolveWidthCss({ widthMode: 'pct', widthValue: 50 })).toBe('50%');
        expect(resolveWidthCss({ widthMode: 'span', widthValue: 50 })).toBeNull();
        expect(resolveHeightCss(undefined)).toBeNull();
        expect(resolveHeightCss({ heightMode: 'vh' })).toBeNull();
        expect(resolveHeightCss({ heightMode: 'vh', heightValue: null })).toBeNull();
        expect(resolveHeightCss({ heightMode: 'vh', heightValue: 40 })).toBe('40vh');
        expect(resolveHeightCss({ heightMode: 'pct', heightValue: 30 })).toBe('30%');
        expect(resolveHeightCss({ heightMode: 'preset', heightValue: 30 })).toBeNull();
    });

    it('resolveNodeStyle: align, weight and size are looked up only when present', () => {
        const css = (style) => resolveNodeStyle({ style }).style;
        expect(css({})).toEqual({ gridColumn: 'span 12 / span 12' });
        expect(css({ align: undefined, weight: undefined, size: undefined }).textAlign).toBeUndefined();
        expect(css({ align: null, weight: null, size: null })).toEqual({ gridColumn: 'span 12 / span 12' });
        expect(css({ align: 'center' }).textAlign).toBe('center');
        expect(css({ align: 'end' }).textAlign).toBe('right');
        expect(css({ align: 'nope' }).textAlign).toBeUndefined();
        expect(css({ weight: 'semibold' }).fontWeight).toBe(600);
        expect(css({ weight: 'bold' }).fontWeight).toBeUndefined();
        expect(css({ size: 'sm' }).fontSize).toBe('0.875em');
        expect(css({ size: 'lg' }).fontSize).toBe('1.125em');
        expect(css({ size: 'md' }).fontSize).toBeUndefined();
        expect(css({ size: 'xl' }).fontSize).toBeUndefined();
        // Keys that exist on every object are found by `in`, exactly as before.
        expect(css({ align: 'toString' }).textAlign).toBe(Object.prototype.toString);
        expect(css({ weight: 'valueOf' }).fontWeight).toBe(Object.prototype.valueOf);
        // A key whose ToPropertyKey is a Symbol misses every table and never throws.
        const symKey = { toString: () => Symbol('k') };
        expect(css({ align: symKey, weight: symKey, size: { [Symbol.toPrimitive]: () => Symbol('s') } }))
            .toEqual({ gridColumn: 'span 12 / span 12' });
        expect(css({ align: { toString: () => 'center' } }).textAlign).toBe('center');
    });

    it('resolveNodeStyle: padding is a spacing step only for a finite positive number', () => {
        const pad = (padding) => resolveNodeStyle({ style: { padding } }).style.padding;
        expect(pad(2)).toBe('calc(8px * var(--app-space, 1))');
        for (const p of [0, -1, NaN, Infinity, undefined, null, '3', {}]) expect(pad(p)).toBeUndefined();
    });
});
