/**
 * Page one is a dry run unless asked otherwise (D1, RUN-04): the page's own
 * button starts a dry run and the chip says so; "Run for real" starts a live
 * test. The Run live confirm is the SHELL's, asked once per overlay session
 * (useBuilderRuns.formTriggers.test.ts); the overlay never asks a second time
 * and never lets the other mode stick to the next submit.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { fakeServer } from '@/test/formRunServer';
import FormRunOverlay from './FormRunOverlay';
import type { FormRunStart } from './formRunContract';

const FORM = {
    title: 'Request', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: {},
    fields: [{ name: 'city', type: 'text', label: 'City', required: true, placeholder: '', help: '' }],
};

beforeEach(() => {
    fakeServer((call) => (call.path.endsWith('/form') ? { body: { runId: 'r1', status: 'running', waiting: false } } : null));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderOverlay(props: Partial<ComponentProps<typeof FormRunOverlay>> = {}) {
    const onStartRun = vi.fn<FormRunStart>(async () => ({ kind: 'started', runId: 'r1' }));
    render(withQueryClient(<FormRunOverlay automationId="a1" form={FORM} onStartRun={onStartRun} onClose={vi.fn()} followTiming={{ intervalMs: 50 }} {...props} />));
    return onStartRun;
}

describe('FormRunOverlay — dry by default', () => {
    it('the page\'s own button starts a dry run, and the chip and the hint say so', async () => {
        const user = userEvent.setup();
        const onStartRun = renderOverlay();
        expect(screen.getByTestId('form-run-chip').textContent).toBe('Dry run');
        expect(screen.getByText(/starts a dry run/)).toBeTruthy();
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(onStartRun).toHaveBeenCalledWith({ city: 'Utrecht' }, { mode: 'dry' }));
    });

    it('"Run for real" starts a live test, and the chip follows', async () => {
        const user = userEvent.setup();
        const onStartRun = renderOverlay();
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Run for real' }));
        await waitFor(() => expect(onStartRun).toHaveBeenCalledWith({ city: 'Utrecht' }, { mode: 'live' }));
        await waitFor(() => expect(screen.getByTestId('form-run-chip').textContent).toBe('Live test'));
    });

    it('asks once: a "no" to the shell\'s confirm keeps the page, and the next plain submit is dry again', async () => {
        const user = userEvent.setup();
        // The shell's confirm, as useBuilderRuns asks it: once per overlay session, here answered no.
        const confirm = vi.fn(async () => false);
        const onStartRun = vi.fn<FormRunStart>(async (_answers, { mode }) => {
            if (mode === 'live' && !await confirm()) return { kind: 'declined' };
            return { kind: 'started', runId: 'r1' };
        });
        renderOverlay({ onStartRun });
        await user.type(screen.getByLabelText(/City/), 'Utrecht');
        await user.click(screen.getByRole('button', { name: 'Run for real' }));
        await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
        // Declined: the answers are still on the page, and nothing else asked.
        expect((screen.getByLabelText(/City/) as HTMLInputElement).value).toBe('Utrecht');

        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(onStartRun).toHaveBeenLastCalledWith({ city: 'Utrecht' }, { mode: 'dry' }));
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('a "Run for real" the page refuses (a required question) does not make the next submit live', async () => {
        const user = userEvent.setup();
        const onStartRun = renderOverlay();
        await user.click(screen.getByRole('button', { name: 'Run for real' }));
        expect(onStartRun).not.toHaveBeenCalled();
        await user.type(screen.getByLabelText(/City/), 'Leiden');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(onStartRun).toHaveBeenCalledWith({ city: 'Leiden' }, { mode: 'dry' }));
    });

    it('opened from Run live: the page starts the live test, and "Dry run instead" is the other way', async () => {
        const user = userEvent.setup();
        const onStartRun = renderOverlay({ startMode: 'live' });
        expect(screen.getByTestId('form-run-chip').textContent).toBe('Live test');
        expect(screen.getByText(/runs the automation for real/)).toBeTruthy();
        await user.type(screen.getByLabelText(/City/), 'Delft');
        await user.click(screen.getByRole('button', { name: 'Dry run instead' }));
        await waitFor(() => expect(onStartRun).toHaveBeenCalledWith({ city: 'Delft' }, { mode: 'dry' }));
        await waitFor(() => expect(screen.getByTestId('form-run-chip').textContent).toBe('Dry run'));
    });
});
