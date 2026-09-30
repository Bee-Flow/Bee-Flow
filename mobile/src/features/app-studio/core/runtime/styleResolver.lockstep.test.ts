/**
 * Differential lockstep: core/runtime/styleResolver against the web's
 * runtime/styleResolver.js.
 *
 * The port returns descriptors, the web returns CSS. `webCss` below rebuilds
 * the web's { className, style } from a descriptor using the web's own
 * primitives (spaceSteps, spanGridColumn, ROLE_COLORS, …); if the descriptor
 * decided anything differently, the rebuilt CSS differs from what the web
 * produced for the same knobs.
 */

import * as port from './styleResolver';
import { allFixtures, seededRandom } from '../testing/fixtures';
import { loadWeb } from '../testing/loadWeb';

type AnyFn = (...args: unknown[]) => unknown;
type Css = Record<string, unknown>;
const W = loadWeb<Record<string, unknown> & { ROLE_COLORS: Record<string, string> }>('runtime/styleResolver.js');
const call = (name: string, ...args: unknown[]) => (W[name] as AnyFn)(...args);

const colorCss = (ref: port.ColorRef) => ('hex' in ref ? ref.hex : W.ROLE_COLORS[ref.role]);
const sizeCss = (spec: port.SizeSpec) => (spec.unit === 'pct' ? `${spec.value}%` : `${spec.value}${spec.unit}`);

function heightCss(rule: port.HeightRule, style: Css, node: boolean): void {
    if (!rule) return;
    if ('explicit' in rule) Object.assign(style, { height: sizeCss(rule.explicit), minHeight: 0, overflow: 'auto' });
    else if ('fill' in rule) Object.assign(style, W.FLEX_FILL, { minHeight: 0 }, node ? { minWidth: 0 } : { gridTemplateRows: 'minmax(0, 1fr)' });
    else Object.assign(style, { height: `${rule.presetPx}px`, overflow: 'auto' });
}

function backgroundCss(kind: port.Background | null): string | null {
    if (kind === 'surface' || kind === 'panel') return 'var(--bg-card)';
    if (kind === 'tint') return 'var(--app-primary-soft)';
    if (kind === 'gradient') return W.SOFT_PRIMARY_GRADIENT as string;
    return null;
}

function webNodeCss(l: port.NodeLayout): { className: string; style: Css } {
    const style: Css = { gridColumn: call('spanGridColumn', l.span) };
    if (l.width) Object.assign(style, { width: sizeCss(l.width), maxWidth: '100%' });
    if (l.align) style.textAlign = l.align;
    if (l.fontWeight) style.fontWeight = l.fontWeight;
    if (l.fontScale) style.fontSize = `${l.fontScale}em`;
    heightCss(l.height, style, true);
    if (l.color) style.color = colorCss(l.color);
    if (l.radius) style.borderRadius = 'px' in l.radius ? `${l.radius.px}px` : 'var(--app-radius)';
    if (l.paddingSteps) style.padding = call('spaceSteps', l.paddingSteps);
    const bg = backgroundCss(l.background);
    if (bg) style.background = bg;
    if (l.elevated) style.boxShadow = 'var(--app-shadow-1, none)';
    if (l.roundByBackground) style.borderRadius = 'var(--app-radius)';
    if (l.border) style.border = call('resolveBorder', l.border);
    const hide = (l.hideBelow ? ` app-hide-below-${l.hideBelow}` : '') + (l.hideAbove ? ` app-hide-above-${l.hideAbove}` : '');
    return { className: `app-node min-w-0 app-span-${l.span}${hide}${l.surface ? ' app-surface' : ''}`, style };
}

function webSectionCss(l: port.SectionLayout): { className: string; style: Css } {
    const style: Css = {
        gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
        gap: call('spaceSteps', l.gapSteps),
        padding: call('spaceSteps', l.paddingSteps),
    };
    heightCss(l.height, style, false);
    const bg = backgroundCss(l.background);
    if (bg) style.background = bg;
    if (l.rounded) style.borderRadius = 'var(--app-radius)';
    if (l.elevated) style.boxShadow = 'var(--app-shadow-1, none)';
    const fill = l.height && 'fill' in l.height ? ' app-section-fill' : '';
    return { className: `app-grid${fill}${l.surface ? ' app-surface' : ''}`, style };
}

