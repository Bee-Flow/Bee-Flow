/**
 * "Save as test case" on a step's row in a run: offered for a code step whose
 * input is on screen, never for another kind of step or for data the viewer
 * may not see. The network is a stubbed fetch (no module mock).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import { withQueryClient } from '../../../../test/queryWrapper';
import RunIo from './RunIo';

const step = (over: Partial<RunStepRecord> = {}): RunStepRecord => ({
    runId: 'run-1', stepId: 'calc', stepType: 'code', status: 'success', input: { amount: 5 }, output: { total: 6 }, attempts: 2, ...over,
});

const renderIo = (s: RunStepRecord | null, automationId: string | null = 'a1') => render(withQueryClient(
    <RunIo step={s} label="Work out the total" stepDef={{ id: 'calc', type: 'code', inputs: { amount: { kind: 'literal', value: 1 }, secretKeys: [] } }} automationId={automationId} />,
));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Save as test case', () => {
    it('is offered on a code step with a readable input', () => {
        renderIo(step());
        expect(screen.getByRole('button', { name: 'Save as test case' })).toBeTruthy();
    });

    it.each([
        ['another kind of step', step({ stepType: 'send_email' }), 'a1'],
        ['data hidden from this viewer', step({ dataHidden: true }), 'a1'],
        ['a step without a recorded input', step({ input: undefined }), 'a1'],
        ['a step with no input at all', step({ input: null }), 'a1'],
        ['a row with no run', step({ runId: undefined }), 'a1'],
        ['no automation to save it to', step(), null],
    ])('is not offered for %s', (_name, s, automationId) => {
        renderIo(s, automationId);
        expect(screen.queryByRole('button', { name: 'Save as test case' })).toBeNull();
    });

    it('opens the test form with this run chosen as the input, and saves it with no checks', async () => {
        const user = userEvent.setup();
        const posts: Array<{ url: string; body: any }> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if ((init?.method || 'GET') === 'POST') posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ testCase: { id: 'tc_new', stepId: 'calc', name: 'x' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        }));
        renderIo(step());
        await user.click(screen.getByRole('button', { name: 'Save as test case' }));
        const dialog = screen.getByRole('dialog', { name: 'Save as test case' });
        expect(dialog).toBeTruthy();
        expect((screen.getByLabelText('Use the input of a recorded run') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText(/Add checks below/)).toBeTruthy();
        expect(screen.queryByTestId('assertion-row')).toBeNull();
        await user.type(screen.getByLabelText('Name'), 'Five');
        await user.click(screen.getByRole('button', { name: 'Save test' }));
        await waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].url).toMatch(/\/api\/automation\/a1\/test-cases$/);
        expect(posts[0].body).toEqual({
            stepId: 'calc', name: 'Five', expect: 'success', assertions: [], input: { kind: 'run', runId: 'run-1', attempts: 2 },
        });
        expect(await screen.findByText(/Find it in the Tests tab/)).toBeTruthy();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('offers the step\'s inputs as typed values if the person switches', async () => {
        const user = userEvent.setup();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
        renderIo(step());
        await user.click(screen.getByRole('button', { name: 'Save as test case' }));
        await user.click(screen.getByLabelText('Type values'));
        expect((screen.getByLabelText('amount') as HTMLInputElement).value).toBe('');
        expect(screen.queryByLabelText('secretKeys')).toBeNull();
    });

    it('closes on Escape without saving', async () => {
        const user = userEvent.setup();
        renderIo(step());
        await user.click(screen.getByRole('button', { name: 'Save as test case' }));
        screen.getByLabelText('Name').focus();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
