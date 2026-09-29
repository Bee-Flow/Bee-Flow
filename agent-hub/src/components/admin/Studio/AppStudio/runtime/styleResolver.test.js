// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
    resolveBackground,
    resolveNodeStyle,
    resolveSectionStyle,
    resolveWidthCss,
    resolveHeightCss,
    resolveSectionHeightCss,
    applyWidth,
    isFill,
    spaceSteps,
    SOFT_PRIMARY_GRADIENT,
} from './styleResolver';

/**
 * The background knob grew two look-pass values ('panel', 'gradient' —
 * componentSpecs.js STYLE_KNOBS). The contract these tests pin:
 *
 *   IDENTITY — the original values ('none'/'surface'/'tint') keep their exact
 *   output: same strings, same keys, no new class, no new style. A stored
 *   definition from before the look pass renders byte-identically.
 *
 *   NEW VALUES — 'panel' is an elevated card band (surface fill + hairline via
 *   .app-surface + semantic elevation + theme radius); 'gradient' is a very
 *   soft primary wash. Both are built ENTIRELY from tokens — no hex colors, so
 *   dark mode and high-contrast keep working for free.
 *
 *   UNKNOWN — anything else paints nothing (an old client on a newer def
 *   degrades to a plain section rather than something wrong).
 */

describe('resolveBackground — identity for the original values', () => {
    it("'none' / absent / unknown resolve to null", () => {
        expect(resolveBackground('none')).toBeNull();
        expect(resolveBackground(undefined)).toBeNull();
        expect(resolveBackground(null)).toBeNull();
        expect(resolveBackground('sparkle')).toBeNull(); // future value, older client
    });

    it("'surface' and 'tint' keep their exact strings", () => {
        expect(resolveBackground('surface')).toBe('var(--bg-card)');
        expect(resolveBackground('tint')).toBe('var(--app-primary-soft)');
    });
});

