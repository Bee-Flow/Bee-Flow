import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { cellSpanView, previewSpanClass, useCellSpanView } from './spanView';
import { getCanvasBreakpoint, setCanvasBreakpoint } from '../canvasBreakpoint';
import { measureGrid, spanFromDrag, trackCount } from '../resize';

const section = { isGrid: true, style: { gap: 3 } };
const five = { isGrid: true, style: { columns: 5 } };

afterEach(() => setCanvasBreakpoint('lg'));

describe('cellSpanView', () => {
    it('Desktop: reads and writes span, with no preview class', () => {
        expect(cellSpanView('lg', { type: 'card', style: { span: 4, spanMd: 6 } }, section))
            .toEqual({ spanKnob: 'span', columns: 12, currentSpan: 4, restClass: '' });
    });

    it('Tablet: writes spanMd and shows the width the tablet tier gives the cell', () => {
        expect(cellSpanView('md', { type: 'card', style: { span: 3 } }, section))
            .toEqual({ spanKnob: 'spanMd', columns: 12, currentSpan: 6, restClass: ' app-span-preview-6' });
        expect(cellSpanView('md', { type: 'card', style: { span: 3, spanMd: 4 } }, section).currentSpan).toBe(4);
        expect(cellSpanView('md', { type: 'card', style: { span: 8 } }, section))
            .toEqual({ spanKnob: 'spanMd', columns: 12, currentSpan: 12, restClass: ' app-span-preview-full' });
    });

    it('Phone: writes spanSm; a cell without one is the full row', () => {
        expect(cellSpanView('sm', { type: 'stat', style: { span: 3 } }, section))
            .toEqual({ spanKnob: 'spanSm', columns: 12, currentSpan: 12, restClass: ' app-span-preview-full' });
        expect(cellSpanView('sm', { type: 'stat', style: { span: 3, spanSm: 6 } }, section).restClass).toBe(' app-span-preview-6');
    });

    it('counts in the columns of the grid the cell sits in', () => {
        expect(cellSpanView('lg', { type: 'card', style: { span: 12 } }, five)).toEqual({ spanKnob: 'span', columns: 5, currentSpan: 5, restClass: '' });
        expect(cellSpanView('lg', { type: 'card', style: { span: 2 } }, five).currentSpan).toBe(2);
    });

    it('outside a grid it is the plain span in 12 columns at every size', () => {
        for (const bp of ['lg', 'md', 'sm'] as const) {
            const view = cellSpanView(bp, { type: 'button', style: { span: 3 } }, { isGrid: false });
            expect([view.columns, view.currentSpan, view.restClass]).toEqual([12, 3, '']);
        }
        expect(cellSpanView('md', { style: {} }, null).currentSpan).toBe(12);
    });

    it('names the preview class of a span', () => {
        expect(previewSpanClass(7)).toBe(' app-span-preview-7');
        expect(previewSpanClass('full')).toBe(' app-span-preview-full');
    });
});

describe('the canvas breakpoint', () => {
    it('starts on Desktop and re-renders the cells that read it', () => {
        expect(getCanvasBreakpoint()).toBe('lg');
        const { result } = renderHook(() => useCellSpanView({ type: 'card', style: { span: 3 } }, section));
        expect(result.current.spanKnob).toBe('span');
        act(() => setCanvasBreakpoint('md'));
        expect(result.current.spanKnob).toBe('spanMd');
        expect(result.current.currentSpan).toBe(6);
        act(() => setCanvasBreakpoint('sm'));
        expect(result.current.spanKnob).toBe('spanSm');
    });

    it('ignores a value that is not a breakpoint', () => {
        setCanvasBreakpoint('xl' as never);
        expect(getCanvasBreakpoint()).toBe('lg');
    });
});

describe('resize in a grid with its own columns', () => {
    it('counts the tracks of a computed template', () => {
        expect(trackCount('81.5px 81.5px 81.5px 81.5px 81.5px')).toBe(5);
        expect(trackCount('repeat(5, minmax(0, 1fr))')).toBe(5);
        expect(trackCount('repeat(12, minmax(0, 1fr))')).toBe(12);
        expect(trackCount('400px')).toBe(1);
        for (const none of ['', 'none', null, undefined, 'repeat(0, 1fr)', 'repeat(40, 1fr)']) expect(trackCount(none)).toBe(12);
    });

    it('measures one step as a track plus its gap, in the real track count', () => {
        const el = document.createElement('div');
        el.style.gridTemplateColumns = 'repeat(5, minmax(0, 1fr))';
        el.style.columnGap = '10px';
        Object.defineProperty(el, 'clientWidth', { value: 490 });
        document.body.appendChild(el);
        // (490 + 10) / 5
        expect(measureGrid(el)).toEqual({ columnWidth: 100, columns: 5 });
        el.remove();
        expect(measureGrid(null)).toEqual({ columnWidth: 0, columns: 12 });
    });

    it('a drag cannot leave the grid: the span stops at the column count', () => {
        expect(spanFromDrag({ startSpan: 2, dx: 100, columnWidth: 100, columns: 5 })).toBe(3);
        expect(spanFromDrag({ startSpan: 2, dx: 900, columnWidth: 100, columns: 5 })).toBe(5);
        expect(spanFromDrag({ startSpan: 12, dx: 0, columnWidth: 100, columns: 5 })).toBe(5);
        // Without a count it is the 12-column grid, as before.
        expect(spanFromDrag({ startSpan: 2, dx: 2000, columnWidth: 100 })).toBe(12);
    });
});
