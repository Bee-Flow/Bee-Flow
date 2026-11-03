/**
 * The end of the journey (tests-and-docs F11, pauses F12): a journey that ends
 * on a closing page shows that page as the visitor sees it (the public page's
 * FormEndingView), with "See what each step did"; the answers can be kept as a
 * scenario after any journey that answered a page here, also one that failed
 * or was stopped, and never after one that answered nothing here.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { fakeServer } from '@/test/formRunServer';
import FormRunOverlay from './FormRunOverlay';

const FORM = {
    title: 'Request', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: {},
    fields: [{ name: 'city', type: 'text', label: 'City', required: true, placeholder: '', help: '' }],
};
const ENDING = { title: 'Thanks, Ada', description: 'Your request **R-12** is in.', submitLabel: '', successMessage: '', theme: {}, fields: [] };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function endsAs(state: Record<string, unknown>) {
    return fakeServer((call) => (call.path.endsWith('/form') ? { body: { runId: 'r1', waiting: false, ...state } } : null));
}

async function answerPageOne(onClose = vi.fn()) {
    const user = userEvent.setup();
    const onStartRun = vi.fn(async () => ({ kind: 'started' as const, runId: 'r1' }));
    render(withQueryClient(<FormRunOverlay automationId="a1" form={FORM} onStartRun={onStartRun} onClose={onClose} />));
    await user.type(screen.getByLabelText(/City/), 'Utrecht');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    return { user, onClose };
}

describe('FormRunOverlay — the end of the journey', () => {
    it('shows the closing page as the visitor sees it, and what each step did', async () => {
        endsAs({ status: 'success', ending: ENDING });
        const { user, onClose } = await answerPageOne();
        const ending = await screen.findByTestId('form-ending');
        expect(ending.textContent).toContain('Thanks, Ada');
        expect(ending.textContent).toContain('R-12');
        expect(screen.queryByText('The automation finished.')).toBeNull();
        expect(screen.getByRole('button', { name: 'Save these answers as a scenario' })).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'See what each step did' }));
        expect(onClose).toHaveBeenCalledWith({});
    });

    it('without a closing page it says the automation finished', async () => {
        endsAs({ status: 'success', ending: null });
        await answerPageOne();
        expect(await screen.findByText('The automation finished.')).toBeTruthy();
        expect(screen.queryByTestId('form-ending')).toBeNull();
    });

    it.each([
        ['error', 'Failed'],
        ['cancelled', 'Stopped'],
    ])('a journey that ended as %s still offers to keep the answers typed so far', async (status, label) => {
        endsAs({ status, ending: null });
        const { user } = await answerPageOne();
        expect(await screen.findByText(label)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Save these answers as a scenario' }));
        expect(screen.getByText(/only the pages you answered are kept/)).toBeTruthy();
    });

    it('an attached run that answered nothing here offers no scenario', async () => {
        endsAs({ status: 'success', ending: ENDING });
        render(withQueryClient(<FormRunOverlay automationId="a1" runId="r1" runKind="dry" onStartRun={vi.fn()} onClose={vi.fn()} />));
        expect(await screen.findByTestId('form-ending')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Save these answers as a scenario' })).toBeNull();
    });
});
