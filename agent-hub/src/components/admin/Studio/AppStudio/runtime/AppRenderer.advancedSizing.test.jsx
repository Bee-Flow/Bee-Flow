import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AppRenderer from './AppRenderer';

/**
 * Advanced sizing, walked through the REAL renderer at a phone width.
 *
 * The two rules this file exists to defend:
 *
 *   (a) The grid owns PLACEMENT, the value owns the BOX. `widthMode:'px'`
 *       never rewrites `gridColumn` — the cell is still exactly where `span`
 *       put it, and the width applies to the element inside that cell. The
 *       alternative (collapsing the cell to fit the box) makes two px-sized
 *       siblings reflow unpredictably and makes the column slider look broken.
 *
 *   (b) The mobile stack keeps winning. A 900px block on a 390px phone must
 *       cap at the viewport, never push a horizontal scrollbar across the whole
 *       app. Two mechanisms, and the test asserts both because either alone is
 *       a single point of failure: the resolver pairs every width it emits with
 *       max-width:100% (inline, visible in the DOM below), and runtime.css
 *       re-asserts it with !important under 640px — the only authority that
 *       beats an inline declaration.
 *
 * jsdom does no layout and applies no stylesheet, so "no horizontal scrollbar"
 * cannot be measured here. What CAN be pinned is the thing a layout engine
 * would act on: every element carrying a hard width also carries the cap.
 */

const PHONE_WIDTH = 390;
const RUNTIME_DIR = resolve(process.cwd(), 'src/components/admin/Studio/AppStudio/runtime');

const node = (id, style) => ({
    id, type: 'card', props: { title: id }, style, children: [],
});

function definitionWith(children) {
    return {
        schemaVersion: 2,
        meta: { name: 'Sizing' },
        theme: {},
        homeScreenId: 'scr_1',
        screens: [{
            id: 'scr_1',
            name: 'One',
            showInNav: true,
            maxWidth: 'full',
            sections: [{ id: 'sec_1', style: { padding: 4, gap: 3, background: 'none' }, children }],
        }],
        actions: {},
    };
}

const renderApp = (children) => render(
    <AppRenderer definition={definitionWith(children)} screenId="scr_1" mode="run" />,
);

