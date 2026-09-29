/**
 * The `download` field — the routine handing a document back.
 *
 * It is the first field type that GIVES instead of asking, and that is exactly
 * where it can go wrong: every input-shaped code path in the renderer (initial
 * values, the required check, the submitted payload) assumes a field produces
 * an answer. If any of them treats a download as an input, a page carrying one
 * becomes permanently un-submittable — with no error pointing at the cause.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PublicFormRenderer, { FormEndingView } from './PublicFormRenderer';

const DOWNLOAD = {
    name: 'doc',
    type: 'download',
    label: 'Je offerte',
    filename: 'offerte-2026.pdf',
    mimeType: 'application/pdf',
    size: 2_600_000,
    fileId: 'f1',
    required: false,
};

const form = (fields, over = {}) => ({
    title: 'Klaar',
    description: '',
    submitLabel: 'Verstuur',
    theme: {},
    fields,
    ...over,
});

const href = (f) => `/api/automation/form/tok/s/sid/file/${f.fileId}`;

describe('download field — no link to give', () => {
    /**
     * The corrupt-download bug, pinned.
     *
     * `<a href="#" download="test.pdf">` does not fail visibly: the browser
     * saves the CURRENT PAGE under that name. A closing page whose session had
     * already been dropped therefore handed out a 6 KB index.html called
     * test.pdf — Chrome answered "Failed to load PDF document", Word "found
     * unreadable content". Never render a link without a target.
     */
    it('renders no link at all when there is no href', () => {
        render(<FormEndingView form={form([DOWNLOAD])} downloadHref={() => null} />);
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('never emits href="#" — that downloads the page itself', () => {
        const { container } = render(<FormEndingView form={form([DOWNLOAD])} downloadHref={() => null} />);
        for (const a of container.querySelectorAll('a')) {
            expect(a.getAttribute('href')).not.toBe('#');
        }
        expect(container.querySelector('[download]')).toBeNull();
    });

    it('still shows the file it means, so the card does not vanish', () => {
        render(<FormEndingView form={form([DOWNLOAD])} downloadHref={() => null} />);
        expect(screen.getByTestId('form-download-doc')).toBeTruthy();
        expect(screen.getByText('offerte-2026.pdf')).toBeTruthy();
    });

    it('renders no link when the ending view is given no href builder at all', () => {
        // The builder preview takes this path.
        render(<FormEndingView form={form([DOWNLOAD])} />);
        expect(screen.queryByRole('link')).toBeNull();
    });
});

describe('download field', () => {
    it('shows the filename, type and size, and links to the file', () => {
        render(<PublicFormRenderer form={form([DOWNLOAD])} downloadHref={href} />);
        const link = screen.getByRole('link');
        expect(link.getAttribute('href')).toBe('/api/automation/form/tok/s/sid/file/f1');
        expect(link.getAttribute('download')).toBe('offerte-2026.pdf');
        expect(screen.getByText('offerte-2026.pdf')).toBeTruthy();
        expect(screen.getByText('PDF · 2.5 MB')).toBeTruthy();
        expect(screen.getByText('Je offerte')).toBeTruthy();
    });

    it('never becomes part of the submission', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(
            <PublicFormRenderer
                form={form([DOWNLOAD, { name: 'naam', type: 'text', label: 'Naam', required: false }])}
                onSubmit={onSubmit}
                downloadHref={href}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        const values = onSubmit.mock.calls[0][0];
        expect(values).not.toHaveProperty('doc');
        expect(values).toHaveProperty('naam');
    });

    it('a page that is ONLY a download can still be submitted', async () => {
        // The regression that matters: if the required check or initialValues
        // treated this as an input, the button would silently do nothing.
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(<PublicFormRenderer form={form([DOWNLOAD])} onSubmit={onSubmit} downloadHref={href} />);
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    });

    it('a required flag on it is ignored rather than blocking the form', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(
            <PublicFormRenderer
                form={form([{ ...DOWNLOAD, required: true }])}
                onSubmit={onSubmit}
                downloadHref={href}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    });

    it('renders on the closing page, which is where a document usually lands', () => {
        render(<FormEndingView form={form([DOWNLOAD], { title: 'Klaar!' })} downloadHref={href} />);
        expect(screen.getByRole('link').getAttribute('href')).toContain('/file/f1');
        expect(screen.getByText('offerte-2026.pdf')).toBeTruthy();
    });

    it('the closing page shows no INPUT fields — nothing there could submit them', () => {
        render(
            <FormEndingView
                form={form([DOWNLOAD, { name: 'naam', type: 'text', label: 'Naam' }], { title: 'Klaar!' })}
                downloadHref={href}
            />,
        );
        expect(screen.queryByLabelText('Naam')).toBeNull();
        expect(screen.getByText('offerte-2026.pdf')).toBeTruthy();
    });

    it('sizes read the way a person would say them', () => {
        const sizes = [
            [900, '900 B'],
            [2048, '2 kB'],
            [2_600_000, '2.5 MB'],
        ];
        for (const [size, expected] of sizes) {
            const { unmount } = render(
                <PublicFormRenderer form={form([{ ...DOWNLOAD, size }])} downloadHref={href} />,
            );
            expect(screen.getByText(`PDF · ${expected}`)).toBeTruthy();
            unmount();
        }
    });
});
