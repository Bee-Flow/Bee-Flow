import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AppCard from './components/AppCard';
import AppContainer from './components/AppContainer';
import AppTab from './components/AppTab';
import {
    GRID_CONTAINER_TYPES,
    effectiveSpan,
    fillRowTemplate,
    gridClasses,
    gridColumnStyle,
    gridColumns,
    resolveNodeStyle,
    resolveSectionStyle,
} from './styleResolver';
import type { StyleKnobs } from './styleResolver.types';
import type { NodeProps } from './components/appNode.types';
import type { ComponentType } from 'react';

const knobs = (style: Record<string, unknown>) => style as StyleKnobs;

describe('layout v2: a style without the knobs resolves as before', () => {
    it('adds no class and no inline declaration to a node', () => {
        const plain = resolveNodeStyle({ style: { span: 4 } });
        expect(plain.className).toBe('app-node min-w-0 app-span-4');
        expect(plain.style).toEqual({ gridColumn: 'span 4 / span 4' });
        // null is "not set" (the inspector commits it to clear a knob).
        const cleared = resolveNodeStyle({ style: knobs({ span: 4, spanMd: null, spanSm: null, rowSpan: null, alignSelf: null, sticky: null, stickyOffset: null }) });
        expect(cleared).toEqual(plain);
    });

    it('adds no class and keeps the 12-column template on a section and a grid container', () => {
        const section = resolveSectionStyle({ style: { padding: 4, gap: 3 }, children: [{ style: { span: 6 } }] });
        expect(section.className).toBe('app-grid');
        expect(section.style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
        expect(Object.keys(section.style)).toEqual(['gridTemplateColumns', 'gap', 'padding']);
        expect(gridClasses({ style: { gap: 3 }, children: [{ style: { span: 6 } }] })).toBe('');
        expect(gridColumnStyle({ gap: 3 })).toEqual({ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' });
        expect(gridColumnStyle(knobs({ columns: 12 }))).toEqual({ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))' });
        expect(gridClasses({ style: knobs({ columns: 12, responsive: 'auto' }) })).toBe('');
    });
});

describe('layout v2: placement knobs on a node', () => {
    it('emits the tablet and phone span as classes beside the desktop span', () => {
        const out = resolveNodeStyle({ style: knobs({ span: 3, spanMd: 4, spanSm: 6 }) });
        expect(out.className).toBe('app-node min-w-0 app-span-3 app-span-md-4 app-span-sm-6');
        expect(out.style).toEqual({ gridColumn: 'span 3 / span 3' });
    });

    it('writes rowSpan and alignSelf inline', () => {
        const out = resolveNodeStyle({ style: knobs({ span: 8, rowSpan: 2, alignSelf: 'center' }) });
        expect(out.style.gridRow).toBe('span 2 / span 2');
        expect(out.style.alignSelf).toBe('center');
        expect(out.className).toBe('app-node min-w-0 app-span-8 app-row-span');
        // One row is the grid's default: nothing is written for it.
        expect(resolveNodeStyle({ style: knobs({ rowSpan: 1 }) }).style.gridRow).toBeUndefined();
        expect(resolveNodeStyle({ style: knobs({ alignSelf: 'stretch' }) }).style.alignSelf).toBe('stretch');
    });

    it('marks a sticky node with a class and carries the offset as a custom property', () => {
        const top = resolveNodeStyle({ style: knobs({ span: 4, sticky: 'top', stickyOffset: 2 }) });
        expect(top.className).toBe('app-node min-w-0 app-span-4 app-sticky-top');
        expect((top.style as Record<string, unknown>)['--app-sticky-offset']).toBe('calc(8px * var(--app-space, 1))');
        const bottom = resolveNodeStyle({ style: knobs({ sticky: 'bottom' }) });
        expect(bottom.className).toContain(' app-sticky-bottom');
        expect(bottom.style).toEqual({ gridColumn: 'span 12 / span 12' });
        // The offset alone does nothing, and 'none' is not sticky.
        expect(resolveNodeStyle({ style: knobs({ sticky: 'none', stickyOffset: 3 }) })).toEqual(resolveNodeStyle({ style: {} }));
    });

    it('ignores values outside the vocabulary', () => {
        const out = resolveNodeStyle({ style: knobs({ spanMd: 0, spanSm: 13, rowSpan: 7, alignSelf: 'left', sticky: 'left' }) });
        expect(out).toEqual(resolveNodeStyle({ style: {} }));
    });
});

describe('layout v2: a grid with its own columns', () => {
    it('reads the column count, 12 for anything that is not 1..12', () => {
        expect(gridColumns(knobs({ columns: 5 }))).toBe(5);
        for (const bad of [undefined, null, 0, 13, 2.5, '5']) expect(gridColumns(knobs({ columns: bad }))).toBe(12);
    });

    it('a section with columns gets the template, the count and the manual class', () => {
        const out = resolveSectionStyle({ style: knobs({ padding: 4, gap: 3, columns: 5 }) });
        expect(out.className).toBe('app-grid app-cols-5 app-grid--manual');
        expect(out.style.gridTemplateColumns).toBe('repeat(5, minmax(0, 1fr))');
        expect((out.style as Record<string, unknown>)['--app-cols']).toBe(5);
    });

    it('responsive manual keeps 12 columns and only turns the tablet rule off', () => {
        const out = resolveSectionStyle({ style: knobs({ gap: 3, responsive: 'manual' }) });
        expect(out.className).toBe('app-grid app-grid--manual');
        expect(out.style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
        expect((out.style as Record<string, unknown>)['--app-cols']).toBeUndefined();
    });

    it('a grid keeps its columns on a phone exactly when a child sets spanSm', () => {
        const withSm = { style: { gap: 3 }, children: [{ style: { span: 6 } }, { style: knobs({ span: 6, spanSm: 6 }) }] };
        expect(resolveSectionStyle(withSm).className).toBe('app-grid app-grid--keep-sm');
        expect(gridClasses(withSm)).toBe(' app-grid--keep-sm');
        expect(gridClasses({ style: knobs({ columns: 4 }), children: [{ style: knobs({ spanSm: 2 }) }] })).toBe(' app-cols-4 app-grid--manual app-grid--keep-sm');
        // A grandchild's spanSm is its own grid's business.
        expect(gridClasses({ style: {}, children: [{ style: {}, children: [{ style: knobs({ spanSm: 6 }) }] } as never] })).toBe('');
    });

    it('counts the rows of a filling grid in its own columns', () => {
        const kids = [{ style: { span: 2 } }, { style: { span: 2 } }, { style: { span: 2 } }];
        // Three spans of 2 are one row of 12, and two rows of 4.
        expect(fillRowTemplate({ style: { height: 'fill' }, children: kids })).toBe('minmax(0, 1fr)');
        expect(fillRowTemplate({ style: knobs({ height: 'fill', columns: 4 }), children: kids })).toBe('auto minmax(0, 1fr)');
    });
});

describe('layout v2: the grid containers draw their inner grid with the knobs', () => {
    const cases: Array<[string, ComponentType<NodeProps>]> = [['card', AppCard], ['container', AppContainer], ['tab', AppTab]];

    it.each(cases)('%s: no knob keeps the grid element as it was, columns changes it', (type, Component) => {
        const child = <i data-testid="kid" />;
        const base = { id: 'cmp_a', type, props: {}, style: { gap: 3 }, children: [] };
        const plain = render(<Component node={base as never}>{child}</Component>);
        const plainGrid = plain.container.querySelector('.app-grid') as HTMLElement;
        expect(plainGrid.className.split(' ').filter((c) => c.startsWith('app-'))).toEqual(['app-grid']);
        expect(plainGrid.style.gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
        expect(plainGrid.style.getPropertyValue('--app-cols')).toBe('');
        plain.unmount();

        const node = { ...base, style: { gap: 3, columns: 3 }, children: [{ id: 'cmp_b', type: 'heading', style: { spanSm: 1 } }] };
        const { container } = render(<Component node={node as never}>{child}</Component>);
        const grid = container.querySelector('.app-grid') as HTMLElement;
        expect(grid.classList.contains('app-cols-3')).toBe(true);
        expect(grid.classList.contains('app-grid--manual')).toBe(true);
        expect(grid.classList.contains('app-grid--keep-sm')).toBe(true);
        expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
        expect(grid.style.getPropertyValue('--app-cols')).toBe('3');
    });

    it('names the six container types that have a column grid', () => {
        expect([...GRID_CONTAINER_TYPES].sort()).toEqual(['card', 'container', 'form', 'modal', 'repeater', 'tab']);
    });
});

/**
 * effectiveSpan is the stylesheet's decision written as a function (the editor canvas shows
 * the tablet and phone arrangement with it). Each case names the rule of css/layout.css it
 * stands for.
 */
describe('layout v2: the span a node has at each screen size', () => {
    const auto = { isGrid: true, style: { gap: 3 } };
    const manual = { isGrid: true, style: knobs({ responsive: 'manual' }) };
    const five = { isGrid: true, style: knobs({ columns: 5 }) };
    const node = (style: Record<string, unknown>, type = 'card') => ({ type, style: knobs(style) });

    it('desktop: the span, and the full row at or above the column count', () => {
        expect(effectiveSpan('lg', node({ span: 3 }), auto)).toBe(3);
        expect(effectiveSpan('lg', node({}), auto)).toBe('full');
        expect(effectiveSpan('lg', node({ span: 3 }), five)).toBe(3);
        expect(effectiveSpan('lg', node({ span: 5 }), five)).toBe('full');
        expect(effectiveSpan('lg', node({ span: 12 }), five)).toBe('full');
    });

    it('tablet, automatic grid: quarters and thirds become halves, wider takes the row', () => {
        for (const span of [1, 2, 3, 4]) expect(effectiveSpan('md', node({ span }), auto)).toBe(6);
        for (const span of [5, 6, 8, 11, 12]) expect(effectiveSpan('md', node({ span }), auto)).toBe('full');
    });

    it('tablet, automatic grid: a pane rail keeps a third and its partner the rest', () => {
        expect(effectiveSpan('md', node({ span: 3 }, 'pane'), auto)).toBe(4);
        expect(effectiveSpan('md', node({ span: 9 }, 'pane'), auto)).toBe(8);
        expect(effectiveSpan('md', node({ span: 6 }, 'pane'), auto)).toBe('full');
        expect(effectiveSpan('md', node({ span: 11 }, 'pane'), auto)).toBe('full');
    });

    it('tablet, manual grid or own columns: the span as written', () => {
        expect(effectiveSpan('md', node({ span: 3 }), manual)).toBe(3);
        expect(effectiveSpan('md', node({ span: 3 }, 'pane'), manual)).toBe(3);
        expect(effectiveSpan('md', node({ span: 2 }), five)).toBe(2);
        expect(effectiveSpan('md', node({ span: 7 }), five)).toBe('full');
    });

    it('tablet: spanMd wins over every other rule', () => {
        expect(effectiveSpan('md', node({ span: 3, spanMd: 4 }), auto)).toBe(4);
        expect(effectiveSpan('md', node({ span: 3, spanMd: 12 }), auto)).toBe('full');
        expect(effectiveSpan('md', node({ span: 2, spanMd: 3 }), five)).toBe(3);
        expect(effectiveSpan('md', node({ span: 2, spanMd: 6 }), five)).toBe('full');
    });

    it('phone: the full row unless the node sets spanSm', () => {
        expect(effectiveSpan('sm', node({ span: 3, spanMd: 4 }), auto)).toBe('full');
        expect(effectiveSpan('sm', node({ span: 3, spanSm: 6 }), auto)).toBe(6);
        expect(effectiveSpan('sm', node({ spanSm: 2 }), five)).toBe(2);
        expect(effectiveSpan('sm', node({ spanSm: 9 }), five)).toBe('full');
    });
});
