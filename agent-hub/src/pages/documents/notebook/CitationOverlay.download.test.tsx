import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CitationOverlay from './CitationOverlay';

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('pdf', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CitationOverlay download', () => {
    const base = { title: 'Q3 report', content: 'Revenue grew.', index: 1 };

    it('offers the original when the answer says the file was kept', async () => {
        const user = userEvent.setup();
        render(<CitationOverlay source={{ ...base, kbId: 'kb1', documentId: 'd7', hasOriginal: true }} onClose={() => {}} />);
        await user.click(screen.getByRole('button', { name: 'Download original' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/kb\/kb1\/documents\/d7\/original$/);
    });

    it('offers nothing without hasOriginal or without a knowledge base', () => {
        const { rerender } = render(<CitationOverlay source={{ ...base, kbId: 'kb1', documentId: 'd7', hasOriginal: false }} onClose={() => {}} />);
        expect(screen.queryByRole('button', { name: 'Download original' })).toBeNull();
        rerender(<CitationOverlay source={{ ...base, documentId: 'd7', hasOriginal: true }} onClose={() => {}} />);
        expect(screen.queryByRole('button', { name: 'Download original' })).toBeNull();
    });
});
