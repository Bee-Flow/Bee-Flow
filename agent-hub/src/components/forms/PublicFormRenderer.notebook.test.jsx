/**
 * The `notebook` field — "Open in Notebooks" on a closing page.
 *
 * It is the download's twin: the same generated file, the same slot in the
 * author's page, the same "gives instead of asks" shape that every input-shaped
 * code path has to step over. What differs is that opening is a WRITE — the
 * server makes a notebook before there is anywhere to go — so this one is a
 * button that can fail, not a link.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PublicFormRenderer, { FormEndingView } from './PublicFormRenderer';

const NOTEBOOK = {
    name: 'doc',
    type: 'notebook',
    label: 'Werk verder in Notebooks',
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

const button = () => screen.getByTestId('form-notebook-doc').querySelector('button');

describe('notebook field', () => {
    it('offers the document by name, on the closing page', () => {
        render(<FormEndingView form={form([NOTEBOOK])} onOpenInNotebooks={vi.fn()} />);
        expect(screen.getByText('Werk verder in Notebooks')).toBeTruthy();
        expect(screen.getByText('offerte-2026.pdf')).toBeTruthy();
    });

    it('hands the field to the opener when pressed', async () => {
        const onOpenInNotebooks = vi.fn().mockResolvedValue(undefined);
        render(<FormEndingView form={form([NOTEBOOK])} onOpenInNotebooks={onOpenInNotebooks} />);
        fireEvent.click(button());
        await waitFor(() => expect(onOpenInNotebooks).toHaveBeenCalledTimes(1));
        expect(onOpenInNotebooks.mock.calls[0][0].fileId).toBe('f1');
    });

    it('says it is working, and stays that way while the page navigates', async () => {
        // No flipping back on success: the browser is leaving, and a button
        // that re-enables first reads as "nothing happened, press again".
        let resolve;
        const onOpenInNotebooks = vi.fn(() => new Promise(r => { resolve = r; }));
        render(<FormEndingView form={form([NOTEBOOK])} onOpenInNotebooks={onOpenInNotebooks} />);
        fireEvent.click(button());
        await waitFor(() => expect(screen.getByText(/Opening in Notebooks/)).toBeTruthy());
        expect(button().disabled).toBe(true);
        resolve();
        await waitFor(() => expect(button().disabled).toBe(true));
    });

    it('does not fire twice while the first press is still going', async () => {
        const onOpenInNotebooks = vi.fn(() => new Promise(() => {}));
        render(<FormEndingView form={form([NOTEBOOK])} onOpenInNotebooks={onOpenInNotebooks} />);
        fireEvent.click(button());
        fireEvent.click(button());
        await waitFor(() => expect(onOpenInNotebooks).toHaveBeenCalledTimes(1));
    });

    it('shows what went wrong and lets the visitor try again', async () => {
        const onOpenInNotebooks = vi.fn().mockRejectedValue(new Error('Could not open this in Notebooks.'));
        render(<FormEndingView form={form([NOTEBOOK])} onOpenInNotebooks={onOpenInNotebooks} />);
        fireEvent.click(button());
        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Could not open/));
        expect(button().disabled).toBe(false);
    });

    it('is inert with no opener — the builder preview must not make notebooks', () => {
        render(<FormEndingView form={form([NOTEBOOK])} />);
        expect(button().disabled).toBe(true);
    });

    /**
     * The same trap the download field has: a field that GIVES must never be
     * treated as one that asks, or a page carrying it cannot be submitted.
     */
    it('is never required, never submitted, and never blocks the form', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        render(
            <PublicFormRenderer
                form={form([{ ...NOTEBOOK, required: true }, { name: 'email', type: 'email', label: 'E-mail', required: false }])}
                onSubmit={onSubmit}
                onOpenInNotebooks={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('doc');
    });
});
