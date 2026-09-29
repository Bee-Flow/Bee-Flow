import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { knowledgeApi } from './knowledgeApi';
import SourceDetail, { isPending, statusOfDoc } from './SourceDetail';

vi.mock('./knowledgeApi', () => {
    const knowledgeApi = {
        list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(),
        setPublished: vi.fn(), remove: vi.fn(), categories: vi.fn(),
        listSources: vi.fn(), createSource: vi.fn(), updateSource: vi.fn(),
        removeSource: vi.fn(), refreshSource: vi.fn(), uploadFiles: vi.fn(),
        listSourceDocuments: vi.fn(), getSourceDocument: vi.fn(),
        documentContent: vi.fn(), removeDocument: vi.fn(),
    };
    return { knowledgeApi, default: knowledgeApi };
});

/**
 * This screen exists because a failed file used to leave NO ROW AT ALL — a
 * folder of 38 became a knowledge base of 36 with nothing saying which two
 * were missing. So the status column, and the fact that a skipped file is
 * still listed, are the assertions that matter.
 */

const SOURCE = {
    id: 's1', kind: 'nextcloud_folder', name: 'Nextcloud · /Sales/Terms',
    refreshMode: 'on_change', status: 'idle',
    documentCount: 38, processedCount: 34, redactedCount: 2, skippedCount: 2,
    errorCount: 0, duplicateCount: 0, piiFoundCount: 3,
};

const doc = (over = {}) => ({
    id: 'd1', title: 'Terms 2026.pdf', status: 'processed', status_reason: null,
    page_count: 14, sheet_count: null, size_bytes: null, mime: 'application/pdf',
    extract_summary: 'Payment term, 30 day validity, warranty',
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    knowledgeApi.listSourceDocuments.mockResolvedValue({ documents: [doc()], total: 1, limit: 50, offset: 0 });
});