describe('resolveBackground — look-pass values', () => {
    it("'panel' shares the surface fill", () => {
        expect(resolveBackground('panel')).toBe('var(--bg-card)');
    });

    it("'gradient' is a primary-derived gradient with zero hex colors", () => {
        const g = resolveBackground('gradient');
        expect(g).toBe(SOFT_PRIMARY_GRADIENT);
        expect(g).toMatch(/^linear-gradient\(/);
        expect(g).toContain('var(--app-primary)');
        expect(g).toContain('color-mix(');
        expect(g).not.toContain('#'); // tokens only — themes keep working
    });
});

describe('resolveSectionStyle — identity for the original values', () => {
    it('a background-less section is exactly what it always was', () => {
        const { className, style } = resolveSectionStyle({ style: { padding: 4, gap: 3 } });
        expect(className).toBe('app-grid');
        expect(style).toEqual({
            gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
            gap: spaceSteps(3),
            padding: spaceSteps(4),
        });
    });

    it("'surface' emits exactly the pre-look-pass pair — no class, no shadow", () => {
        const { className, style } = resolveSectionStyle({ style: { background: 'surface' } });
        expect(className).toBe('app-grid'); // NOT app-surface — that is panel's
        expect(style.background).toBe('var(--bg-card)');
        expect(style.borderRadius).toBe('var(--app-radius)');
        expect(style.boxShadow).toBeUndefined();
    });

    it("'tint' likewise", () => {
        const { className, style } = resolveSectionStyle({ style: { background: 'tint' } });
        expect(className).toBe('app-grid');
        expect(style.background).toBe('var(--app-primary-soft)');
        expect(style.borderRadius).toBe('var(--app-radius)');
        expect(style.boxShadow).toBeUndefined();
    });

    it('an unknown background paints nothing at all', () => {
        const { className, style } = resolveSectionStyle({ style: { background: 'mesh' } });
        expect(className).toBe('app-grid');
        expect(style.background).toBeUndefined();
        expect(style.borderRadius).toBeUndefined();
        expect(style.boxShadow).toBeUndefined();
    });
});

describe('resolveSectionStyle — panel and gradient bands', () => {
    it("'panel' is the elevated card band: surface + hairline class + elevation + radius", () => {
        const { className, style } = resolveSectionStyle({ style: { background: 'panel' } });
        expect(className).toBe('app-grid app-surface');
        expect(style.background).toBe('var(--bg-card)');
        expect(style.borderRadius).toBe('var(--app-radius)');
        // Semantic elevation — app-tokens.css turns this into a ring in high
        // contrast; the fallback keeps the declaration valid outside the shell.
        expect(style.boxShadow).toBe('var(--app-shadow-1, none)');
    });

    it("'panel' composes with height:'fill' (both classes survive)", () => {
        const { className } = resolveSectionStyle({ style: { background: 'panel', height: 'fill' } });
        expect(className).toContain('app-grid');
        expect(className).toContain('app-section-fill');
        expect(className).toContain('app-surface');
    });

    it("'gradient' is a borderless soft wash — no surface class, no shadow", () => {
        const { className, style } = resolveSectionStyle({ style: { background: 'gradient' } });
        expect(className).toBe('app-grid');
        expect(style.background).toBe(SOFT_PRIMARY_GRADIENT);
        expect(style.borderRadius).toBe('var(--app-radius)');
        expect(style.boxShadow).toBeUndefined();
    });
});

describe('resolveNodeStyle — the same knob on a component node', () => {
    it("identity: 'surface' keeps its exact class pair and gains nothing", () => {
        const { className, style } = resolveNodeStyle({ style: { background: 'surface' } });
        // app-span-12 is the no-span default: the tablet tier addresses cells
        // by their authored width, and a cell with no span is a full row.
        expect(className).toBe('app-node min-w-0 app-span-12 app-surface');
        expect(style.background).toBe('var(--bg-card)');
        expect(style.boxShadow).toBeUndefined();
        expect(style.borderRadius).toBeUndefined(); // radius stays knob-driven
    });

    it('identity: no background, no classes beyond the base pair', () => {
        const { className, style } = resolveNodeStyle({ style: {} });
        expect(className).toBe('app-node min-w-0 app-span-12');
        expect(style.background).toBeUndefined();
        expect(style.boxShadow).toBeUndefined();
    });

    it("'panel' node: surface + hairline class + elevation + default theme radius", () => {
        const { className, style } = resolveNodeStyle({ style: { background: 'panel' } });
        expect(className).toBe('app-node min-w-0 app-span-12 app-surface');
        expect(style.background).toBe('var(--bg-card)');
        expect(style.boxShadow).toBe('var(--app-shadow-1, none)');
        expect(style.borderRadius).toBe('var(--app-radius)');
    });

    it("the author's radius knob beats panel's default radius", () => {
        const { style } = resolveNodeStyle({ style: { background: 'panel', radius: 'lg' } });
        expect(style.borderRadius).toBe('12px');
    });

    it("'gradient' node: the wash, theme radius, and no surface treatment", () => {
        const { className, style } = resolveNodeStyle({ style: { background: 'gradient' } });
        expect(className).toBe('app-node min-w-0 app-span-12');
        expect(style.background).toBe(SOFT_PRIMARY_GRADIENT);
        expect(style.boxShadow).toBeUndefined();
        expect(style.borderRadius).toBe('var(--app-radius)');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Advanced sizing — widthMode/widthValue, heightMode/heightValue.
//
// Two rules carry the whole feature:
//   (a) the GRID owns PLACEMENT, the value owns the BOX. An explicit width
//       never touches gridColumn — `span` still decides which columns the cell
//       occupies, the width sizes the element inside it.
//   (b) the MOBILE STACK KEEPS WINNING. Every emitted width is paired with
//       max-width:100%, and runtime.css re-asserts that with !important below
//       640px, so a 900px block on a 390px phone can never push a horizontal
//       scrollbar across the app.
// ═══════════════════════════════════════════════════════════════════════════

describe('advanced sizing — IDENTITY for definitions that never used it', () => {
    // Every knob shape the old vocabulary could produce. If any of these grows
    // a key, every stored app changes how it renders.
    const LEGACY_STYLES = [
        {},
        { span: 12 },
        { span: 4, align: 'center', color: 'primary', weight: 'medium', size: 'lg' },
        { span: 6, height: 'auto' },
        { span: 6, height: 'sm' },
        { span: 6, height: 'md' },
        { span: 6, height: 'lg' },
        { span: 6, height: 'xl' },
        { span: 6, height: 'fill' },
        { span: 3, padding: 2, gap: 4, radius: 'lg', background: 'panel', border: 'subtle' },
        { padding: 4, gap: 3, background: 'none' },
        { padding: 4, gap: 3, background: 'panel', height: 'fill' },
    ];

    it('resolveNodeStyle is byte-identical without the new knobs', () => {
        for (const style of LEGACY_STYLES) {
            const plain = resolveNodeStyle({ style });
            // Explicitly-defaulted modes must be indistinguishable from absent.
            const defaulted = resolveNodeStyle({ style: { ...style, widthMode: 'span', heightMode: 'preset' } });
            expect(JSON.stringify(defaulted)).toBe(JSON.stringify(plain));
            expect(plain.style.width).toBeUndefined();
            expect(plain.style.maxWidth).toBeUndefined();
        }
    });

    it('resolveSectionStyle is byte-identical without the new knobs', () => {
        for (const style of LEGACY_STYLES) {
            const plain = resolveSectionStyle({ style });
            const defaulted = resolveSectionStyle({ style: { ...style, heightMode: 'preset' } });
            expect(JSON.stringify(defaulted)).toBe(JSON.stringify(plain));
        }
    });

    it('a defaulted mode carrying a stale value still emits nothing', () => {
        // The server rejects this pairing, but an old/hand-edited definition can
        // carry it and it must degrade to "the grid decides", never to a guess.
        expect(resolveWidthCss({ widthMode: 'span', widthValue: 900 })).toBeNull();
        expect(resolveHeightCss({ heightMode: 'preset', heightValue: 400 })).toBeNull();
        expect(resolveWidthCss({ widthValue: 900 })).toBeNull();
        expect(resolveWidthCss(undefined)).toBeNull();
        // A mode with no number is not a size either.
        expect(resolveWidthCss({ widthMode: 'px' })).toBeNull();
        expect(resolveHeightCss({ heightMode: 'vh', heightValue: null })).toBeNull();
    });
});

describe('advanced sizing — per-mode CSS', () => {
    it('widthMode px/pct produce the unit the author asked for', () => {
        expect(resolveWidthCss({ widthMode: 'px', widthValue: 320 })).toBe('320px');
        expect(resolveWidthCss({ widthMode: 'pct', widthValue: 60 })).toBe('60%');
        expect(resolveWidthCss({ widthMode: 'px', widthValue: 320.6 })).toBe('321px');
    });

    it('heightMode px/pct/vh produce the unit the author asked for', () => {
        expect(resolveHeightCss({ heightMode: 'px', heightValue: 440 })).toBe('440px');
        expect(resolveHeightCss({ heightMode: 'pct', heightValue: 50 })).toBe('50%');
        expect(resolveHeightCss({ heightMode: 'vh', heightValue: 80 })).toBe('80vh');
    });

    it('RULE (a): an explicit width sizes the box, the span still places the cell', () => {
        const { style } = resolveNodeStyle({ style: { span: 4, widthMode: 'px', widthValue: 280 } });
        // The cell is exactly where span put it...
        expect(style.gridColumn).toBe('span 4 / span 4');
        expect(style.gridColumn).toBe(resolveNodeStyle({ style: { span: 4 } }).style.gridColumn);
        // ...and the width lands on the box inside it.
        expect(style.width).toBe('280px');
    });

    it('RULE (a): a pct width is a percentage of the cell its span reserved', () => {
        for (const span of [1, 4, 12]) {
            const { style } = resolveNodeStyle({ style: { span, widthMode: 'pct', widthValue: 50 } });
            expect(style.gridColumn).toBe(`span ${span} / span ${span}`);
            expect(style.width).toBe('50%');
        }
    });

    it('an explicit height outranks the preset and scrolls rather than clips', () => {
        const { style } = resolveNodeStyle({ style: { height: 'sm', heightMode: 'px', heightValue: 640 } });
        expect(style.height).toBe('640px');
        expect(style.overflow).toBe('auto');
        expect(style.minHeight).toBe(0);
        // ...including over 'fill', whose flex rules must not also apply.
        const filled = resolveNodeStyle({ style: { height: 'fill', heightMode: 'vh', heightValue: 60 } });
        expect(filled.style.height).toBe('60vh');
        expect(filled.style.flexGrow).toBeUndefined();
        expect(isFill({ style: { height: 'fill', heightMode: 'vh', heightValue: 60 } })).toBe(false);
        // A plain fill node is untouched.
        expect(isFill({ style: { height: 'fill' } })).toBe(true);
    });

    it('a section takes px/vh — and never pct, which has nothing to measure', () => {
        const px = resolveSectionStyle({ style: { heightMode: 'px', heightValue: 600 } });
        expect(px.style.height).toBe('600px');
        expect(px.style.overflow).toBe('auto');
        expect(resolveSectionStyle({ style: { heightMode: 'vh', heightValue: 90 } }).style.height).toBe('90vh');

        // pct on a section resolves against the screen's flowing height, i.e.
        // nothing. The server rejects it; the resolver refuses to emit a
        // declaration that would do nothing.
        expect(resolveSectionHeightCss({ heightMode: 'pct', heightValue: 50 })).toBeNull();
        const pct = resolveSectionStyle({ style: { heightMode: 'pct', heightValue: 50 } });
        expect(pct.style.height).toBeUndefined();
        expect(pct.className).toBe('app-grid');
    });
});

const RUNTIME_DIR = resolve(process.cwd(), 'src/components/admin/Studio/AppStudio/runtime');

describe('advanced sizing — RULE (b): the mobile stack keeps winning', () => {
    it('every width the resolver emits is paired with max-width:100%', () => {
        // The invariant, over the whole legal range rather than one example —
        // this is the single thing standing between a wide block and a
        // horizontal scrollbar across the entire app.
        for (const [mode, value] of [['px', 40], ['px', 900], ['px', 2000], ['pct', 5], ['pct', 100]]) {
            const { style } = resolveNodeStyle({ style: { span: 12, widthMode: mode, widthValue: value } });
            expect(style.width).toBeTruthy();
            expect(style.maxWidth).toBe('100%');
        }
        // applyWidth is the only door in, and it cannot be walked through
        // without the cap.
        const out = {};
        applyWidth({ widthMode: 'px', widthValue: 900 }, out);
        expect(out).toEqual({ width: '900px', maxWidth: '100%' });
        const noop = {};
        applyWidth({ widthMode: 'span', widthValue: 900 }, noop);
        expect(noop).toEqual({});
    });

    it('a 900px block on a 390px phone caps at the cell, it does not overflow it', () => {
        // 900 > 390: the inline width alone would overflow. max-width:100% is
        // relative to the grid cell, which below 640px is the full (single)
        // column — so the painted box can never exceed the viewport.
        const { style } = resolveNodeStyle({ style: { span: 12, widthMode: 'px', widthValue: 900 } });
        expect(style.width).toBe('900px');
        expect(style.maxWidth).toBe('100%');
    });

    it('runtime.css re-asserts the cap with the authority inline styles cannot outrank', () => {
        // An inline width beats any stylesheet declaration WITHOUT !important,
        // so the resolver's pairing is necessary but not sufficient — the
        // sub-640px block has to carry the cap too, next to the grid-column
        // override that makes the layout stack in the first place.
        // The stylesheet as TEXT: rule (b) lives half in the resolver and half
        // in the cascade, and jsdom applies no stylesheet at all — so the CSS
        // half has to be asserted on the source.
        const runtimeCss = readFileSync(resolve(RUNTIME_DIR, 'runtime.css'), 'utf8');
        const mobile = runtimeCss.slice(runtimeCss.indexOf('@media (max-width: 639.98px)'));
        expect(mobile).toContain('@media (max-width: 639.98px)');
        const nodeRule = mobile.slice(mobile.indexOf('.app-grid > .app-node'));
        const body = nodeRule.slice(0, nodeRule.indexOf('}'));
        expect(body).toMatch(/grid-column:\s*1 \/ -1\s*!important/);
        expect(body).toMatch(/max-width:\s*100%\s*!important/);
    });
});

/**
 * Responsive visibility — hideBelow/hideAbove ride along as CLASSES (only a
 * stylesheet can read the viewport), and the media rules live in runtime.css.
 * jsdom applies no stylesheet, so like the mobile-cap test above the CSS half
 * is asserted on the source text.
 */
describe('responsive visibility — hideBelow/hideAbove', () => {
    it('identity: without the knobs the className is byte-identical', () => {
        expect(resolveNodeStyle({ style: {} }).className).toBe('app-node min-w-0 app-span-12');
        expect(resolveNodeStyle({ style: { hideBelow: 'none' } }).className).toBe('app-node min-w-0 app-span-12');
    });

    it('emits one class per set knob, beside the span class', () => {
        expect(resolveNodeStyle({ style: { span: 4, hideBelow: 'md' } }).className)
            .toBe('app-node min-w-0 app-span-4 app-hide-below-md');
        const both = resolveNodeStyle({ style: { hideBelow: 'sm', hideAbove: 'lg' } }).className;
        expect(both).toContain('app-hide-below-sm');
        expect(both).toContain('app-hide-above-lg');
    });

    it('an unknown band emits nothing — an older client shows the node rather than mis-hiding it', () => {
        expect(resolveNodeStyle({ style: { hideBelow: 'xxl', hideAbove: 42 } }).className)
            .toBe('app-node min-w-0 app-span-12');
    });

    it('runtime.css hides each class in its band, and never inside the edit canvas', () => {
        const css = readFileSync(resolve(RUNTIME_DIR, 'runtime.css'), 'utf8');
        // The media line directly governing a class's hide rule.
        const mediaOf = (cls) => {
            const i = css.indexOf(`.${cls}:not([data-app-edit] *) { display: none !important; }`);
            expect(i, `${cls} rule present, edit-canvas-guarded`).toBeGreaterThan(-1);
            const start = css.slice(0, i).lastIndexOf('@media');
            const nl = String.fromCharCode(10); // no escape: the heredoc tooling mangles backslashes
            return css.slice(start, css.indexOf(nl, start));
        };
        // hideBelow 'md' = hidden NARROWER than 1024px; hideAbove 'md' = hidden
        // at 1024px and wider. Bands are the runtime.css breakpoints.
        expect(mediaOf('app-hide-below-sm')).toContain('(max-width: 639.98px)');
        expect(mediaOf('app-hide-below-md')).toContain('(max-width: 1023.98px)');
        expect(mediaOf('app-hide-below-lg')).toContain('(max-width: 1279.98px)');
        expect(mediaOf('app-hide-above-sm')).toContain('(min-width: 640px)');
        expect(mediaOf('app-hide-above-md')).toContain('(min-width: 1024px)');
        expect(mediaOf('app-hide-above-lg')).toContain('(min-width: 1280px)');
    });
});
