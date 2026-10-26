import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '@/test/queryWrapper';
import { authFetch } from '@/utils/helpers';
import GoldensPanel from './GoldensPanel';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

const golden = (id: string, label: string, lastReplay: Record<string, unknown> | null) => ({
    goldenId: id, runId: `run-${id}`, label, ignorePaths: ['createdAt'], createdAt: '2026-10-01T09:00:00Z', createdBy: 'u1',
    run: { status: 'success', mode: 'live', version: 2, triggerKind: 'form', startedAt: '2026-10-01T09:00:00Z' },
    lastReplay,
});

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let goldens: unknown[];
let replayResult: { status: number; body: unknown };
let listCalls = 0;

function show(props: Partial<React.ComponentProps<typeof GoldensPanel>> = {}) {
    const onCompare = vi.fn();
    const onOpenRun = vi.fn();
    render(withQueryClient(<GoldensPanel automationId="a1" onCompare={onCompare} onOpenRun={onOpenRun} {...props} />));
    return { onCompare, onOpenRun };
}

beforeEach(() => {
    calls = [];
    listCalls = 0;
    goldens = [
        golden('1', 'Normal week', { status: 'same', at: '2026-10-02T09:00:00Z', replayRunId: 'rep-1', summary: { same: 3 }, errorCode: null }),
        golden('2', 'Busy week', { status: 'soft', at: '2026-10-02T09:00:00Z', replayRunId: 'rep-2', summary: { soft: 1 }, errorCode: null }),
        golden('3', 'Odd week', { status: 'changed', at: '2026-10-02T09:00:00Z', replayRunId: 'rep-3', summary: { changed: 2 }, errorCode: null }),
        golden('4', 'Broken week', { status: 'error', at: '2026-10-02T09:00:00Z', replayRunId: null, summary: null, errorCode: 'golden_run_gone' }),
        golden('5', 'Old week', { status: 'interrupted', at: '2026-10-02T09:00:00Z', replayRunId: null, summary: null, errorCode: null }),
        golden('6', 'New week', null),
    ];
    replayResult = { status: 202, body: { replaying: ['1'] } };
    vi.mocked(authFetch).mockImplementation(((url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'GET' && url.endsWith('/a1/goldens')) { listCalls += 1; return reply(200, { goldens, limits: { max: 50 } }); }
        if (method === 'POST' && url.endsWith('/a1/goldens/replay')) return reply(replayResult.status, replayResult.body);
        if (method === 'DELETE') return reply(200, { deleted: true });
        return reply(404, {});
    }) as typeof authFetch);
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

const row = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` }).closest('li') as HTMLElement;

describe('GoldensPanel', () => {
    it('shows the last replay of every golden as a badge', async () => {
        show();
        await screen.findByText('Normal week');
        expect(within(row('Normal week')).getByText('Same')).toBeTruthy();
        expect(within(row('Busy week')).getByText('Only AI differs')).toBeTruthy();
        expect(within(row('Odd week')).getByText('Different')).toBeTruthy();
        expect(within(row('Broken week')).getByText('Error')).toBeTruthy();
        expect(within(row('Broken week')).getByText('The saved run no longer exists.')).toBeTruthy();
        expect(within(row('Old week')).getByText('Interrupted')).toBeTruthy();
        // Never replayed: no badge, no differences to see.
        expect(within(row('New week')).queryByText('Same')).toBeNull();
        expect(within(row('New week')).queryByRole('button', { name: 'See differences' })).toBeNull();
        expect(screen.getByText('6 of 50')).toBeTruthy();
    });

    it('opens the golden against its replay from "See differences"', async () => {
        const user = userEvent.setup();
        const { onCompare } = show();
        await screen.findByText('Busy week');
        await user.click(within(row('Busy week')).getByRole('button', { name: 'See differences' }));
        expect(onCompare).toHaveBeenCalledTimes(1);
        expect(onCompare.mock.calls[0][0]).toMatchObject({ goldenId: '2', runId: 'run-2', ignorePaths: ['createdAt'], lastReplay: { replayRunId: 'rep-2' } });
        expect(within(row('Broken week')).queryByRole('button', { name: 'See differences' })).toBeNull();
    });
});

describe('GoldensPanel: replaying', () => {
    it('replays with stored AI answers when that is chosen, for the selected goldens', async () => {
        const user = userEvent.setup();
        show();
        await screen.findByText('Normal week');
        await user.click(screen.getByRole('radio', { name: 'Reuse stored answers where available' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Normal week' }));
        await user.click(screen.getByRole('button', { name: 'Replay 1 selected' }));
        await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
        const post = calls.find(c => c.method === 'POST');
        expect(post?.url).toBe('/api/automation/a1/goldens/replay');
        expect(post?.body).toEqual({ aiAnswers: 'cache', goldenIds: ['1'] });
    });

    it('asks the AI again for every golden by default', async () => {
        const user = userEvent.setup();
        show();
        await user.click(await screen.findByRole('button', { name: 'Replay goldens' }));
        await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
        expect(calls.find(c => c.method === 'POST')?.body).toEqual({ aiAnswers: 'live' });
    });

    it('tells the person when a replay is already running', async () => {
        const user = userEvent.setup();
        replayResult = { status: 409, body: { error: 'x', code: 'replay_in_progress' } };
        show();
        await user.click(await screen.findByRole('button', { name: 'Replay goldens' }));
        expect((await screen.findByRole('alert')).textContent).toBe('A replay is already running. Wait for it to finish.');
    });

    it('explains the golden limit', async () => {
        const user = userEvent.setup();
        replayResult = { status: 409, body: { error: 'x', code: 'golden_limit' } };
        show();
        await user.click(await screen.findByRole('button', { name: 'Replay goldens' }));
        expect((await screen.findByRole('alert')).textContent).toContain('limit of golden runs');
    });

    it('reads the list again while a replay runs, and stops when it is done', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        goldens = [golden('1', 'Normal week', { status: 'running', at: '2026-10-02T09:00:00Z', replayRunId: null, summary: null, errorCode: null })];
        show();
        await screen.findByText('Normal week');
        expect(screen.getByText('Replaying…')).toBeTruthy();
        expect(listCalls).toBe(1);

        goldens = [golden('1', 'Normal week', { status: 'same', at: '2026-10-02T09:01:00Z', replayRunId: 'rep-1', summary: { same: 2 }, errorCode: null })];
        await vi.advanceTimersByTimeAsync(3100);
        await waitFor(() => expect(within(row('Normal week')).getByText('Same')).toBeTruthy());
        expect(listCalls).toBe(2);

        // Nothing is running any more: no further reads.
        await vi.advanceTimersByTimeAsync(12_000);
        expect(listCalls).toBe(2);
    });

    it('removes a golden through the run it belongs to', async () => {
        const user = userEvent.setup();
        show();
        await screen.findByText('Normal week');
        await user.click(within(row('Normal week')).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
        expect(calls.find(c => c.method === 'DELETE')?.url).toBe('/api/automation/runs/run-1/golden');
    });

    it('invites the first golden when there is none', async () => {
        goldens = [];
        show();
        expect(await screen.findByText(/No golden runs yet/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Replay goldens' })).toBeNull();
    });
});
