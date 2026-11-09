import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DownloadOriginalButton, OpenInCloudLink } from './OriginalActions';
import toast from '@/components/shared/Toast';

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('DownloadOriginalButton', () => {
    it('downloads the original of that document', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue(new Response('pdf', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="Terms 2026.pdf"' } }));
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        render(<DownloadOriginalButton kbId="kb1" docId="d1" name="Terms.pdf" />);
        await user.click(screen.getByRole('button', { name: 'Download original of Terms.pdf' }));
        await waitFor(() => expect(click).toHaveBeenCalled());
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/kb\/kb1\/documents\/d1\/original$/);
        expect(click.mock.contexts[0]).toHaveProperty('download', 'Terms 2026.pdf');
    });

    it('says so in a toast when the original is gone', async () => {
        const user = userEvent.setup();
        const spy = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'nope', code: 'no_original' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
        render(<DownloadOriginalButton kbId="kb1" docId="d1" name="Terms.pdf" variant="text" />);
        await user.click(screen.getByRole('button', { name: 'Download original' }));
        await waitFor(() => expect(spy).toHaveBeenCalledWith('The original file was not kept for this document.'));
    });
});

describe('OpenInCloudLink', () => {
    it('opens the file in its cloud in a new tab, without an opener', () => {
        render(<OpenInCloudLink url="https://cloud.example/f/1" provider="nextcloud_files" name="Terms.pdf" />);
        const a = screen.getByRole('link', { name: 'Open Terms.pdf in Nextcloud' });
        expect(a.getAttribute('href')).toBe('https://cloud.example/f/1');
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toContain('noopener');
    });
});
