import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { authFetch } from '@/utils/helpers';
import { withQueryClient } from '@/test/queryWrapper';
import type { TableHandle } from '@/api/queries/automation/runTables';
import RunTableView, { cellText } from './RunTableView';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const TABLE_ID = 'rtb_0123456789abcdef0123456789abcdef';

const table = (over: Partial<TableHandle> = {}): TableHandle => ({
    kind: 'table', tableId: TABLE_ID, runId: 'run-early', name: 'Scores per region', rowCount: 120,
    columns: [{ key: 'region', label: 'Region', type: 'text' }, { key: 'n', label: 'Answers', type: 'number' }],
    preview: [], expiresAt: null, provenance: null, ...over,
});

const pageOf = (offset: number, count: number, over: Record<string, unknown> = {}) => ({
    name: 'Scores per region', runId: 'run-early', rowCount: 120, offset, limit: 50, hasMore: offset + count < 120, expiresAt: null,
    columns: [{ key: 'region', label: 'Region', type: 'text' }, { key: 'n', label: 'Answers', type: 'number' }],
    rows: Array.from({ length: count }, (_, i) => ({ region: `Row ${offset + i + 1}`, n: offset + i + 1 })),
    ...over,
});

const reply = (body: unknown, status = 200) => Promise.resolve({
    ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body, blob: async () => new Blob(['a']),
} as unknown as Response);

let urls: string[] = [];
let downloads: string[] = [];

function serve(handler: (url: string) => Promise<Response>) {
    vi.mocked(authFetch).mockImplementation((url: string) => {
        urls.push(url);
        return handler(url);
    });
}

function mount(t: TableHandle = table()) {
    return render(withQueryClient(<RunTableView runId="run-step" table={t} onClose={vi.fn()} />));
}

beforeEach(() => {
    urls = [];
    downloads = [];
    vi.mocked(authFetch).mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
        downloads.push(this.download);
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('RunTableView', () => {
    it('shows the first page with the column labels and the range', async () => {
        serve(() => reply(pageOf(0, 50)));
        mount();
        expect(screen.getByRole('status').textContent).toContain('Loading rows');
        expect(await screen.findByText('Row 1')).toBeTruthy();
        expect(screen.getByRole('columnheader', { name: 'Region' })).toBeTruthy();
        expect(screen.getByRole('columnheader', { name: 'Answers' })).toBeTruthy();
        expect(screen.getByText('Rows 1–50 of 120')).toBeTruthy();
        // The run that wrote the table is asked, not the run of the step.
        expect(urls[0]).toBe(`/api/automation/runs/run-early/tables/${TABLE_ID}?offset=0&limit=50`);
    });

    it('falls back to the step run when the handle names none', async () => {
        serve(() => reply(pageOf(0, 3, { rowCount: 3 })));
        mount(table({ runId: null, rowCount: 3 }));
        await screen.findByText('Row 1');
        expect(urls[0]).toContain('/runs/run-step/tables/');
    });

    it('pages forward and back, and stops at the ends', async () => {
        const user = userEvent.setup();
        serve((url) => {
            const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
            return reply(pageOf(offset, Math.min(50, 120 - offset)));
        });
        mount();
        await screen.findByText('Row 1');
        const prev = screen.getByRole('button', { name: /Previous/ }) as HTMLButtonElement;
        const next = screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement;
        expect(prev.disabled).toBe(true);
        expect(next.disabled).toBe(false);

        await user.click(next);
        expect(await screen.findByText('Row 51')).toBeTruthy();
        expect(screen.getByText('Rows 51–100 of 120')).toBeTruthy();
        expect(urls.at(-1)).toContain('offset=50');

        await user.click(screen.getByRole('button', { name: /Next/ }));
        expect(await screen.findByText('Rows 101–120 of 120')).toBeTruthy();
        expect((screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true);

        await user.click(screen.getByRole('button', { name: /Previous/ }));
        expect(await screen.findByText('Rows 51–100 of 120')).toBeTruthy();
    });

});

describe('RunTableView states', () => {
    it('says so when the table has expired (404)', async () => {
        serve(() => reply({ error: 'gone', code: 'run_table_not_found' }, 404));
        mount();
        expect((await screen.findByRole('alert')).textContent).toBe('This table has expired.');
        expect(screen.queryByRole('button', { name: /Download as CSV/ })).toBeNull();
    });

    it('says the rows could not be loaded on any other failure', async () => {
        serve(() => reply({ error: 'boom' }, 500));
        mount();
        expect((await screen.findByRole('alert')).textContent).toBe('The rows could not be loaded.');
    });

    it('says an empty table has no rows, and offers no pager', async () => {
        serve(() => reply(pageOf(0, 0, { rowCount: 0, hasMore: false })));
        mount(table({ rowCount: 0 }));
        expect(await screen.findByText('This table has no rows.')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Next/ })).toBeNull();
    });

    it('downloads the whole table as a CSV from the same run', async () => {
        const user = userEvent.setup();
        serve((url) => (url.endsWith('/csv') ? reply(null) : reply(pageOf(0, 2, { rowCount: 2 }))));
        mount(table({ rowCount: 2 }));
        await screen.findByText('Row 1');
        await user.click(screen.getByRole('button', { name: /Download as CSV/ }));
        await waitFor(() => expect(downloads).toEqual(['Scores per region.csv']));
        expect(urls.at(-1)).toBe(`/api/automation/runs/run-early/tables/${TABLE_ID}/csv`);
    });

    it('tells the person when the CSV cannot be downloaded', async () => {
        const user = userEvent.setup();
        serve((url) => (url.endsWith('/csv') ? reply({ error: 'gone' }, 404) : reply(pageOf(0, 2, { rowCount: 2 }))));
        mount(table({ rowCount: 2 }));
        await screen.findByText('Row 1');
        await user.click(screen.getByRole('button', { name: /Download as CSV/ }));
        expect((await screen.findByRole('alert')).textContent).toBe('This table has expired.');
        expect(downloads).toEqual([]);
    });

    it('gives a long cell a tooltip with its full text', async () => {
        const long = 'x'.repeat(300);
        serve(() => reply(pageOf(0, 1, { rowCount: 1, rows: [{ region: long, n: 1 }] })));
        mount(table({ rowCount: 1 }));
        const cell = await screen.findByText(long);
        expect(cell.getAttribute('title')).toBe(long);
        expect(cell.className).toContain('truncate');
    });
});

describe('cellText', () => {
    it('shows values as they are, an empty cell as nothing', () => {
        expect(cellText(null)).toBe('');
        expect(cellText(undefined)).toBe('');
        expect(cellText('a')).toBe('a');
        expect(cellText(0)).toBe('0');
        expect(cellText(false)).toBe('false');
        expect(cellText({ a: 1 })).toBe('{"a":1}');
    });
});
