import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { authFetch } from '@/utils/helpers';
import { generatedFilesOf, previewKindOf } from '@/api/queries/automation/runFiles';
import RunFileChips from './RunFileChips';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const kept = (over: Record<string, unknown> = {}) => ({
    fileId: 'file-1', filename: 'Quote-001.pdf', mimeType: 'application/pdf', size: 2048, format: 'pdf',
    sourceHandle: { kind: 'generated_file', fileId: 'file-1' }, ...over,
});

let urls: string[] = [];
let anchorClicks: Array<{ href: string; download: string }> = [];

function bytes(headers: Record<string, string> = {}, ok = true, status = 200) {
    return Promise.resolve({ ok, status, headers: new Headers(headers), blob: async () => new Blob(['x']), json: async () => ({}) } as unknown as Response);
}

beforeEach(() => {
    urls = [];
    anchorClicks = [];
    vi.mocked(authFetch).mockImplementation((url: string) => {
        urls.push(url);
        return bytes(/preview\?page=/.test(url) ? { 'X-Preview-Total-Pages': '3' } : {});
    });
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
        anchorClicks.push({ href: this.href, download: this.download });
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('generatedFilesOf', () => {
    it('reads the handle of a document step', () => {
        expect(generatedFilesOf(kept())).toEqual([{ fileId: 'file-1', name: 'Quote-001.pdf', mime: 'application/pdf', size: 2048 }]);
    });

    it('finds files inside a list or record, once each, and skips a dry run placeholder', () => {
        const out = { rounds: [kept(), kept({ fileId: 'file-2', filename: 'b.png', mimeType: 'image/png', sourceHandle: { kind: 'generated_file', fileId: 'file-2' } }), kept()] };
        expect(generatedFilesOf(out).map(f => f.fileId)).toEqual(['file-1', 'file-2']);
        expect(generatedFilesOf(kept({ sourceHandle: { kind: 'generated_file', fileId: 'dry-run' } }))).toEqual([]);
    });

    it('ignores other handles and plain values', () => {
        expect(generatedFilesOf({ sourceHandle: { kind: 'gmail_attachment', fileId: 'x' } })).toEqual([]);
        expect(generatedFilesOf('text')).toEqual([]);
        expect(generatedFilesOf(null)).toEqual([]);
    });

    it('previews a PDF and raster images, never an SVG or an office file', () => {
        expect(previewKindOf('application/pdf')).toBe('pdf');
        expect(previewKindOf('image/png')).toBe('image');
        expect(previewKindOf('image/svg+xml')).toBeNull();
        expect(previewKindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull();
    });
});

describe('the file chip', () => {
    it('shows name and size, and nothing for a step that kept no file', () => {
        const { container, rerender } = render(<RunFileChips runId="run-1" output={kept()} />);
        const chip = screen.getByTestId('run-file-chip');
        expect(chip.textContent).toContain('Quote-001.pdf');
        expect(chip.textContent).toContain('2.0 KB');
        rerender(<RunFileChips runId="run-1" output={{ ok: true }} />);
        expect(container.textContent).toBe('');
    });

    it('offers Preview for a PDF and an image, not for other files', () => {
        const { rerender } = render(<RunFileChips runId="run-1" output={kept()} />);
        expect(screen.getByRole('button', { name: 'Preview Quote-001.pdf' })).toBeTruthy();
        rerender(<RunFileChips runId="run-1" output={kept({ filename: 'photo.jpg', mimeType: 'image/jpeg' })} />);
        expect(screen.getByRole('button', { name: 'Preview photo.jpg' })).toBeTruthy();
        rerender(<RunFileChips runId="run-1" output={kept({ filename: 'Quote.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })} />);
        expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Download Quote.docx' })).toBeTruthy();
    });

    it('downloads from the run file route with the session, under the file name', async () => {
        const user = userEvent.setup();
        render(<RunFileChips runId="run-1" output={kept()} />);
        await user.click(screen.getByRole('button', { name: 'Download Quote-001.pdf' }));
        await waitFor(() => expect(anchorClicks).toHaveLength(1));
        expect(urls).toEqual(['/api/automation/runs/run-1/files/file-1']);
        expect(anchorClicks[0].download).toBe('Quote-001.pdf');
    });

    it('says so when the file is gone', async () => {
        vi.mocked(authFetch).mockImplementation(() => Promise.resolve({
            ok: false, status: 404, headers: new Headers(), json: async () => ({ error: 'gone', code: 'run_file_not_found' }),
        } as unknown as Response));
        const user = userEvent.setup();
        render(<RunFileChips runId="run-1" output={kept()} />);
        await user.click(screen.getByRole('button', { name: 'Download Quote-001.pdf' }));
        expect((await screen.findByRole('alert')).textContent).toContain('Could not download this file');
        expect(anchorClicks).toHaveLength(0);
    });

    it('previews a PDF page by page', async () => {
        const user = userEvent.setup();
        render(<RunFileChips runId="run-1" output={kept()} />);
        await user.click(screen.getByRole('button', { name: 'Preview Quote-001.pdf' }));
        expect(await screen.findByText('Page 1 of 3')).toBeTruthy();
        expect(urls).toContain('/api/automation/runs/run-1/files/file-1/preview?page=1');
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        expect(await screen.findByText('Page 2 of 3')).toBeTruthy();
        expect(urls).toContain('/api/automation/runs/run-1/files/file-1/preview?page=2');
    });

    it('holds the pager to the server\'s preview cap', async () => {
        vi.mocked(authFetch).mockImplementation((url: string) => {
            urls.push(url);
            return bytes(/preview\?page=/.test(url) ? { 'X-Preview-Total-Pages': '60', 'X-Preview-Max-Pages': '2' } : {});
        });
        const user = userEvent.setup();
        render(<RunFileChips runId="run-1" output={kept()} />);
        await user.click(screen.getByRole('button', { name: 'Preview Quote-001.pdf' }));
        expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        expect(await screen.findByText('Page 2 of 2')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('previews an image inline, and tells when previews are off', async () => {
        const user = userEvent.setup();
        render(<RunFileChips runId="run-1" output={kept({ filename: 'photo.png', mimeType: 'image/png' })} />);
        await user.click(screen.getByRole('button', { name: 'Preview photo.png' }));
        await waitFor(() => expect(urls).toContain('/api/automation/runs/run-1/files/file-1?inline=1'));
        cleanup();

        vi.mocked(authFetch).mockImplementation(() => Promise.resolve({
            ok: false, status: 503, headers: new Headers(), json: async () => ({ error: 'off', code: 'preview_unavailable' }),
        } as unknown as Response));
        render(<RunFileChips runId="run-1" output={kept()} />);
        await user.click(screen.getByRole('button', { name: 'Preview Quote-001.pdf' }));
        expect((await screen.findByRole('alert')).textContent).toContain('Previews are not available');
    });
});
