import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSheet } from './sheetApi';

// The editor computes `Klanten!A1` from the `refTabs` the server sends with a
// tab; getSheet rebuilds the answer field by field, and once dropped that one.
describe('getSheet', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('keeps the referenced tabs next to the cells', async () => {
        const body = {
            columns: 26, rows: 2, cells: { B3: '=Klanten!A2' }, readOnly: false,
            tabs: [{ id: 't1', name: 'Klanten' }, { id: 't2', name: 'Test' }], activeTab: 't2',
            refTabs: { Klanten: { A2: 'KL-10001' } },
        };
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        const sheet = await getSheet('doc-1', 't2');
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/doc-1/sheet?tab=t2');
        expect(sheet.refTabs).toEqual({ Klanten: { A2: 'KL-10001' } });
        expect(sheet.activeTab).toBe('t2');
    });

    it('leaves refTabs out when the server sends none', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ cells: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
        expect((await getSheet('doc-1')).refTabs).toBeUndefined();
    });
});