const KNOBS: Record<string, unknown[]> = {
    span: [undefined, 0, 1, 4, 12, 13, 6.5, '4', NaN],
    align: [undefined, 'start', 'center', 'end', 'middle'],
    weight: [undefined, 'regular', 'medium', 'semibold', 'bold'],
    size: [undefined, 'sm', 'md', 'lg', 'xl'],
    height: [undefined, 'auto', 'fill', 'sm', 'md', 'lg', 'xl', 'huge'],
    heightMode: [undefined, 'preset', 'px', 'pct', 'vh', 'em'],
    heightValue: [undefined, 400, 33.4, 'x'],
    widthMode: [undefined, 'span', 'px', 'pct'],
    widthValue: [undefined, 900, 50.6, null],
    color: [undefined, null, 'primary', 'neutral', 'success', 'warning', 'danger', 'info', '#12ab34', '#fff', 'red'],
    radius: [undefined, null, 'none', 'sm', 'md', 'lg', 'full', 'huge'],
    padding: [undefined, 0, 2, -1, 3.5, '2'],
    gap: [undefined, 0, 1, 5, '2'],
    background: [undefined, 'none', 'surface', 'tint', 'panel', 'gradient', 'neon'],
    border: [undefined, 'none', 'default', 'subtle', 'thick'],
    hideBelow: [undefined, 'none', 'sm', 'md', 'lg', 'xl'],
    hideAbove: [undefined, 'sm', 'lg'],
};

function styles(): Css[] {
    const out: Css[] = [{}];
    for (const [knob, values] of Object.entries(KNOBS)) for (const v of values) out.push({ [knob]: v });
    const rnd = seededRandom(42);
    for (let i = 0; i < 400; i++) {
        const style: Css = {};
        for (const [knob, values] of Object.entries(KNOBS)) {
            if (rnd() < 0.5) style[knob] = values[Math.floor(rnd() * values.length)];
        }
        out.push(style);
    }
    for (const def of Object.values(allFixtures())) {
        for (const screen of def.screens || []) {
            for (const section of screen.sections || []) {
                out.push(section.style || {});
                for (const node of section.children || []) out.push(node.style || {});
            }
        }
    }
    return out;
}

describe('styleResolver agrees with the web', () => {
    const all = styles();

    it('decides every node style the same way', () => {
        for (const style of all) {
            const node = { style };
            expect({ style, css: webNodeCss(port.resolveNodeLayout(node)) }).toEqual({ style, css: call('resolveNodeStyle', node) });
            expect(port.isFill(node)).toBe(call('isFill', node));
        }
        expect(webNodeCss(port.resolveNodeLayout(null))).toEqual(call('resolveNodeStyle', null));
    });

    it('decides every section style the same way', () => {
        for (const style of all) {
            const section = { style };
            expect({ style, css: webSectionCss(port.resolveSectionLayout(section)) }).toEqual({ style, css: call('resolveSectionStyle', section) });
        }
    });

    it('agrees on the small helpers', () => {
        for (const v of KNOBS.span as unknown[]) expect(port.clampSpan(v)).toBe(call('clampSpan', v));
        for (const v of KNOBS.height as unknown[]) {
            const px = port.resolveHeight(v);
            expect(px === null ? null : `${px}px`).toBe(call('resolveHeight', v));
        }
        for (const tone of ['primary', 'neutral', 'success', 'warning', 'danger', 'info', 'bogus', undefined]) {
            expect(port.roleFillContrast(tone)).toBe(call('roleFillContrast', tone));
            const { color, mixed } = port.roleText(tone);
            const css = colorCss(color);
            expect(mixed ? `color-mix(in srgb, ${css} 55%, var(--text-primary))` : css).toBe(call('roleTextColor', tone));
        }
        for (const [role, hex] of Object.entries(port.ROLE_HEX)) expect(W.ROLE_COLORS[role]).toBe(hex);
        expect(port.SPACE_STEP_PX).toBe(W.SPACE_STEP_PX);
    });

    it('picks the same growing row as fillRowTemplate', () => {
        const rnd = seededRandom(9);
        for (let i = 0; i < 300; i++) {
            const n = Math.floor(rnd() * 7);
            const children = Array.from({ length: n }, () => ({
                style: {
                    span: [undefined, 3, 4, 6, 8, 12, 20, 'x'][Math.floor(rnd() * 8)],
                    height: rnd() < 0.2 ? 'fill' : undefined,
                    heightMode: rnd() < 0.1 ? 'px' : undefined,
                    heightValue: 100,
                },
            }));
            const { rows, growRow } = port.fillRows({ children });
            const template = rows.length <= 1 ? 'minmax(0, 1fr)' : rows.map((_, r) => (r === growRow ? 'minmax(0, 1fr)' : 'auto')).join(' ');
            expect(template).toBe(call('fillRowTemplate', { children }));
        }
    });
});