describe('advanced sizing at a 390px viewport', () => {
    let originalWidth;

    beforeEach(() => {
        originalWidth = window.innerWidth;
        window.innerWidth = PHONE_WIDTH;
        window.dispatchEvent(new Event('resize'));
    });

    afterEach(() => {
        window.innerWidth = originalWidth;
        window.dispatchEvent(new Event('resize'));
    });

    it('a 900px block is capped at its cell rather than overflowing the phone', () => {
        const { container } = renderApp([
            node('cmp_wide', { span: 12, widthMode: 'px', widthValue: 900 }),
        ]);
        const cell = container.querySelector('.app-node');
        expect(cell).toBeTruthy();
        // 900 > 390 — without the cap this is the element that would push the
        // scrollbar. The cap is relative to the grid cell, which below 640px is
        // the full single column, so the painted box cannot exceed the viewport.
        expect(cell.style.width).toBe('900px');
        expect(cell.style.maxWidth).toBe('100%');
    });

    it('EVERY node with a hard width carries the cap — no exceptions on the page', () => {
        const { container } = renderApp([
            node('cmp_a', { span: 12, widthMode: 'px', widthValue: 1600 }),
            node('cmp_b', { span: 6, widthMode: 'pct', widthValue: 100 }),
            node('cmp_c', { span: 4, widthMode: 'px', widthValue: 40 }),
            node('cmp_d', { span: 3 }),                                   // no advanced sizing
            node('cmp_e', { span: 12, heightMode: 'vh', heightValue: 60 }), // height only
        ]);
        const cells = [...container.querySelectorAll('.app-node')];
        expect(cells).toHaveLength(5);
        for (const cell of cells) {
            if (!cell.style.width) continue;
            expect(cell.style.maxWidth, `${cell.textContent} has a width but no cap`).toBe('100%');
        }
        // ...and a block that never asked for a width gains neither key, so a
        // definition from before this feature renders exactly as it did.
        const plain = cells[3];
        expect(plain.style.width).toBe('');
        expect(plain.style.maxWidth).toBe('');
    });

    it('RULE (a): the cell stays where span put it, at any viewport', () => {
        const { container } = renderApp([
            node('cmp_narrow', { span: 4, widthMode: 'px', widthValue: 900 }),
        ]);
        const cell = container.querySelector('.app-node');
        // Placement is untouched by the width. Below 640px runtime.css
        // overrides this to 1 / -1 with !important — the stacking rule the
        // stylesheet has always owned, which the width does not interfere with.
        expect(cell.style.gridColumn).toBe('span 4 / span 4');
    });

    it('the stylesheet keeps the last word below 640px', () => {
        const css = readFileSync(resolve(RUNTIME_DIR, 'runtime.css'), 'utf8');
        const mobile = css.slice(css.indexOf('@media (max-width: 639.98px)'));
        const rule = mobile.slice(mobile.indexOf('.app-grid > .app-node'));
        const body = rule.slice(0, rule.indexOf('}'));
        // Stacking and capping, both !important, in the same rule — an inline
        // width cannot outrank either.
        expect(body).toMatch(/grid-column:\s*1 \/ -1\s*!important/);
        expect(body).toMatch(/max-width:\s*100%\s*!important/);
    });

    it('an explicit height scrolls its own content instead of clipping it', () => {
        const { container } = renderApp([
            node('cmp_tall', { span: 12, heightMode: 'px', heightValue: 400 }),
        ]);
        const cell = container.querySelector('.app-node');
        expect(cell.style.height).toBe('400px');
        expect(cell.style.overflow).toBe('auto');
    });
});

describe('a horizontal pane on a phone', () => {
    // The grid stacks below 640px and .app-fill unwinds, but a pane is flex and
    // had no rule at all — so the one layout that CAN express "fixed sidebar
    // plus remainder" was also the one that survived onto a 390px screen with
    // the rail still 280px wide, squeezing the thing it exists to navigate.
    const mobileBlock = () => {
        const css = readFileSync(resolve(RUNTIME_DIR, 'runtime.css'), 'utf8');
        return css.slice(css.indexOf('@media (max-width: 639.98px)'));
    };

    it('stacks instead of staying side by side', () => {
        const mobile = mobileBlock();
        const rule = mobile.slice(mobile.indexOf("[data-app-pane='horizontal']"));
        expect(rule).toMatch(/flex-direction:\s*column/);
    });

    it('releases the exact width the advanced knob wrote inline', () => {
        // The knob emits an inline width, and inline beats a stylesheet without
        // !important — so this rule is inert unless it carries one.
        const mobile = mobileBlock();
        const rule = mobile.slice(mobile.indexOf("[data-app-pane='horizontal'] > .app-node"));
        expect(rule.slice(0, 160)).toMatch(/width:\s*auto\s*!important/);
    });

    it('the hook it keys off is one AppPane actually emits', () => {
        const pane = readFileSync(resolve(RUNTIME_DIR, 'components/AppPane.jsx'), 'utf8');
        expect(pane).toContain("data-app-pane={horizontal ? 'horizontal' : 'vertical'}");
    });
});

/**
 * The middle tier — the band between a phone and a full desktop, which for a
 * long time had no rules at all. Every span was literal from 640px upward, so
 * a quarter-width column on an 800px laptop was 180px of squeezed text.
 *
 * jsdom applies no stylesheet, so what is asserted here is the CONTRACT
 * between the two halves: the resolver emits a class per span, and the
 * stylesheet addresses every class it emits. Either half alone is inert, and
 * the failure is silent — a span nobody wrote a rule for just stays literal.
 */
