import { describe, it, expect } from 'vitest';
import { designStyleClasses, designStyleVars, displayTrackingEm } from './blockWrap';

describe('designStyleClasses', () => {
    it('emits nothing for a style without design keys', () => {
        expect(designStyleClasses(undefined)).toEqual([]);
        expect(designStyleClasses({ band: 'dark', backgroundImage: 'cms/x.png' })).toEqual([]);
    });

    it('maps the background placement to class names', () => {
        expect(designStyleClasses({
            backgroundSize: 'contain', backgroundPosition: 'top-right', backgroundRepeat: 'repeat-x', backgroundHideMobile: true,
        })).toEqual(['cms-bg-size-contain', 'cms-bg-pos-top-right', 'cms-bg-repeat-repeat-x', 'cms-bg-hide-mobile']);
    });

    it('uses one class and a custom property for a pixel width', () => {
        expect(designStyleClasses({ backgroundSize: '480px' })).toEqual(['cms-bg-size-px']);
        expect(designStyleVars({ backgroundSize: '480px' })).toEqual({ '--cms-bg-size': '480px auto' });
        expect(designStyleVars({ backgroundSize: 'cover' })).toEqual({});
    });

    it('turns the honeycomb on with its side and tiles, defaulting to the right', () => {
        expect(designStyleClasses({ motif: 'honeycomb' })).toEqual(['cms-motif', 'cms-motif--honeycomb', 'cms-motif--right']);
        expect(designStyleClasses({ motif: 'honeycomb', motifSide: 'left', motifTiles: true }))
            .toEqual(['cms-motif', 'cms-motif--honeycomb', 'cms-motif--left', 'cms-motif--tiles']);
        expect(designStyleClasses({ motif: 'none', motifSide: 'left' })).toEqual([]);
    });

    it('drops anything outside the whitelist instead of putting it in a class or a variable', () => {
        const hostile = {
            backgroundSize: 'url(//evil.example/a.png)', backgroundPosition: 'center" onload="x', backgroundRepeat: 'x y',
            backgroundHideMobile: 'yes', motif: 'honeycomb', motifSide: 'right; color:red',
        };
        expect(designStyleClasses(hostile)).toEqual(['cms-motif', 'cms-motif--honeycomb', 'cms-motif--right']);
        expect(designStyleVars(hostile)).toEqual({});
        expect(designStyleVars({ backgroundSize: '9999px' })).toEqual({});
    });
});

describe('look switches', () => {
    it('maps decor, cardFill and labelStyle to fixed class names; identity values add none', () => {
        expect(designStyleClasses({ decor: 'none', cardFill: 'white', labelStyle: 'plain' }))
            .toEqual(['cms-decor-none', 'cms-cardfill-white', 'cms-label-plain']);
        expect(designStyleClasses({ cardFill: 'none' })).toEqual(['cms-cardfill-none']);
        expect(designStyleClasses({ decor: 'default', cardFill: 'tint', labelStyle: 'mono' })).toEqual([]);
        expect(designStyleClasses({ decor: 'blur(9px)', cardFill: '#fff', labelStyle: 'x y' })).toEqual([]);
    });
});

describe('displayTrackingEm', () => {
    it('maps the three tracking names and nothing inherited from Object.prototype', () => {
        expect(displayTrackingEm('tighter')).toBe('-0.045em');
        expect(displayTrackingEm('default')).toBeUndefined();
        expect(displayTrackingEm('constructor')).toBeUndefined();
        expect(displayTrackingEm('toString')).toBeUndefined();
    });
});
