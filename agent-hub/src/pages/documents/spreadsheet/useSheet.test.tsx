import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '../../../test/queryWrapper';
import useSheet, { SAVE_DEBOUNCE_MS } from './useSheet';

const { api } = vi.hoisted(() => ({ api: { getSheet: vi.fn(), patchSheet: vi.fn() } }));
vi.mock('../../../api/sheetApi', async (original) => ({ ...(await original<typeof import('../../../api/sheetApi')>()), getSheet: api.getSheet, patchSheet: api.patchSheet }));

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

    it('computes a formula over another tab from the refTabs the server sends', async () => {
        api.getSheet.mockResolvedValue({
            ...sheet({ A1: 'ZZP', B1: '=COUNTIF(Klanten!$L$2:$L$4,A1)', B2: '=Missing!A1' }),
            tabs: [{ id: 't1', name: 'Klanten' }, { id: 't2', name: 'Draaitabel' }], activeTab: 't2',
            refTabs: { Klanten: { L2: 'ZZP', L3: 'MKB', L4: 'ZZP' } },
        });
        const { result } = renderHook(() => useSheet('doc-1'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.computed.B1.display).toBe('2');
        expect(result.current.computed.B2.error).toBeTruthy();
    });

    it('reads the sheet again once a typed formula names a tab the server did not send', async () => {
        const first = {
            ...sheet({ A1: '1' }), tabs: [{ id: 't1', name: 'Klanten' }, { id: 't2', name: 'Test' }], activeTab: 't2', refTabs: {},
        };
        api.getSheet.mockResolvedValueOnce(first).mockResolvedValue({ ...first, cells: { A1: '1', B1: '=Klanten!A2' }, refTabs: { Klanten: { A2: 'KL-1' } } });
        const { result } = renderHook(() => useSheet('doc-1'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.loading).toBe(false));
        act(() => result.current.setCells({ B1: '=Klanten!A2' }));
        await act(async () => { await result.current.flush(); });
        await waitFor(() => expect(result.current.computed.B1.display).toBe('KL-1'));
        const reads = api.getSheet.mock.calls.length;
        await new Promise((r) => setTimeout(r, 50));
        expect(api.getSheet.mock.calls.length).toBe(reads);
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

    describe('AI document update', () => {
        const fire = (documentId: string) => act(() => { window.dispatchEvent(new CustomEvent('beeflow:document-updated', { detail: { documentId } })); });

        it('reads the sheet again when the AI changed this document', async () => {
            const { result } = await mount({ A1: '1' });
            api.getSheet.mockResolvedValue(sheet({ A1: '9' }));
            fire('doc-1');
            await waitFor(() => expect(result.current.cells.A1).toBe('9'));
            expect(api.getSheet).toHaveBeenCalledTimes(2);
        });

        it('ignores another document', async () => {
            await mount({ A1: '1' });
            fire('other');
            expect(api.getSheet).toHaveBeenCalledTimes(1);
        });

        it('waits for an unsaved cell edit, then reads again', async () => {
            const { result } = await mount({ A1: '1' });
            act(() => result.current.setCells({ B1: 'x' }));
            fire('doc-1');
            expect(api.getSheet).toHaveBeenCalledTimes(1);
            api.getSheet.mockResolvedValue(sheet({ A1: '9', B1: 'x' }));
            await act(async () => { await result.current.flush(); });
            await waitFor(() => expect(api.getSheet).toHaveBeenCalledTimes(2));
            await waitFor(() => expect(result.current.cells.A1).toBe('9'));
        });
    });
});
