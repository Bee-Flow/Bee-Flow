import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../../test/queryWrapper';
import { authFetch } from '../../../../utils/helpers';
import FormScenariosPanel from './FormScenariosPanel';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

const scenario = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    scenarioId: id, name, sourceRunId: 'run-9', createdAt: '2026-10-01T09:00:00Z', createdBy: 'u1',
    hasTriggerAnswers: true, pages: [{ stepId: 'p2', fieldCount: 2 }], skipped: [], ...over,
});

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let scenarios: unknown[];
let answer: Record<string, { status: number; body: unknown }>;

function show() {
    const onOpenRun = vi.fn();
    render(withQueryClient(<FormScenariosPanel automationId="a1" onOpenRun={onOpenRun} />));
    return onOpenRun;
}

beforeEach(() => {
    calls = [];
    scenarios = [scenario('fsc_1', 'Complete request'), scenario('fsc_2', 'Short request', { hasTriggerAnswers: false, pages: [], skipped: [{ stepId: null, field: 'cv', reason: 'file' }] })];
    answer = {};
    vi.mocked(authFetch).mockImplementation(((url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const key = `${method} ${url.replace('/api/automation/a1', '')}`;
        if (answer[key]) return reply(answer[key].status, answer[key].body);
        if (key === 'GET /form-scenarios') return reply(200, { scenarios, limits: { max: 50 } });
        if (method === 'POST' && url.endsWith('/dry-run')) return reply(200, { run: { id: 'dry-1', status: 'success' }, steps: [] });
        if (method === 'PUT') return reply(200, { scenario: scenario('fsc_1', JSON.parse(String(init?.body)).name) });
        if (method === 'DELETE') return reply(200, { deleted: true });
        return reply(404, {});
    }) as typeof authFetch);
});
afterEach(() => cleanup());

const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('FormScenariosPanel', () => {
    it('lists the scenarios with the pages they answer', async () => {
        show();
        await screen.findByText('Complete request');
        expect(within(row('Complete request')).getByText('2 pages answered')).toBeTruthy();
        expect(within(row('Short request')).getByText('0 pages answered')).toBeTruthy();
        expect(within(row('Short request')).getByText('1 field not saved (files and app picks)')).toBeTruthy();
        expect(screen.getByText('2 of 50')).toBeTruthy();
    });

    it('dry-runs a scenario and opens the run it made', async () => {
        const user = userEvent.setup();
        const onOpenRun = show();
        await screen.findByText('Complete request');
        await user.click(within(row('Complete request')).getByRole('button', { name: 'Dry run' }));
        await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith('dry-1'));
        const post = calls.find(c => c.method === 'POST');
        expect(post?.url).toBe('/api/automation/a1/form-scenarios/fsc_1/dry-run');
        expect(post?.body).toEqual({});
    });

    it('renames a scenario', async () => {
        const user = userEvent.setup();
        show();
        await screen.findByText('Complete request');
        await user.click(within(row('Complete request')).getByRole('button', { name: 'Rename' }));
        const input = screen.getByLabelText('Scenario name');
        await user.clear(input);
        await user.type(input, 'Full request');
        await user.click(screen.getByRole('button', { name: 'Save name' }));
        await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
        expect(calls.find(c => c.method === 'PUT')).toMatchObject({ url: '/api/automation/a1/form-scenarios/fsc_1', body: { name: 'Full request' } });
        await waitFor(() => expect(screen.queryByLabelText('Scenario name')).toBeNull());
    });

    it('keeps the rename open and explains a name that is taken', async () => {
        const user = userEvent.setup();
        answer['PUT /form-scenarios/fsc_1'] = { status: 409, body: { error: 'x', code: 'scenario_name_taken' } };
        show();
        await screen.findByText('Complete request');
        await user.click(within(row('Complete request')).getByRole('button', { name: 'Rename' }));
        await user.type(screen.getByLabelText('Scenario name'), '2');
        await user.click(screen.getByRole('button', { name: 'Save name' }));
        expect((await screen.findByRole('alert')).textContent).toBe('A scenario with this name already exists. Pick another name.');
        expect(screen.getByLabelText('Scenario name')).toBeTruthy();
    });

    it('asks before it deletes', async () => {
        const user = userEvent.setup();
        show();
        await screen.findByText('Complete request');
        await user.click(within(row('Complete request')).getByRole('button', { name: 'Delete' }));
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
        await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
        expect(calls.find(c => c.method === 'DELETE')?.url).toBe('/api/automation/a1/form-scenarios/fsc_1');
    });

    it('shows why a dry run was refused and opens nothing', async () => {
        const user = userEvent.setup();
        answer['POST /form-scenarios/fsc_1/dry-run'] = { status: 429, body: { error: 'slow down' } };
        const onOpenRun = show();
        await screen.findByText('Complete request');
        await user.click(within(row('Complete request')).getByRole('button', { name: 'Dry run' }));
        expect((await screen.findByRole('alert')).textContent).toContain('Too many requests');
        expect(onOpenRun).not.toHaveBeenCalled();
    });

    it('explains what a scenario is, and invites the first one', async () => {
        const user = userEvent.setup();
        scenarios = [];
        show();
        expect(await screen.findByText(/No scenarios yet/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'What is a form scenario?' }));
        expect(screen.getByRole('note').textContent).toContain('never exported or deployed');
    });
});
