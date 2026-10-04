/**
 * The `app_pick` field — a question answered by picking a record in an app.
 *
 * Two things are pinned here. First, that the SUBMISSION carries a reference
 * and nothing else: the server re-reads the record as the person submitting,
 * so any content the browser sent would be content the server never asked for.
 * Second, that a question taking several records behaves like a list all the
 * way through — empty is `[]`, not `''`, or an automation that loops over the
 * answer loops over nothing.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PublicFormRenderer from './PublicFormRenderer';

const CALL = {
    name: 'call',
    type: 'app_pick',
    label: 'Welk gesprek?',
    source: 'fireflies_transcript',
    app: 'Fireflies',
    sourceLabel: 'Fireflies meeting transcript',
    searchHint: 'Zoek je Fireflies-meetings',
    multiple: false,
    maxItems: 1,
    withText: true,
    required: false,
};

const form = (fields) => ({
    title: 'Verslag',
    description: '',
    submitLabel: 'Verstuur',
    successMessage: 'Dank je',
    theme: {},
    fields,
});

const results = [
    { id: 'tr_1', title: 'Kickoff met Acme', subtitle: '2026-09-01 · 45 min' },
    { id: 'tr_2', title: 'Retro', subtitle: '2026-09-08 · 30 min' },
];

function renderForm(fields, { onSearchApp = vi.fn(async () => ({ results })), onSubmit = vi.fn(async () => {}) } = {}) {
    render(<PublicFormRenderer form={form(fields)} onSubmit={onSubmit} onSearchApp={onSearchApp} />);
    return { onSearchApp, onSubmit };
}

/** Open the picker and wait for its first (debounced) search to land. */
async function openPicker(label = 'Kies uit Fireflies') {
    fireEvent.click(screen.getByRole('button', { name: /Fireflies/ }));
    await waitFor(() => expect(screen.getByText('Kickoff met Acme')).toBeInTheDocument());
}

describe('app_pick — picking a record', () => {
    it('searches the app the question names, passing the field and the typed term', async () => {
        const { onSearchApp } = renderForm([CALL]);
        await openPicker();
        // The browser sends a FIELD, never an app and never a tool — which app
        // that is, is the declaration's business and the server's.
        expect(onSearchApp).toHaveBeenCalled();
        const [field, query] = onSearchApp.mock.calls[0];
        expect(field.name).toBe('call');
        expect(query).toBe('');

        fireEvent.change(screen.getByLabelText('Search Fireflies'), { target: { value: 'kickoff' } });
        await waitFor(() => expect(onSearchApp.mock.calls.at(-1)[1]).toBe('kickoff'));
    });

    it('submits a reference, never content', async () => {
        const { onSubmit } = renderForm([CALL]);
        await openPicker();
        fireEvent.click(screen.getByText('Kickoff met Acme'));
        await waitFor(() => expect(screen.queryByLabelText('Search Fireflies')).not.toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].call).toEqual({
            kind: 'app_pick', source: 'fireflies_transcript', recordId: 'tr_1', title: 'Kickoff met Acme',
        });
    });

    it('a chosen record can be taken back off', async () => {
        const { onSubmit } = renderForm([CALL]);
        await openPicker();
        fireEvent.click(screen.getByText('Kickoff met Acme'));
        await waitFor(() => expect(screen.getByLabelText('Remove Kickoff met Acme')).toBeInTheDocument());
        fireEvent.click(screen.getByLabelText('Remove Kickoff met Acme'));
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].call).toBeNull();
    });

    it('an unanswered required pick is caught before anything is sent', async () => {
        const { onSubmit } = renderForm([{ ...CALL, required: true }]);
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(screen.getByText(/Welk gesprek\? is required/)).toBeInTheDocument());
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('a refusal from the server is printed beside the box, not thrown at the person', async () => {
        // "Fireflies is not connected for your account" is not their mistake
        // and not a broken form — it is something to read and act on.
        renderForm([CALL], { onSearchApp: vi.fn(async () => ({ results: [], error: 'Fireflies is not connected for your account.' })) });
        fireEvent.click(screen.getByRole('button', { name: /Fireflies/ }));
        await waitFor(() => expect(screen.getByText(/not connected for your account/)).toBeInTheDocument());
    });
});

describe('app_pick — a question that takes several records', () => {
    const MAILS = { ...CALL, name: 'mails', label: 'Welke mails?', source: 'gmail_message', app: 'Gmail', multiple: true, maxItems: 2 };

    it('an unanswered multiple pick submits an empty LIST, so a loop over it is valid', async () => {
        const { onSubmit } = renderForm([MAILS]);
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].mails).toEqual([]);
    });

    it('collects up to its maximum and then stops offering more', async () => {
        const { onSubmit } = renderForm([MAILS]);
        fireEvent.click(screen.getByRole('button', { name: /Gmail/ }));
        await waitFor(() => expect(screen.getByText('Kickoff met Acme')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Kickoff met Acme'));
        // The picker stays open for a multiple question.
        await waitFor(() => expect(screen.getByText('Retro')).toBeInTheDocument());
        fireEvent.click(screen.getByText('Retro'));

        await waitFor(() => expect(screen.queryByLabelText('Search Gmail')).not.toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Add another/ })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        expect(onSubmit.mock.calls[0][0].mails.map(p => p.recordId)).toEqual(['tr_1', 'tr_2']);
    });
});
