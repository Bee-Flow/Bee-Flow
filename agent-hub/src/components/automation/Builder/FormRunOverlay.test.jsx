/**
 * The form-test overlay — filling a form-triggered routine's own page in, over
 * the canvas, and following the run through whatever it pauses on next.
 *
 * What is pinned here is the JOURNEY: page one comes from the declaration being
 * edited, page two comes from the paused run, and the answers to each go to a
 * different place. Getting that wrong is invisible until a multi-page form is
 * tested, which is exactly when nobody is watching the network tab.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../api/client', () => ({ default: { get: (...a) => get(...a), post: (...a) => post(...a) } }));

import FormRunOverlay from './FormRunOverlay';

const PAGE_ONE = {
    title: 'Vraag het',
    description: '',
    submitLabel: 'Verstuur',
    successMessage: 'Dank',
    theme: {},
    fields: [{ name: 'naam', type: 'text', label: 'Jouw naam', required: true, placeholder: '', help: '' }],
};
const PAGE_TWO = {
    title: 'Nog één ding',
    description: '',
    submitLabel: 'Ga door',
    successMessage: 'Klaar',
    theme: {},
    fields: [{ name: 'adres', type: 'text', label: 'Je adres', required: true, placeholder: '', help: '' }],
};

function renderOverlay(props = {}) {
    const onStartRun = props.onStartRun || vi.fn(async () => ({ run: { id: 'run1' } }));
    const onClose = vi.fn();
    render(<FormRunOverlay automationId="auto1" form={PAGE_ONE} onStartRun={onStartRun} onClose={onClose} {...props} />);
    return { onStartRun, onClose };
}

const fill = (label, value) => fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value } });

beforeEach(() => { get.mockReset(); post.mockReset(); });
afterEach(cleanup);

describe('FormRunOverlay — page one', () => {
    it('shows the declaration being edited, not something the server stored', async () => {
        renderOverlay();
        expect(screen.getByText('Vraag het')).toBeTruthy();
        expect(screen.getByText(/runs the routine for real/)).toBeTruthy();
        // Page one never asks the server what to render.
        expect(get).not.toHaveBeenCalled();
    });

    it('submits the answers as the run, with the honeypot stripped', async () => {
        get.mockResolvedValue({ runId: 'run1', status: 'success', waiting: false });
        const { onStartRun } = renderOverlay();
        fill('Jouw naam', 'Tom');
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));

        await waitFor(() => expect(onStartRun).toHaveBeenCalled());
        const answers = onStartRun.mock.calls[0][0];
        expect(answers).toEqual({ naam: 'Tom' });
        // The honeypot is anti-bot plumbing, never an answer the next steps map against.
        expect('website_url' in answers).toBe(false);
    });

    it('says the routine finished once the run ends', async () => {
        get.mockResolvedValue({ runId: 'run1', status: 'success', waiting: false });
        renderOverlay();
        fill('Jouw naam', 'Tom');
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(screen.getByText('The routine finished.')).toBeTruthy());
    });

    it('reports a run that ended badly instead of sitting on a spinner', async () => {
        get.mockResolvedValue({ runId: 'run1', status: 'error', waiting: false });
        renderOverlay();
        fill('Jouw naam', 'Tom');
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(screen.getByText(/ended as error/)).toBeTruthy());
    });

    it('surfaces a run that could not be started at all', async () => {
        const onStartRun = vi.fn(async () => { throw new Error('Add a trigger first.'); });
        renderOverlay({ onStartRun });
        fill('Jouw naam', 'Tom');
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(screen.getByText('Add a trigger first.')).toBeTruthy());
    });
});

describe('FormRunOverlay — the rest of the journey', () => {
    it('serves the page the run paused on, and continues the SAME run with it', async () => {
        get.mockResolvedValue({ runId: 'run1', status: 'awaiting_form', waiting: true, stepId: 'fp_2', form: PAGE_TWO });
        post.mockResolvedValue({ accepted: true, run: { id: 'run2' } });
        renderOverlay();

        fill('Jouw naam', 'Tom');
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(screen.getByText('Nog één ding')).toBeTruthy());
        expect(screen.getByText(/paused here and is waiting for an answer/)).toBeTruthy();

        // The second page's answers go to the RUN, not back through the trigger.
        get.mockResolvedValue({ runId: 'run2', status: 'success', waiting: false });
        fill('Je adres', 'Dorpsstraat 1');
        fireEvent.click(screen.getByRole('button', { name: 'Ga door' }));

        await waitFor(() => expect(post).toHaveBeenCalled());
        const [url, body] = post.mock.calls[0];
        expect(url).toBe('/api/automation/runs/run1/form');
        // The step id rides along: a stale overlay must not have page two's
        // answers coerced against page three's declaration.
        expect(body).toEqual({ stepId: 'fp_2', values: { adres: 'Dorpsstraat 1' } });
        await waitFor(() => expect(screen.getByText('The routine finished.')).toBeTruthy());
    });

    it('follows the run into the CHILD it handed off to', async () => {
        get.mockResolvedValue({ runId: 'run1', status: 'awaiting_form', waiting: true, stepId: 'fp_2', form: PAGE_TWO });
        post.mockResolvedValue({ accepted: true, run: { id: 'run2' } });
        renderOverlay();
        fill('Jouw naam', 'Tom');
        fireEvent.click(screen.getByRole('button', { name: 'Verstuur' }));
        await waitFor(() => expect(screen.getByText('Nog één ding')).toBeTruthy());

        get.mockResolvedValue({ runId: 'run2', status: 'success', waiting: false });
        fill('Je adres', 'Dorpsstraat 1');
        fireEvent.click(screen.getByRole('button', { name: 'Ga door' }));

        await waitFor(() => expect(screen.getByText('The routine finished.')).toBeTruthy());
        // Resuming starts a child run; the poll has to follow it, or the
        // overlay waits forever on a parent that finished when it handed off.
        expect(get.mock.calls.at(-1)[0]).toBe('/api/automation/runs/run2/form');
    });
});

describe('FormRunOverlay — the app picker', () => {
    it('searches through the builder\'s own endpoint, by source', async () => {
        // The public picker needs a form token this routine does not have yet,
        // so the overlay uses the owner-scoped one and names the SOURCE.
        post.mockResolvedValue({ results: [{ id: 'tr_1', title: 'Kickoff' }] });
        renderOverlay({
            form: { ...PAGE_ONE, fields: [{ name: 'call', type: 'app_pick', label: 'Welk gesprek?', source: 'fireflies_transcript', app: 'Fireflies', multiple: false, maxItems: 1, required: false, placeholder: '', help: '' }] },
        });
        fireEvent.click(screen.getByRole('button', { name: /Fireflies/ }));
        await waitFor(() => expect(post).toHaveBeenCalled());
        const [url, body] = post.mock.calls[0];
        expect(url).toBe('/api/automation/auto1/form-pick');
        expect(body.source).toBe('fireflies_transcript');
        await waitFor(() => expect(screen.getByText('Kickoff')).toBeTruthy());
    });
});
