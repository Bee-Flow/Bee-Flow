/**
 * The scenario side of the form-test overlay: pick a saved scenario to fill the
 * page, and keep the answers of a finished run as a new one. The journey itself
 * (pages, polling, where answers go) is FormRunOverlay.test.jsx.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '../../../test/queryWrapper';
import { authFetch } from '../../../utils/helpers';
import FormRunOverlay from './FormRunOverlay';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../api/client', () => ({ default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

const FORM = {
    title: 'Request', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: {},
    fields: [{ name: 'city', type: 'text', label: 'City', required: true, placeholder: '', help: '' }],
};
const LIST = [{ scenarioId: 'fsc_1', name: 'Complete request', hasTriggerAnswers: true, pages: [], skipped: [] }];
const DETAIL = { ...LIST[0], answers: { trigger: { city: 'Utrecht' }, pages: {} } };

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let createResult: { status: number; body: unknown };

function renderOverlay() {
    const onStartRun = vi.fn(async () => ({ run: { id: 'run1' } }));
    render(withQueryClient(<FormRunOverlay automationId="a1" form={FORM} onStartRun={onStartRun} onClose={vi.fn()} />));
    return onStartRun;
}

beforeEach(() => {
    calls = [];
    get.mockReset();
    post.mockReset();
    createResult = { status: 201, body: { scenario: { ...LIST[0], scenarioId: 'fsc_2', name: 'My path' } } };
    vi.mocked(authFetch).mockImplementation(((url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'POST') return reply(createResult.status, createResult.body);
        if (url.endsWith('/form-scenarios/fsc_1')) return reply(200, { scenario: DETAIL });
        if (url.endsWith('/a1/form-scenarios')) return reply(200, { scenarios: LIST, limits: { max: 50 } });
        return reply(404, {});
    }) as typeof authFetch);
});
afterEach(() => cleanup());

describe('FormRunOverlay with scenarios', () => {
    it('fills page one from a saved scenario and submits those answers', async () => {
        const user = userEvent.setup();
        get.mockResolvedValue({ runId: 'run1', status: 'success', waiting: false });
        const onStartRun = renderOverlay();
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Fill from a saved scenario' }), 'fsc_1');
        await waitFor(() => expect((screen.getByLabelText(/City/) as HTMLInputElement).value).toBe('Utrecht'));
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(onStartRun).toHaveBeenCalled());
        expect((onStartRun.mock.calls[0] as unknown[])[0]).toEqual({ city: 'Utrecht' });
    });

    it('keeps the answers of the finished run as a named scenario', async () => {
        const user = userEvent.setup();
        get.mockResolvedValue({ runId: 'run1', status: 'success', waiting: false });
        renderOverlay();
        await user.type(await screen.findByLabelText(/City/), 'Leiden');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await user.click(await screen.findByRole('button', { name: 'Save these answers as a scenario' }));
        await user.type(screen.getByLabelText('Scenario name'), 'My path');
        await user.click(screen.getByRole('button', { name: 'Save scenario' }));

        expect(await screen.findByText('Saved as scenario "My path".')).toBeTruthy();
        const created = calls.find(c => c.method === 'POST');
        expect(created?.url).toBe('/api/automation/a1/form-scenarios');
        expect(created?.body).toEqual({ name: 'My path', fromRunId: 'run1' });
    });

    it.each([
        ['scenario_name_taken', 409, 'A scenario with this name already exists. Pick another name.'],
        ['no_form_answers', 422, 'This run holds no form answers to save. Pick a run where somebody filled in a form.'],
    ])('explains %s and lets the person try again', async (code, status, text) => {
        const user = userEvent.setup();
        createResult = { status, body: { error: 'x', code } };
        get.mockResolvedValue({ runId: 'run1', status: 'success', waiting: false });
        renderOverlay();
        await user.type(await screen.findByLabelText(/City/), 'Leiden');
        await user.click(screen.getByRole('button', { name: 'Send' }));
        await user.click(await screen.findByRole('button', { name: 'Save these answers as a scenario' }));
        await user.type(screen.getByLabelText('Scenario name'), 'My path');
        await user.click(screen.getByRole('button', { name: 'Save scenario' }));
        expect((await screen.findByRole('alert')).textContent).toBe(text);
        expect((screen.getByRole('button', { name: 'Save scenario' }) as HTMLButtonElement).disabled).toBe(false);
    });
});