describe('the tablet tier', () => {
    const tabletBlock = () => {
        const css = readFileSync(resolve(RUNTIME_DIR, 'runtime.css'), 'utf8');
        const start = css.indexOf('@media (min-width: 640px) and (max-width: 1023.98px)');
        expect(start).toBeGreaterThan(-1);
        return css.slice(start, css.indexOf('@media (max-width: 639.98px)'));
    };

    it('every cell says how wide it was authored', () => {
        const { container } = renderApp([
            node('cmp_quarter', { span: 3 }),
            node('cmp_half', { span: 6 }),
        ]);
        const cells = [...container.querySelectorAll('.app-node')];
        expect(cells[0].className).toContain('app-span-3');
        expect(cells[1].className).toContain('app-span-6');
    });

    it('a span the author never set is a full row, not an unaddressed class', () => {
        const { container } = renderApp([node('cmp_bare', {})]);
        expect(container.querySelector('.app-node').className).toContain('app-span-12');
    });

    it('quarters and thirds become halves', () => {
        const block = tabletBlock();
        const rule = block.slice(block.indexOf('.app-span-1'));
        const body = rule.slice(0, rule.indexOf('}'));
        for (const n of [1, 2, 3, 4]) expect(body).toContain(`.app-span-${n}`);
        expect(body).toMatch(/grid-column:\s*span 6 \/ span 6\s*!important/);
    });

    it('anything already half a row or wider takes the whole row', () => {
        const block = tabletBlock();
        const rule = block.slice(block.indexOf('.app-span-5'));
        const body = rule.slice(0, rule.indexOf('}'));
        for (const n of [5, 6, 7, 8, 9, 10, 11]) expect(body).toContain(`.app-span-${n}`);
        expect(body).toMatch(/grid-column:\s*1 \/ -1\s*!important/);
    });

    it('addresses every span the resolver can emit', () => {
        const block = tabletBlock();
        // 12 is already a full row and needs no rule; every other value must
        // appear, or that one width silently keeps its desktop proportions.
        // The terminator matters: `.app-span-1` is a prefix of `.app-span-11`,
        // so a bare substring check would pass on a rule that never mentions 1.
        for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
            expect(block).toMatch(new RegExp(`\\.app-grid > \\.app-span-${n}\\s*[,{]`));
        }
    });

    it('a pane takes the whole row rather than half of one', () => {
        const block = tabletBlock();
        const rule = block.slice(block.indexOf("[data-app-type='pane']"));
        expect(rule.slice(0, 120)).toMatch(/grid-column:\s*1 \/ -1\s*!important/);
    });

    it('the pane rule outranks the halving rule it has to beat', () => {
        // Both carry !important, so SPECIFICITY decides: class+class+attribute
        // beats class+class. Written down because the two rules live apart and
        // reordering them would look harmless.
        const block = tabletBlock();
        expect(block.indexOf('.app-span-1')).toBeLessThan(block.indexOf("[data-app-type='pane']"));
    });

    it('the type it keys off is one both node wrappers emit', () => {
        // Run mode and the editor canvas use different wrappers; a rule keyed
        // to an attribute only one of them writes is a layout that changes the
        // moment you press Preview.
        for (const file of ['AppRenderer.jsx', '../editor/EditorNodeWrapper.jsx']) {
            expect(readFileSync(resolve(RUNTIME_DIR, file), 'utf8')).toContain('data-app-type={node.type}');
        }
    });

    it('caps an inline px width the same way the phone rule does', () => {
        const block = tabletBlock();
        // Anchored on the bare selector: `.app-grid > .app-node` is also the
        // prefix of the pane rule above it.
        const rule = block.slice(block.indexOf('.app-grid > .app-node {'));
        expect(rule.slice(0, 120)).toMatch(/max-width:\s*100%\s*!important/);
    });
});
