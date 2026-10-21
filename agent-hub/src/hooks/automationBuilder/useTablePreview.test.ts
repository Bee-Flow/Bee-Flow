import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewFn, TablePreviewOk } from '../../api/queries/automation/tablePreview';
import { PREVIEW_DELAY_MS, useTablePreview, type UseTablePreviewArgs } from './useTablePreview';

const ok = (rowCount: number): TablePreviewOk => ({
    ok: true, columns: [], rows: [], rowCount, inputRows: rowCount, inputCapped: false, description: null, segments: null, opResults: [], warnings: [],
});

const SOURCE = { runId: 'run1', tableId: `rtb_${'a'.repeat(32)}` };

function setup(preview: PreviewFn, extra: Partial<UseTablePreviewArgs> = {}) {
    return renderHook((props: Partial<UseTablePreviewArgs>) => useTablePreview({
        automationId: 'auto1', source: SOURCE, ops: [], preview, ...extra, ...props,
    }), { initialProps: {} as Partial<UseTablePreviewArgs> });
}

describe('useTablePreview', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('asks nothing until the author stops changing things', async () => {
        const preview = vi.fn<PreviewFn>().mockResolvedValue(ok(3));
        const { result, rerender } = setup(preview);
        expect(result.current.status).toBe('loading');
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS - 50); });
        rerender({ ops: [{ id: 'op1', op: 'filter' }] });
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS - 50); });
        expect(preview).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(100); });
        expect(preview).toHaveBeenCalledTimes(1);
        expect(preview.mock.calls[0][0]).toBe('auto1');
        expect(preview.mock.calls[0][1]).toEqual({ source: SOURCE, ops: [{ id: 'op1', op: 'filter' }] });
        expect(result.current.status).toBe('ready');
        expect(result.current.response).toMatchObject({ ok: true, rowCount: 3 });
    });

    it('sends the step to stop at and the second tables of joins', async () => {
        const preview = vi.fn<PreviewFn>().mockResolvedValue(ok(1));
        const other = { runId: 'run2', tableId: `rtb_${'b'.repeat(32)}` };
        setup(preview, { upToOpId: 'op2', joinSources: { op1: other }, limit: 20 });
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
        expect(preview.mock.calls[0][1]).toEqual({ source: SOURCE, ops: [], upToOpId: 'op2', joinSources: { op1: other }, limit: 20 });
    });

    it('cancels the request that is on its way when a newer change is due', async () => {
        const signals: AbortSignal[] = [];
        const preview = vi.fn<PreviewFn>().mockImplementation((_id, body, signal) => {
            if (signal) signals.push(signal);
            return new Promise(resolve => { setTimeout(() => resolve(ok(body.ops.length)), 1000); });
        });
        const { result, rerender } = setup(preview);
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
        expect(signals).toHaveLength(1);
        rerender({ ops: [{ id: 'op1', op: 'filter' }] });
        expect(signals[0].aborted).toBe(true);
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS + 1000); });
        expect(preview).toHaveBeenCalledTimes(2);
        expect(result.current.response).toMatchObject({ rowCount: 1 });
    });

    it('does not ask again for the same ops', async () => {
        const preview = vi.fn<PreviewFn>().mockResolvedValue(ok(1));
        const { rerender } = setup(preview);
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
        rerender({ ops: [] });
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS * 2); });
        expect(preview).toHaveBeenCalledTimes(1);
    });

    it('keeps the last answer on screen while the next one loads', async () => {
        const preview = vi.fn<PreviewFn>().mockResolvedValue(ok(5));
        const { result, rerender } = setup(preview);
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
        rerender({ ops: [{ id: 'op1', op: 'sample' }] });
        expect(result.current.status).toBe('loading');
        expect(result.current.response).toMatchObject({ rowCount: 5 });
    });

    it('says what went wrong when the server refuses', async () => {
        const preview = vi.fn<PreviewFn>().mockRejectedValue(new Error('Too many requests'));
        const { result } = setup(preview);
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
        expect(result.current).toMatchObject({ status: 'error', error: 'Too many requests' });
    });

    it('stays idle without a table to preview or an automation to ask about', async () => {
        const preview = vi.fn<PreviewFn>().mockResolvedValue(ok(1));
        const { result, rerender } = setup(preview, { source: null });
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS * 2); });
        expect(result.current.status).toBe('idle');
        rerender({ source: SOURCE, automationId: null });
        await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS * 2); });
        expect(preview).not.toHaveBeenCalled();
        expect(result.current.status).toBe('idle');
    });
});
