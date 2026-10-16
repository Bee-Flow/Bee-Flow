import { describe, it, expect } from 'vitest';
import { designStyleClasses, designStyleVars, displayTrackingEm, withFlatBand, withSingleMotif } from './blockWrap';

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
        // An explicit 'mono' overrides a theme-wide plain label style, so it gets a class too.
        expect(designStyleClasses({ labelStyle: 'mono' })).toEqual(['cms-label-mono']);
        expect(designStyleClasses({ decor: 'default', cardFill: 'tint' })).toEqual([]);
        expect(designStyleClasses({ decor: 'blur(9px)', cardFill: '#fff', labelStyle: 'x y' })).toEqual([]);
    });
});

describe('block icon tiles', () => {
    it('turns the tile keys into fixed custom properties on the wrapper', () => {
        expect(designStyleVars({ tileShape: 'circle', tileSize: 'lg' })).toEqual({
            '--tile-radius': '999px', '--tile-clip': 'initial', '--tile-ring-clip': 'initial', '--tile-border': 'initial', '--tile-scale': '1.3',
        });
        expect(designStyleVars({ tileShape: 'default', tileFill: 'url(x)' })).toEqual({});
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

describe('withFlatBand', () => {
    it('hands an explicit default band to legacy blocks as backgroundVariant default', () => {
        const block = { type: 'steps', style: { band: 'default' }, content: { title: 'x' } };
        expect(withFlatBand(block).content).toEqual({ title: 'x', backgroundVariant: 'default' });
    });

    it('leaves other bands, a set variant and a missing band alone', () => {
        const dark = { style: { band: 'dark' }, content: {} };
        const surface = { style: { band: 'default' }, content: { backgroundVariant: 'surface' } };
        const none = { content: {} };
        expect(withFlatBand(dark)).toBe(dark);
        expect(withFlatBand(surface)).toBe(surface);
        expect(withFlatBand(none)).toBe(none);
    });
});

describe('withSingleMotif', () => {
    it('turns the cta content showMotif off when style.motif is set (one motif, style wins)', () => {
        const block = { type: 'cta', style: { motif: 'honeycomb' }, content: { showMotif: true, title: 'x' } };
        expect(withSingleMotif(block).content).toEqual({ showMotif: false, title: 'x' });
    });

    it('leaves a cta without style.motif, and other block types, alone', () => {
        const plain = { type: 'cta', style: {}, content: { showMotif: true } };
        const other = { type: 'hero', style: { motif: 'honeycomb' }, content: { showMotif: true } };
        expect(withSingleMotif(plain)).toBe(plain);
        expect(withSingleMotif(other)).toBe(other);
    });
});
