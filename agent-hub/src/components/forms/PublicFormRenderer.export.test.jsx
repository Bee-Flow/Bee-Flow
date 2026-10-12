/**
 * The export bar on a closing page — BFSF-419, Track 1's generic fallback.
 *
 * Most automations never take a `generate_document` step: their whole "result"
 * is markdown sitting in `form.description` (a blog post, a summary), with
 * no download/notebook field wired at all, because the author never added
 * one. Before this bar, closing the tab lost that text for good. It has to
 * work independently of any download/notebook field, since the common case
 * has neither.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { FormEndingView } from './PublicFormRenderer';

const LONG_TEXT = '## Waterstralen\n\n' + 'Een lange alinea over een SEO-blog. '.repeat(20);
const form = (description, over = {}) => ({ title: 'Klaar', description, theme: {}, ...over });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('export bar — visibility', () => {
    it('appears for a real result, independent of any download/notebook field', () => {
        render(<FormEndingView form={form(LONG_TEXT)} />);
        expect(screen.getByTestId('form-export-bar')).toBeTruthy();
    });

    it('does not clutter a short closing like "Thanks!"', () => {
        render(<FormEndingView form={form('Bedankt!')} />);
        expect(screen.queryByTestId('form-export-bar')).toBeNull();
    });

    it('does not appear with no description at all', () => {
        render(<FormEndingView form={{ title: 'Bedankt', theme: {} }} />);
        expect(screen.queryByTestId('form-export-bar')).toBeNull();
    });
});

describe('export bar — Download as .txt', () => {
    it('builds a Blob and revokes it — never an <a href> at a real endpoint', async () => {
        const createObjectURL = vi.fn(() => 'blob:fake');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

        render(<FormEndingView form={form(LONG_TEXT, { title: 'Mijn SEO-blog' })} />);
        fireEvent.click(screen.getByTestId('form-export-download'));

        expect(createObjectURL).toHaveBeenCalledTimes(1);
        const blob = createObjectURL.mock.calls[0][0];
        expect(blob.type).toContain('text/plain');
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
        // No stray anchor left mounted after the click.
        expect(document.querySelector('a[download]')).toBeNull();
    });

    it('ships the raw markdown as-is, syntax and all — no stripping', async () => {
        let captured = null;
        const originalBlob = globalThis.Blob;
        vi.stubGlobal('Blob', class extends originalBlob {
            constructor(parts, opts) { super(parts, opts); captured = parts[0]; }
        });
        vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });

        render(<FormEndingView form={form(LONG_TEXT)} />);
        fireEvent.click(screen.getByTestId('form-export-download'));

        expect(captured).toBe(LONG_TEXT);
    });
});

describe('export bar — Copy text', () => {
    it('copies the raw description to the clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

        render(<FormEndingView form={form(LONG_TEXT)} />);
        fireEvent.click(screen.getByTestId('form-export-copy'));

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(LONG_TEXT));
        expect(await screen.findByText('Copied')).toBeTruthy();
    });

    it('a denied clipboard leaves the button as it was, rather than crashing', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('denied'));
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

        render(<FormEndingView form={form(LONG_TEXT)} />);
        fireEvent.click(screen.getByTestId('form-export-copy'));

        await waitFor(() => expect(writeText).toHaveBeenCalled());
        expect(screen.queryByText('Copied')).toBeNull();
        expect(screen.getByText('Copy text')).toBeTruthy();
    });
});

describe('export bar — Save to Notebook', () => {
    it('is absent with no handler — the same "no opener, no button" rule the file-based button follows', () => {
        render(<FormEndingView form={form(LONG_TEXT)} />);
        expect(screen.queryByTestId('form-export-notebook')).toBeNull();
    });

    it('hands off to the caller when pressed, and stays disabled through a successful save', async () => {
        let resolve;
        const onSaveToNotebook = vi.fn(() => new Promise(r => { resolve = r; }));
        render(<FormEndingView form={form(LONG_TEXT)} onSaveToNotebook={onSaveToNotebook} />);

        const button = screen.getByTestId('form-export-notebook');
        fireEvent.click(button);
        await waitFor(() => expect(onSaveToNotebook).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(button.disabled).toBe(true));

        resolve();
        // No re-enable on success — mirrors "Open in Notebooks": the page is
        // about to navigate away, and a button that re-enables first reads as
        // "nothing happened, press again".
        await waitFor(() => expect(button.disabled).toBe(true));
    });

    it('shows what went wrong and lets the visitor try again', async () => {
        const onSaveToNotebook = vi.fn().mockRejectedValue(new Error('Could not save this to Notebooks.'));
        render(<FormEndingView form={form(LONG_TEXT)} onSaveToNotebook={onSaveToNotebook} />);

        const button = screen.getByTestId('form-export-notebook');
        fireEvent.click(button);
        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Could not save/));
        expect(button.disabled).toBe(false);
    });

    it('does not fire twice while the first press is still going', async () => {
        const onSaveToNotebook = vi.fn(() => new Promise(() => {}));
        render(<FormEndingView form={form(LONG_TEXT)} onSaveToNotebook={onSaveToNotebook} />);

        const button = screen.getByTestId('form-export-notebook');
        fireEvent.click(button);
        fireEvent.click(button);
        await waitFor(() => expect(onSaveToNotebook).toHaveBeenCalledTimes(1));
    });
});

describe('export bar — Word, PDF and Webpage', () => {
    it('are absent without handlers, as in the builder\'s live preview', () => {
        render(<FormEndingView form={form(LONG_TEXT)} />);
        for (const id of ['form-export-docx', 'form-export-pdf', 'form-export-webpage']) {
            expect(screen.queryByTestId(id)).toBeNull();
        }
    });

    it('asks the caller for the format that was pressed', async () => {
        const onDownloadAs = vi.fn().mockResolvedValue(undefined);
        render(<FormEndingView form={form(LONG_TEXT)} onDownloadAs={onDownloadAs} />);

        await userEvent.click(screen.getByTestId('form-export-docx'));
        await userEvent.click(screen.getByTestId('form-export-pdf'));
        expect(onDownloadAs.mock.calls).toEqual([['docx'], ['pdf']]);
    });

    it('frees the bar again after a download, but not after a save that navigates away', async () => {
        const onDownloadAs = vi.fn().mockResolvedValue(undefined);
        const onSaveAsWebpage = vi.fn().mockResolvedValue(undefined);
        render(<FormEndingView form={form(LONG_TEXT)} onDownloadAs={onDownloadAs} onSaveAsWebpage={onSaveAsWebpage} />);

        await userEvent.click(screen.getByTestId('form-export-pdf'));
        await waitFor(() => expect(screen.getByTestId('form-export-pdf').disabled).toBe(false));

        await userEvent.click(screen.getByTestId('form-export-webpage'));
        await waitFor(() => expect(onSaveAsWebpage).toHaveBeenCalledTimes(1));
        expect(screen.getByTestId('form-export-webpage').disabled).toBe(true);
    });

    it('runs one action at a time', async () => {
        const onDownloadAs = vi.fn(() => new Promise(() => {}));
        const onSaveToNotebook = vi.fn();
        render(<FormEndingView form={form(LONG_TEXT)} onDownloadAs={onDownloadAs} onSaveToNotebook={onSaveToNotebook} />);

        await userEvent.click(screen.getByTestId('form-export-docx'));
        await userEvent.click(screen.getByTestId('form-export-notebook'));
        expect(onDownloadAs).toHaveBeenCalledTimes(1);
        expect(onSaveToNotebook).not.toHaveBeenCalled();
    });

    it('says what went wrong with a webpage save', async () => {
        const onSaveAsWebpage = vi.fn().mockRejectedValue(new Error('Could not save this as a webpage.'));
        render(<FormEndingView form={form(LONG_TEXT)} onSaveAsWebpage={onSaveAsWebpage} />);

        await userEvent.click(screen.getByTestId('form-export-webpage'));
        expect((await screen.findByRole('alert')).textContent).toMatch(/as a webpage/);
        expect(screen.getByTestId('form-export-webpage').disabled).toBe(false);
    });
});
