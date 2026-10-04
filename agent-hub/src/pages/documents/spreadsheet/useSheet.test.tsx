import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '../../../test/queryWrapper';
import useSheet, { SAVE_DEBOUNCE_MS } from './useSheet';

const { api } = vi.hoisted(() => ({ api: { getSheet: vi.fn(), patchSheet: vi.fn() } }));
vi.mock('./sheetApi', async (original) => ({ ...(await original<typeof import('./sheetApi')>()), getSheet: api.getSheet, patchSheet: api.patchSheet }));

const sheet = (cells: Record<string, string> = {}, readOnly = false) => ({ columns: 26, rows: 0, cells, readOnly });

async function mount(cells: Record<string, string> = {}, readOnly = false) {
    api.getSheet.mockResolvedValue(sheet(cells, readOnly));
    const hook = renderHook(() => useSheet('doc-1'), { wrapper: queryWrapper() });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
}

describe('useSheet', () => {
    beforeEach(() => {
        api.getSheet.mockReset();
        api.patchSheet.mockReset();
        api.patchSheet.mockResolvedValue({});
    });

    it('applies an edit at once and recomputes the formulas that read it', async () => {
        const { result } = await mount({ A1: '1', A2: '=A1*2' });
        expect(result.current.computed.A2.display).toBe('2');
        act(() => result.current.setCells({ A1: '5' }));
        expect(result.current.cells.A1).toBe('5');
        expect(result.current.computed.A2.display).toBe('10');
        expect(result.current.status).toBe('unsaved');
        expect(api.patchSheet).not.toHaveBeenCalled();
    });

    it('sends the edits of one burst in a single PATCH after the pause', async () => {
        const { result } = await mount();
        act(() => { result.current.setCells({ A1: '1' }); result.current.setCells({ B1: '2' }); result.current.setCells({ A1: '3' }); });
        await waitFor(() => expect(api.patchSheet).toHaveBeenCalledTimes(1), { timeout: SAVE_DEBOUNCE_MS + 1500 });
        expect(api.patchSheet).toHaveBeenCalledWith('doc-1', { A1: '3', B1: '2' });
        await waitFor(() => expect(result.current.status).toBe('saved'));
    });

    it('sends at most 500 cells per request', async () => {
        const { result } = await mount();
        const many: Record<string, string> = {};
        for (let r = 1; r <= 1200; r++) many[`A${r}`] = String(r);
        act(() => result.current.setCells(many));
        await act(async () => { await result.current.flush(); });
        expect(api.patchSheet.mock.calls.map((c) => Object.keys(c[1]).length)).toEqual([500, 500, 200]);
        expect(result.current.status).toBe('saved');
    });

    it('keeps everything queued when a save fails, and a retry sends it', async () => {
        const { result } = await mount();
        api.patchSheet.mockRejectedValueOnce(new Error('offline'));
        act(() => result.current.setCells({ A1: '1', B2: '2' }));
        await act(async () => { await result.current.flush(); });
        expect(result.current.status).toBe('error');
        expect(result.current.error?.message).toBe('offline');
        expect(result.current.cells.A1).toBe('1');
        await act(async () => { await result.current.flush(); });
        expect(api.patchSheet).toHaveBeenLastCalledWith('doc-1', { A1: '1', B2: '2' });
        expect(result.current.status).toBe('saved');
        expect(result.current.error).toBeNull();
    });

    it('saves what is still queued when the page is left', async () => {
        const { result, unmount } = await mount();
        act(() => result.current.setCells({ C3: 'x' }));
        unmount();
        await waitFor(() => expect(api.patchSheet).toHaveBeenCalledWith('doc-1', { C3: 'x' }));
    });

    it('clears a cell with an empty value', async () => {
        const { result } = await mount({ A1: '1' });
        act(() => result.current.setCells({ A1: '' }));
        expect(result.current.cells).toEqual({});
        await act(async () => { await result.current.flush(); });
        expect(api.patchSheet).toHaveBeenCalledWith('doc-1', { A1: '' });
    });

    it('ignores edits of a view-only sheet', async () => {
        const { result } = await mount({ A1: '1' }, true);
        act(() => result.current.setCells({ A1: '2' }));
        expect(result.current.cells.A1).toBe('1');
        await act(async () => { await result.current.flush(); });
        expect(api.patchSheet).not.toHaveBeenCalled();
    });

    it('applySaved lays saved cells over the baseline without queueing a save', async () => {
        const { result } = await mount({ A1: '1', B1: 'x' });
        act(() => result.current.applySaved({ A1: '2', B1: '', C1: '=A1*2' }));
        expect(result.current.cells).toEqual({ A1: '2', C1: '=A1*2' });
        expect(result.current.computed.C1.display).toBe('4');
        await act(async () => { await result.current.flush(); });
        expect(api.patchSheet).not.toHaveBeenCalled();
        expect(result.current.status).toBe('saved');
    });
});
