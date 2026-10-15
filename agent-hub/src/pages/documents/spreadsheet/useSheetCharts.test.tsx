import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioDocument } from '../documentQueries';
import type { SheetChartConfig } from './sheetCharts';
import useSheetCharts from './useSheetCharts';

const { api } = vi.hoisted(() => ({ api: { getDocument: vi.fn(), updateDocument: vi.fn() } }));
vi.mock('../documentsApi', () => api);

const chart = (id: string, extra: Partial<SheetChartConfig> = {}): SheetChartConfig => ({
    id, type: 'bar', dataRange: 'B2:B5', anchor: 'E2', width: 672, height: 392, tab: 't1', ...extra,
});
const doc = (charts: SheetChartConfig[], versionId = 'v1'): StudioDocument => ({
    id: 'doc-1', userId: 'u1', name: 'Sales', docType: 'spreadsheet', bodyHtml: '', versionId,
    settings: { sheet: { tabs: [{ id: 't1', name: 'Main' }], charts } },
});

/** updateDocument answers with what it was asked to store. */
function echoSaves() {
    api.updateDocument.mockImplementation(async (_id: string, patch: { settings: StudioDocument['settings'] }) => ({ ...doc([]), settings: patch.settings }));
}
const savedCharts = (call = 0) => (api.updateDocument.mock.calls[call][1] as { settings: { sheet: { charts: SheetChartConfig[] } } }).settings.sheet.charts;

describe('useSheetCharts', () => {
    beforeEach(() => {
        api.getDocument.mockReset();
        api.updateDocument.mockReset();
    });

    it('adds and removes a chart on top of the newest settings, with its version', async () => {
        api.getDocument.mockResolvedValue(doc([chart('a')], 'v7'));
        echoSaves();
        const { result } = renderHook(() => useSheetCharts(doc([chart('a')])));
        await act(() => result.current.addChart(chart('b')));
        expect(savedCharts().map((c) => c.id)).toEqual(['a', 'b']);
        expect(api.updateDocument.mock.calls[0][1]).toEqual(expect.objectContaining({ expectedVersionId: 'v7' }));
        expect((api.updateDocument.mock.calls[0][1] as { settings: { sheet: { tabs: unknown[] } } }).settings.sheet.tabs).toHaveLength(1);
        expect(result.current.charts.map((c) => c.id)).toEqual(['a', 'b']);
        api.getDocument.mockResolvedValue(doc([chart('a'), chart('b')], 'v8'));
        await act(() => result.current.removeChart('a'));
        expect(savedCharts(1).map((c) => c.id)).toEqual(['b']);
    });

    it('the assistant\'s charts replace one with the same id and add the rest', async () => {
        api.getDocument.mockResolvedValue(doc([chart('a'), chart('b')]));
        echoSaves();
        const { result } = renderHook(() => useSheetCharts(doc([chart('a'), chart('b')])));
        await act(() => result.current.applyCharts([chart('a', { type: 'line' }), chart('c')]));
        expect(savedCharts().map((c) => [c.id, c.type])).toEqual([['a', 'line'], ['b', 'bar'], ['c', 'bar']]);
        await act(() => result.current.applyCharts([]));
        expect(api.updateDocument).toHaveBeenCalledTimes(1);
    });

    it('an Add goes on top of the STORED list: a chart the editor never saw survives', async () => {
        api.getDocument.mockResolvedValue(doc([chart('a'), chart('from-chat')]));
        echoSaves();
        const { result } = renderHook(() => useSheetCharts(doc([chart('a')])));
        await act(() => result.current.addChart(chart('b')));
        expect(savedCharts().map((c) => c.id)).toEqual(['a', 'from-chat', 'b']);
        expect(result.current.charts.map((c) => c.id)).toEqual(['a', 'from-chat', 'b']);
        await act(() => result.current.removeChart('a'));
        expect(savedCharts(1).map((c) => c.id)).toEqual(['from-chat']);
    });

    it('after a tab delete, reload drops its charts and an Add does not bring them back', async () => {
        api.getDocument.mockResolvedValue(doc([chart('a'), chart('gone', { tab: 't2' })]));
        echoSaves();
        const { result } = renderHook(() => useSheetCharts(doc([chart('a'), chart('gone', { tab: 't2' })])));
        // the server removed tab t2 and its chart
        api.getDocument.mockResolvedValue(doc([chart('a')]));
        await act(() => result.current.reload());
        expect(result.current.charts.map((c) => c.id)).toEqual(['a']);
        await act(() => result.current.addChart(chart('b')));
        expect(savedCharts().map((c) => c.id)).toEqual(['a', 'b']);
    });

    it('even without a reload, an Add never writes back a chart the server already dropped', async () => {
        api.getDocument.mockResolvedValue(doc([chart('a')]));
        echoSaves();
        const { result } = renderHook(() => useSheetCharts(doc([chart('a'), chart('gone', { tab: 't2' })])));
        await act(() => result.current.addChart(chart('b')));
        expect(savedCharts().map((c) => c.id)).toEqual(['a', 'b']);
    });

    it('a failed save is kept as the error and thrown to the caller', async () => {
        api.getDocument.mockResolvedValue(doc([]));
        api.updateDocument.mockRejectedValue(new Error('conflict'));
        const { result } = renderHook(() => useSheetCharts(doc([])));
        await act(async () => { await expect(result.current.addChart(chart('a'))).rejects.toThrow('conflict'); });
        expect(result.current.error?.message).toBe('conflict');
        expect(result.current.charts).toEqual([]);
    });

    it('takes the stored charts again when the chat wrote to this document, not another one', async () => {
        api.getDocument.mockResolvedValue(doc([chart('a'), chart('k', { type: 'kpi', dataRange: 'B2' })]));
        const { result } = renderHook(() => useSheetCharts(doc([chart('a')])));
        act(() => { window.dispatchEvent(new CustomEvent('beeflow:document-updated', { detail: { documentId: 'other' } })); });
        expect(api.getDocument).not.toHaveBeenCalled();
        act(() => { window.dispatchEvent(new CustomEvent('beeflow:document-updated', { detail: { documentId: 'doc-1' } })); });
        await waitFor(() => expect(result.current.charts.map((c) => c.id)).toEqual(['a', 'k']));
    });
});
