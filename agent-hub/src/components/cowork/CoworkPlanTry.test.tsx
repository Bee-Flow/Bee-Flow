// "Try it first" inside the plan card: the button, the try-out step by step, and what each step got or would have
// done. Everything comes in as props, so nothing is mocked.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CoworkPlanTry from './CoworkPlanTry';
import type { CoworkPlanTryProps } from './CoworkPlanTry';
import { englishT as t, supplierRadarTry } from './coworkPlan.fixture';

function renderTry(props: Partial<CoworkPlanTryProps> = {}) {
    const onStart = vi.fn();
    render(<CoworkPlanTry t={t} state={null} onStart={onStart} {...props} />);
    return { onStart };
}

const toneOf = (id: string) => screen.getByTestId(`cowork-plan-try-step-${id}`).getAttribute('data-tone');

describe('CoworkPlanTry', () => {
    it('before a try-out: says what trying does and offers it', async () => {
        const { onStart } = renderTry();
        expect(screen.getByText(/nothing is changed or sent/)).toBeTruthy();
        expect(screen.queryByTestId('cowork-plan-try-result')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Try it first' }));
        expect(onStart).toHaveBeenCalledTimes(1);
    });

    it('cannot be started twice: not while it starts, and not while a try-out is at work', () => {
        renderTry({ starting: true });
        expect(screen.getByRole('button', { name: 'Starting…' })).toHaveProperty('disabled', true);
    });

    it('while it runs: the steps so far, the one at work, and the ones still to come', () => {
        const state = supplierRadarTry({ done: false, status: 'running', durationMs: null });
        state.steps = state.steps.map((s, i) => (i === 1 ? { ...s, status: 'running', durationMs: null } : i > 1 ? { ...s, status: 'pending', durationMs: null, preview: null } : s));
        renderTry({ state });
        expect(screen.getByRole('status').textContent).toContain('Trying the plan…');
        expect([toneOf('mail'), toneOf('orders'), toneOf('overdue'), toneOf('digest')]).toEqual(['ok', 'running', 'pending', 'pending']);
        expect(screen.getByRole('button', { name: 'Trying…' })).toHaveProperty('disabled', true);
    });

    it('when it is over: how many steps ran and were held back, that nothing was changed or sent, and how long it took', () => {
        renderTry({ state: supplierRadarTry() });
        const line = screen.getByRole('status').textContent;
        expect(line).toContain('7 of 7 steps ran, 3 held back. Nothing was changed or sent.');
        expect(line).toContain('4.2 s');
        expect(screen.getByRole('button', { name: 'Try again' })).toHaveProperty('disabled', false);
    });

    it('marks the steps that were held back, and only those', () => {
        renderTry({ state: supplierRadarTry() });
        expect([toneOf('mail'), toneOf('orders'), toneOf('table'), toneOf('draft'), toneOf('digest')]).toEqual(['ok', 'ok', 'held', 'held', 'held']);
        expect(within(screen.getByTestId('cowork-plan-try-step-table')).getAllByText('Held back').length).toBeGreaterThan(0);
        expect(within(screen.getByTestId('cowork-plan-try-step-mail')).queryByText('Held back')).toBeNull();
    });

    it('a step that read shows what it got; a held step shows what it would have changed or sent', () => {
        renderTry({ state: supplierRadarTry() });
        expect(within(screen.getByTestId('cowork-plan-try-step-mail')).getByText('What it got')).toBeTruthy();
        expect(screen.getByTestId('cowork-plan-try-step-mail').textContent).toContain('"messages": 9');
        expect(within(screen.getByTestId('cowork-plan-try-step-table')).getByText('What it would have changed')).toBeTruthy();
        expect(within(screen.getByTestId('cowork-plan-try-step-digest')).getByText('What it would have sent')).toBeTruthy();
        expect(screen.getByTestId('cowork-plan-try-step-draft').textContent).toContain('hoekstra-staal');
        expect(within(screen.getByTestId('cowork-plan-try-step-overdue')).queryByText('What it got')).toBeNull();
    });

    it('a try-out that stopped says why, shows the step that failed, and what it never reached', () => {
        const state = supplierRadarTry({ status: 'error', error: 'The model did not answer.' });
        state.steps = state.steps.map((s, i) => (i === 1 ? { ...s, status: 'error', error: 'The model did not answer.', preview: null } : i > 1 ? { ...s, status: 'not_reached', durationMs: null, preview: null } : s));
        renderTry({ state });
        expect(screen.getByRole('status').textContent).toContain('The try-out stopped: The model did not answer. Nothing was changed or sent.');
        expect([toneOf('orders'), toneOf('table')]).toEqual(['failed', 'skipped']);
        expect(within(screen.getByTestId('cowork-plan-try-step-table')).getAllByText('Not reached').length).toBeGreaterThan(0);
        expect(within(screen.getByTestId('cowork-plan-try-step-table')).queryByText('Held back')).toBeNull();
    });

    it('a step inside a loop says it runs once per item', () => {
        const state = supplierRadarTry();
        state.steps[4] = { ...state.steps[4]!, depth: 1 };
        renderTry({ state });
        expect(within(screen.getByTestId('cowork-plan-try-step-reply')).getByText('Once per item')).toBeTruthy();
        expect(screen.getAllByText('Once per item')).toHaveLength(1);
    });

    it('says when the plan changed since the try-out, and shows a refused request', () => {
        renderTry({ state: supplierRadarTry(), stale: true, error: 'Too many requests.' });
        expect(screen.getByTestId('cowork-plan-try-stale').textContent).toContain('The plan changed since this try-out');
        expect(screen.getByRole('alert').textContent).toBe('Too many requests.');
    });
});