describe('SourceDetail', () => {
    it('counts every filter chip from the source’s own totals', async () => {
        render(<SourceDetail kbId="kb1" kbName="Quote terms" source={SOURCE} />);
        await screen.findByTestId('kb-doc-row');
        expect(screen.getByTestId('kb-doc-filter-all').textContent).toMatch(/All 38/);
        // Processed counts shielded rows too — they ARE processed, just with
        // personal data replaced first.
        expect(screen.getByTestId('kb-doc-filter-processed').textContent).toMatch(/Processed 36/);
        expect(screen.getByTestId('kb-doc-filter-skipped').textContent).toMatch(/Skipped 2/);
        expect(screen.getByTestId('kb-doc-filter-pii').textContent).toMatch(/With personal data 3/);
    });

    it('asks the server for the right rows per filter', async () => {
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        await screen.findByTestId('kb-doc-row');

        fireEvent.click(screen.getByTestId('kb-doc-filter-skipped'));
        await waitFor(() => expect(knowledgeApi.listSourceDocuments).toHaveBeenLastCalledWith(
            'kb1', 's1', expect.objectContaining({ status: 'skipped,error' }),
        ));

        fireEvent.click(screen.getByTestId('kb-doc-filter-pii'));
        await waitFor(() => expect(knowledgeApi.listSourceDocuments).toHaveBeenLastCalledWith(
            'kb1', 's1', expect.objectContaining({ pii: 'found' }),
        ));
    });

    it('shows a skipped file WITH its reason instead of dropping it', async () => {
        knowledgeApi.listSourceDocuments.mockResolvedValue({
            documents: [doc({ id: 'd2', title: 'scan_0034.jpg', status: 'skipped', status_reason: 'No readable text found', extract_summary: null, page_count: null, size_bytes: 1_887_436, mime: 'image/jpeg' })],
            total: 1,
        });
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        const row = await screen.findByTestId('kb-doc-row');
        expect(row.dataset.status).toBe('skipped');
        expect(within(row).getByText('skipped')).toBeTruthy();
        expect(within(row).getByText('No readable text found')).toBeTruthy();
        expect(within(row).getByText('1.8 MB')).toBeTruthy();
    });

    it('names a shielded document as shielded, and explains it underneath', async () => {
        knowledgeApi.listSourceDocuments.mockResolvedValue({ documents: [doc({ status: 'redacted' })], total: 1 });
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        const row = await screen.findByTestId('kb-doc-row');
        expect(within(row).getByText('shielded')).toBeTruthy();
        expect(screen.getByText(/replaced before the text entered the knowledge base/)).toBeTruthy();
    });

    it('describes a file by what it has: pages, sheets, or size', async () => {
        knowledgeApi.listSourceDocuments.mockResolvedValue({
            documents: [
                doc({ id: 'a', page_count: 14 }),
                doc({ id: 'b', page_count: null, sheet_count: 3, title: 'Prices.xlsx' }),
                doc({ id: 'c', page_count: null, sheet_count: null, size_bytes: 1_887_436, title: 'scan.jpg' }),
            ],
            total: 3,
        });
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        await waitFor(() => expect(screen.getAllByTestId('kb-doc-row')).toHaveLength(3));
        expect(screen.getByText('14 pages')).toBeTruthy();
        expect(screen.getByText('3 sheets')).toBeTruthy();
        expect(screen.getByText('1.8 MB')).toBeTruthy();
    });

    it('notes a document that overlaps another source rather than hiding it', async () => {
        // Cross-source near-duplicates are ANNOTATED, not refused (K1a) —
        // the same price list can legitimately arrive as a file and a table.
        knowledgeApi.listSourceDocuments.mockResolvedValue({
            documents: [doc({ overlaps_document_id: 'd9' })], total: 1,
        });
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        expect(await screen.findByText(/overlaps another source/)).toBeTruthy();
    });

    it('polls while a queued upload settles, and stops when it has', async () => {
        vi.useFakeTimers();
        try {
            knowledgeApi.listSourceDocuments.mockResolvedValue({
                documents: [doc({ status: 'skipped', status_reason: 'Queued for processing' })], total: 1,
            });
            render(<SourceDetail kbId="kb1" source={SOURCE} />);
            await vi.waitFor(() => expect(screen.getByTestId('kb-doc-row')).toBeTruthy());
            const before = knowledgeApi.listSourceDocuments.mock.calls.length;

            knowledgeApi.listSourceDocuments.mockResolvedValue({ documents: [doc()], total: 1 });
            await vi.advanceTimersByTimeAsync(3100);
            expect(knowledgeApi.listSourceDocuments.mock.calls.length).toBeGreaterThan(before);
            await vi.waitFor(() => expect(screen.getByTestId('kb-doc-row').dataset.status).toBe('processed'));

            // Tearing the interval down takes one render after the answer
            // lands, so a single further tick can be in flight. What matters
            // is that it STOPS: three more windows produce nothing.
            await vi.advanceTimersByTimeAsync(3100);
            const settled = knowledgeApi.listSourceDocuments.mock.calls.length;
            await vi.advanceTimersByTimeAsync(9000);
            expect(knowledgeApi.listSourceDocuments.mock.calls.length).toBe(settled);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports a failed document list instead of claiming the source is empty', async () => {
        knowledgeApi.listSourceDocuments.mockRejectedValue(new Error('offline'));
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        expect(await screen.findByText('offline')).toBeTruthy();
        expect(screen.queryByText(/Nothing here yet/)).toBeNull();
    });

    it('renames the source from its header, so the row menu is not a dead end', async () => {
        // The sources table's "Rename" opens this screen; if the name here is
        // not editable that menu item leads nowhere.
        knowledgeApi.updateSource.mockResolvedValue({ source: { ...SOURCE, name: 'Terms folder' } });
        const onRenamed = vi.fn();
        render(<SourceDetail kbId="kb1" source={SOURCE} canManage onRenamed={onRenamed} />);
        await screen.findByTestId('kb-doc-row');
        fireEvent.click(screen.getByRole('button', { name: SOURCE.name }));
        const input = screen.getByRole('textbox', { name: /name/i });
        fireEvent.change(input, { target: { value: 'Terms folder' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(knowledgeApi.updateSource)
            .toHaveBeenCalledWith('kb1', 's1', { name: 'Terms folder' }));
        await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('s1', 'Terms folder'));
    });

    it('does not offer a rename to someone who cannot manage', async () => {
        render(<SourceDetail kbId="kb1" source={SOURCE} canManage={false} />);
        await screen.findByTestId('kb-doc-row');
        expect(screen.queryByRole('button', { name: SOURCE.name })).toBeNull();
    });

    it('marks a document that was STORED without being checked', async () => {
        // fail_open: the checker was unavailable and the org chose to proceed.
        // The status says "processed", which is true — and on its own reads as
        // "checked and clean", which is not.
        knowledgeApi.listSourceDocuments.mockResolvedValue({
            documents: [doc({ status: 'processed', pii_status: 'unscanned', status_reason: 'Personal-data checking was unavailable' })],
            total: 1,
        });
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        const row = await screen.findByTestId('kb-doc-row');
        expect(within(row).getByText('processed')).toBeTruthy();
        expect(within(row).getByTestId('kb-doc-unscanned')).toBeTruthy();
        expect(screen.getByTestId('kb-unscanned-banner')).toBeTruthy();
    });

    it('does not mark a checked document, or a skipped one, as unchecked', async () => {
        knowledgeApi.listSourceDocuments.mockResolvedValue({
            documents: [
                doc({ id: 'a', status: 'processed', pii_status: 'none' }),
                doc({ id: 'b', status: 'redacted', pii_status: 'redacted' }),
                // A skipped row already says why in its own status; a second
                // amber badge beside it is noise.
                doc({ id: 'c', status: 'skipped', pii_status: 'unscanned', status_reason: 'Checking unavailable' }),
            ],
            total: 3,
        });
        render(<SourceDetail kbId="kb1" source={SOURCE} />);
        await waitFor(() => expect(screen.getAllByTestId('kb-doc-row')).toHaveLength(3));
        expect(screen.queryByTestId('kb-doc-unscanned')).toBeNull();
        expect(screen.queryByTestId('kb-unscanned-banner')).toBeNull();
    });

    it('offers the per-row menu only to someone who can manage', async () => {
        const { unmount } = render(<SourceDetail kbId="kb1" source={SOURCE} canManage={false} />);
        await screen.findByTestId('kb-doc-row');
        expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
        unmount();
        render(<SourceDetail kbId="kb1" source={SOURCE} canManage />);
        await screen.findByTestId('kb-doc-row');
        expect(screen.getByRole('button', { name: 'Actions for Terms 2026.pdf' })).toBeTruthy();
    });
});

describe('statusOfDoc', () => {
    it('reads a parked upload as processing, not as skipped', () => {
        // The upload route parks a new row as `skipped` + "Queued for
        // processing" because `processing` is not a documents.status value.
        // Reading only the status would show a fresh upload as a failure.
        const parked = { status: 'skipped', status_reason: 'Queued for processing' };
        expect(isPending(parked)).toBe(true);
        expect(statusOfDoc(parked).key).toBe('knowledge.docs.status_processing');
        expect(statusOfDoc({ status: 'skipped', status_reason: 'No readable text found' }).key)
            .toBe('knowledge.docs.status_skipped');
    });

    it('maps every status the server can store', () => {
        expect(statusOfDoc({ status: 'processed' }).key).toBe('knowledge.docs.status_processed');
        expect(statusOfDoc({ status: 'redacted' }).key).toBe('knowledge.docs.status_redacted');
        expect(statusOfDoc({ status: 'error' }).key).toBe('knowledge.docs.status_error');
        expect(statusOfDoc({ status: 'duplicate' }).key).toBe('knowledge.docs.status_duplicate');
        expect(statusOfDoc({}).key).toBe('knowledge.docs.status_processed');
    });
});
