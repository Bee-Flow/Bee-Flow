import { fadeHex, hiddenAt, mixHex, nodeStyleNative, roleTextColor, sectionStyleNative, spacePx, type AppStyleTheme } from './styleNative';
import { resolveNodeLayout, resolveSectionLayout } from './styleResolver';

const theme: AppStyleTheme = {
    density: 1.25,
    radius: 10,
    colors: {
        primary: '#2563eb',
        primarySoft: '#dbeafe',
        textPrimary: '#000000',
        textSecondary: '#6b7280',
        bgCard: '#ffffff',
        border: '#e5e7eb',
    },
    window: { width: 1100, height: 800 },
};

describe('styleNative', () => {
    it('spaces in steps of 4px times the density', () => {
        expect(spacePx(2, theme)).toBe(10);
        expect(spacePx(0, theme)).toBe(0);
        expect(spacePx(-1, theme)).toBe(0);
    });

    it('mixes and fades colours', () => {
        expect(mixHex('#ffffff', '#000000', 50)).toBe('#808080');
        expect(fadeHex('#ff0000', 55)).toBe('rgba(255, 0, 0, 0.55)');
        expect(roleTextColor('primary', theme)).toBe('#2563eb');
        expect(roleTextColor('warning', theme)).toBe(mixHex('#f59e0b', '#000000', 55));
    });

    it('turns a node layout into cell, box and text styles', () => {
        const layout = resolveNodeLayout({
            style: { span: 6, align: 'center', weight: 'semibold', size: 'lg', color: 'danger', padding: 2, background: 'panel', height: 'md', widthMode: 'px', widthValue: 300 },
        });
        const out = nodeStyleNative(layout, theme, { gapPx: 12, baseFontSize: 16 });
        expect(out.cell).toEqual({ width: '50%', paddingHorizontal: 6, minWidth: 0 });
        expect(out.box).toMatchObject({ height: 200, padding: 10, backgroundColor: '#ffffff', borderRadius: 10, width: 300, maxWidth: '100%' });
        expect(out.text).toEqual({ textAlign: 'center', fontWeight: '600', fontSize: 18, color: '#ef4444' });
        expect(out.hidden).toBe(false);
    });

    it('stacks every cell below 640 wide and honours the hide bands', () => {
        const narrow = { ...theme, window: { width: 390, height: 800 } };
        expect(nodeStyleNative(resolveNodeLayout({ style: { span: 3 } }), narrow).cell.width).toBe('100%');
        expect(hiddenAt({ hideBelow: 'sm', hideAbove: null }, 390)).toBe(true);
        expect(hiddenAt({ hideBelow: 'sm', hideAbove: null }, 390, true)).toBe(false);
        expect(hiddenAt({ hideBelow: null, hideAbove: 'md' }, 1024)).toBe(true);
        expect(hiddenAt({ hideBelow: null, hideAbove: 'md' }, 1023)).toBe(false);
    });

    it('fills and sizes explicitly', () => {
        expect(nodeStyleNative(resolveNodeLayout({ style: { height: 'fill' } }), theme).box).toMatchObject({ flexGrow: 1, flexBasis: 0 });
        expect(nodeStyleNative(resolveNodeLayout({ style: { heightMode: 'vh', heightValue: 50 } }), theme).box.height).toBe(400);
    });

    it('lays a section out as a wrapping row', () => {
        const out = sectionStyleNative(resolveSectionLayout({ style: { gap: 2, padding: 4, background: 'surface' } }), theme);
        expect(out.gapPx).toBe(10);
        expect(out.row).toEqual({ flexDirection: 'row', flexWrap: 'wrap', rowGap: 10, marginHorizontal: -5 });
        expect(out.outer).toMatchObject({ padding: 20, backgroundColor: '#ffffff', borderRadius: 10 });
    });
});
