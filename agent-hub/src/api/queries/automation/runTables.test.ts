import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch } from '@/utils/helpers';
import { AutomationRequestError } from './http';
import { downloadRunTableCsv, fetchRunTablePage, isTableHandle, tableHandlesIn } from './runTables';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const ID1 = 'rtb_0123456789abcdef0123456789abcdef';
const ID2 = 'rtb_fedcba9876543210fedcba9876543210';

const handle = (over: Record<string, unknown> = {}) => ({
    kind: 'table', tableId: ID1, runId: 'run-1', name: 'Scores', rowCount: 3,
    columns: [{ key: 'region', label: 'Region', type: 'text' }, { key: 'n', label: 'N', type: 'number' }],
    preview: [{ region: 'North', n: 1 }], expiresAt: null, provenance: null, ...over,
});

describe('isTableHandle', () => {
    it('accepts the handle of a kept table', () => {
        expect(isTableHandle(handle())).toBe(true);
    });

    it('refuses a dry run placeholder and anything that only looks like a handle', () => {
        expect(isTableHandle(handle({ tableId: 'dry-run' }))).toBe(false);
        expect(isTableHandle(handle({ tableId: 'rtb_short' }))).toBe(false);
        expect(isTableHandle(handle({ kind: 'generated_file' }))).toBe(false);
        expect(isTableHandle(handle({ columns: 'x' }))).toBe(false);
        expect(isTableHandle(handle({ rowCount: 'many' }))).toBe(false);
        expect(isTableHandle(null)).toBe(false);
        expect(isTableHandle('text')).toBe(false);
        expect(isTableHandle([handle()])).toBe(false);
    });
});

describe('tableHandlesIn', () => {
    it('reads output.table and output.tables, each table once', () => {
        const other = handle({ tableId: ID2, name: 'Other' });
        const found = tableHandlesIn({ table: handle(), tables: [handle(), other] });
        expect(found.map((t) => t.tableId)).toEqual([ID1, ID2]);
    });

    it('skips a dry run placeholder and plain values', () => {
        expect(tableHandlesIn({ table: handle({ tableId: 'dry-run' }), tables: [] })).toEqual([]);
        expect(tableHandlesIn('text')).toEqual([]);
        expect(tableHandlesIn(null)).toEqual([]);
        expect(tableHandlesIn({ rows: [{ a: 1 }] })).toEqual([]);
    });

    it('fills in what the handle left out', () => {
        const [t] = tableHandlesIn({ table: { kind: 'table', tableId: ID1, name: 'Scores', rowCount: 1, columns: [{ key: 'a' }, { nope: 1 }] } });
        expect(t.runId).toBeNull();
        expect(t.preview).toEqual([]);
        expect(t.expiresAt).toBeNull();
        expect(t.provenance).toBeNull();
        expect(t.columns).toEqual([{ key: 'a', label: 'a', type: 'text' }]);
    });
});

const reply = (body: unknown, status = 200, blob = new Blob(['a,b'])) => Promise.resolve({
    ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, blob: async () => blob,
} as unknown as Response);

describe('the read routes', () => {
    let clicks: Array<{ href: string; download: string }> = [];
    beforeEach(() => {
        clicks = [];
        vi.mocked(authFetch).mockReset();
        URL.createObjectURL = vi.fn(() => 'blob:fake');
        URL.revokeObjectURL = vi.fn();
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
            clicks.push({ href: this.href, download: this.download });
        });
    });
    afterEach(() => vi.restoreAllMocks());

    it('asks for one page of the run that wrote the table', async () => {
        vi.mocked(authFetch).mockReturnValue(reply({ name: 'Scores', runId: 'run-1', columns: [{ key: 'a', label: 'A', type: 'number' }], rowCount: 120, offset: 50, limit: 50, rows: [{ a: 1 }], hasMore: true, expiresAt: null }));
        const page = await fetchRunTablePage('run 1', ID1, 50, 50);
        expect(vi.mocked(authFetch).mock.calls[0][0]).toBe('/api/automation/runs/run%201/tables/' + ID1 + '?offset=50&limit=50');
        expect(page).toMatchObject({ rowCount: 120, offset: 50, hasMore: true, rows: [{ a: 1 }] });
        expect(page.columns).toEqual([{ key: 'a', label: 'A', type: 'number' }]);
    });

    it('throws the server code on a missing table', async () => {
        vi.mocked(authFetch).mockReturnValue(reply({ error: 'gone', code: 'run_table_not_found' }, 404));
        await expect(fetchRunTablePage('run-1', ID1, 0, 50)).rejects.toMatchObject({ status: 404, code: 'run_table_not_found' });
        await expect(fetchRunTablePage('run-1', ID1, 0, 50)).rejects.toBeInstanceOf(AutomationRequestError);
    });

    it('downloads the CSV with the session, under a safe file name', async () => {
        vi.mocked(authFetch).mockReturnValue(reply(null));
        await downloadRunTableCsv('run-1', ID1, 'Scores/by: region');
        expect(vi.mocked(authFetch).mock.calls[0][0]).toBe('/api/automation/runs/run-1/tables/' + ID1 + '/csv');
        expect(clicks).toEqual([{ href: 'blob:fake', download: 'Scores by region.csv' }]);
    });

    it('does not save anything when the download is refused', async () => {
        vi.mocked(authFetch).mockReturnValue(reply({ error: 'gone' }, 404));
        await expect(downloadRunTableCsv('run-1', ID1, 'x')).rejects.toMatchObject({ status: 404 });
        expect(clicks).toEqual([]);
    });
});
