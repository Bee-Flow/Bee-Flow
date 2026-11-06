import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import QueryLogTab from './QueryLogTab';
import { renderWithClient } from '@/test/render';
import { asMock } from '@/test/mocks';

const fetchMock = vi.fn();
const rel = (u: unknown) => String(u).replace(/^https?:\/\/[^/]+/, '');

const ROW = {
    id: 'e1', kbId: 'kb1', userId: 'u1', userName: 'Alice', channel: 'direct_chat', createdAt: '2026-11-05T10:00:00Z',
    query: 'How long is a quote valid?', answer: 'Thirty days.', model: 'm1', answerMs: 900, retrievalMs: 120,
    chunks: [{ chunkId: 1, title: 'Terms', sourceUri: 'terms.pdf', score: 0.81, text: 'Quotes are valid for 30 days.' }],
    chunkCount: 1, topScore: 0.81, citations: ['Terms'], outcome: 'answered', errorCode: null,
    reviewStatus: 'to_review', reviewNote: null, reviewedBy: null, reviewedAt: null,
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob(['x']) });
const urls = () => asMock(fetchMock).mock.calls.map(([u]) => rel(u));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    asMock(fetchMock).mockImplementation(async (url: string, init?: { method?: string }) => {
        if (rel(url).includes('/review')) return ok({ ...ROW, reviewStatus: 'reviewed' });
        void init;
        return ok({ rows: [ROW], total: 1, limit: 25, offset: 0 });
    });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('QueryLogTab', () => {
    it('lists the entries and opens the detail with the passages', async () => {
        const user = userEvent.setup();
        renderWithClient(<QueryLogTab kbId="kb1" />);
        const row = await screen.findByTestId('kb-ql-row-e1');
        expect(within(row).getByText('Alice')).toBeTruthy();
        await user.click(row);
        const detail = await screen.findByTestId('kb-ql-detail');
        expect(within(detail).getByText('Thirty days.')).toBeTruthy();
        expect(within(detail).getByTestId('kb-ql-passage').textContent).toContain('Quotes are valid for 30 days.');
    });

    it('puts a changed filter in the request', async () => {
        const user = userEvent.setup();
        renderWithClient(<QueryLogTab kbId="kb1" />);
        await screen.findByTestId('kb-ql-row-e1');
        expect(urls()[0]).toBe('/api/kb/kb1/query-log?limit=25&offset=0');
        await user.selectOptions(screen.getByTestId('kb-ql-outcome'), 'no_results');
        await waitFor(() => expect(urls().some((u) => u.includes('outcome=no_results'))).toBe(true));
        await user.type(screen.getByTestId('kb-ql-text'), 'quote');
        await user.click(screen.getByTestId('kb-ql-search'));
        await waitFor(() => expect(urls().some((u) => u.includes('q=quote'))).toBe(true));
    });

    it('saves the review through PATCH with status and note', async () => {
        const user = userEvent.setup();
        renderWithClient(<QueryLogTab kbId="kb1" />);
        await user.click(await screen.findByTestId('kb-ql-row-e1'));
        await user.selectOptions(await screen.findByTestId('kb-ql-review-status'), 'needs_addition');
        await user.type(screen.getByTestId('kb-ql-review-note'), 'Add the terms');
        await user.click(screen.getByTestId('kb-ql-review-save'));
        await waitFor(() => {
            const call = asMock(fetchMock).mock.calls.find(([u]) => rel(u).endsWith('/e1/review'));
            expect(call?.[1]?.method).toBe('PATCH');
            expect(JSON.parse(call?.[1]?.body as string)).toEqual({ status: 'needs_addition', note: 'Add the terms' });
        });
    });

    it('exports the CSV through the export route with the active filters', async () => {
        const user = userEvent.setup();
        URL.createObjectURL = vi.fn(() => 'blob:x');
        URL.revokeObjectURL = vi.fn();
        renderWithClient(<QueryLogTab kbId="kb1" />);
        await screen.findByTestId('kb-ql-row-e1');
        await user.selectOptions(screen.getByTestId('kb-ql-status'), 'to_review');
        await user.click(screen.getByTestId('kb-ql-export'));
        await waitFor(() => expect(urls().some((u) => u.startsWith('/api/kb/kb1/query-log/export.csv?') && u.includes('status=to_review'))).toBe(true));
    });
});
