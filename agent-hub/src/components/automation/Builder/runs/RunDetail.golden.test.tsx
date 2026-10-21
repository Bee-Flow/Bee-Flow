import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';
import { BuilderConfirmProvider } from '../BuilderConfirmContext';
import RunDetail from './RunDetail';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../OutputView', () => ({ default: () => <div /> }));

const STEPS = {
    steps: [{ runId: 'run-1', stepId: 'read', stepType: 'action', status: 'success', output: { rows: 3 } }],
    definition: { steps: [{ id: 'read', label: 'Read the list' }] },
};

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let goldens: unknown[];
let markResult: { status: number; body: unknown };
let stepsStatus = 200;

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

const GOLDEN = {
    goldenId: 'g1', runId: 'run-1', label: 'A normal week', ignorePaths: ['createdAt'], createdAt: '2026-10-01T09:00:00Z', createdBy: 'u1',
    run: { status: 'success' }, lastReplay: null,
};

function open(onCompare?: (id: string) => void) {
    render(withQueryClient(
        <BuilderConfirmProvider value={(async () => true) as never}>
            <RunDetail
                automationId="a1" runId="run-1" seed={{ id: 'run-1', status: 'success' }} active
                selectedStepId={null} onSelectStep={vi.fn()} onOpenRun={vi.fn()} onViewCanvas={vi.fn()} onClose={vi.fn()}
                onCompare={onCompare}
            />
        </BuilderConfirmProvider>,
    ));
}

beforeEach(() => {
    calls = [];
    goldens = [];
    stepsStatus = 200;
    markResult = { status: 201, body: { golden: GOLDEN } };
    vi.mocked(authFetch).mockImplementation(((url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/a1/goldens')) return reply(200, { goldens, limits: { max: 50 } });
        if (url.endsWith('/runs/run-1/golden')) {
            if (method === 'DELETE') { goldens = []; return reply(200, { deleted: true }); }
            if (markResult.status < 300) goldens = [GOLDEN];
            return reply(markResult.status, markResult.body);
        }
        if (url.endsWith('/runs/run-1/steps')) return reply(stepsStatus, stepsStatus === 200 ? STEPS : { error: 'x', code: 'caller_run_private' });
        return reply(200, { run: { id: 'run-1', status: 'success' } });
    }) as typeof authFetch);
});
afterEach(() => cleanup());

describe('Mark as golden', () => {
    it('marks the run with a label and ignored fields, then offers to remove it', async () => {
        const user = userEvent.setup();
        open();
        await user.click(await screen.findByRole('button', { name: 'Mark as golden' }));
        await user.type(screen.getByLabelText('Label (optional)'), 'A normal week');
        await user.type(screen.getByLabelText('Ignore these fields when comparing'), 'createdAt');
        await user.click(screen.getByRole('button', { name: 'Add field' }));
        expect(screen.getByRole('button', { name: 'Stop ignoring createdAt' })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Save golden run' }));

        await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/runs/run-1/golden'))).toBe(true));
        expect(calls.find(c => c.method === 'POST')?.body).toEqual({ label: 'A normal week', ignorePaths: ['createdAt'] });

        // The list is read again and the run now reads as golden.
        const golden = await screen.findByRole('button', { name: 'Golden ✓' });
        await user.click(golden);
        expect(screen.getByText('A normal week')).toBeTruthy();
        expect(screen.getByText('Ignored when comparing: createdAt')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Remove golden' }));
        await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
        expect(calls.find(c => c.method === 'DELETE')?.url).toBe('/api/automation/runs/run-1/golden');
        expect(await screen.findByRole('button', { name: 'Mark as golden' })).toBeTruthy();
    });

    it('explains once what a golden run is', async () => {
        const user = userEvent.setup();
        open();
        await user.click(await screen.findByRole('button', { name: 'Mark as golden' }));
        await user.click(screen.getByRole('button', { name: 'What is a golden run?' }));
        const note = screen.getByRole('note');
        expect(note.textContent).toContain('A golden run is a run you trust.');
        expect(note.textContent).toContain('never exported or deployed');
    });

    it('says in plain words why a run cannot be golden', async () => {
        const user = userEvent.setup();
        markResult = { status: 409, body: { error: 'x', code: 'golden_needs_success' } };
        open();
        await user.click(await screen.findByRole('button', { name: 'Mark as golden' }));
        await user.click(screen.getByRole('button', { name: 'Save golden run' }));
        expect((await screen.findByRole('alert')).textContent).toBe('Only a run that finished successfully can be a golden run.');
        // The panel stays open, so the person can cancel.
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });

    it('is not offered when the run data is hidden from the viewer', async () => {
        stepsStatus = 403;
        open();
        await waitFor(() => expect(calls.some(c => c.url.endsWith('/runs/run-1/steps'))).toBe(true));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark as golden' })).toBeNull());
        expect(screen.queryByRole('button', { name: 'Compare with…' })).toBeNull();
        // The rest of the header is still there.
        expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    });
});

describe('Compare with…', () => {
    it('offers the previous run first and opens the compare with it', async () => {
        const user = userEvent.setup();
        const onCompare = vi.fn();
        const runs = [
            { id: 'run-1', status: 'success', startedAt: '2026-10-03T10:00:00Z', version: 3 },
            { id: 'run-0', status: 'error', startedAt: '2026-10-02T10:00:00Z', version: 3 },
            { id: 'run-older', status: 'success', startedAt: '2026-10-01T10:00:00Z', version: 2 },
        ];
        const base = vi.mocked(authFetch).getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
        vi.mocked(authFetch).mockImplementation(((url: string, init?: RequestInit) => (
            /\/a1\/runs\?/.test(url) ? reply(200, { runs, facets: {} }) : base(url, init)
        )) as typeof authFetch);
        open(onCompare);
        await user.click(await screen.findByRole('button', { name: 'Compare with…' }));
        const select = await screen.findByRole('combobox', { name: 'Compare this run with' });
        await waitFor(() => expect((select as HTMLSelectElement).value).toBe('run-0'));
        expect(within(select).getAllByRole('option')).toHaveLength(2);
        await user.click(screen.getByRole('button', { name: 'Compare' }));
        expect(onCompare).toHaveBeenCalledWith('run-0');
    });
});
