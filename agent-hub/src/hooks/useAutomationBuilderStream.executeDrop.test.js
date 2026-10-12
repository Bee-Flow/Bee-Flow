import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationBuilderStream from './useAutomationBuilderStream';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * "Test step" on a step that takes long: a proxy in between (the Nextcloud
 * connector waits 60 s for response headers) cuts the request off with a 502,
 * while the run finishes on the server. The panel used to say "Bee Flow
 * service is temporarily unavailable" and mark the step failed; it waits for
 * the run instead and shows what it really did.
 */
const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: () => Promise.resolve(body) });

describe('useAutomationBuilderStream — Execute step after a dropped connection', () => {
    beforeEach(() => { authFetch.mockReset(); });

    it('a 502 from the proxy waits for the run and shows its result, not an error', async () => {
        const startedAt = new Date().toISOString();
        authFetch.mockImplementation((url) => {
            if (url.includes('/steps/s2/run')) return Promise.resolve(json({ error: 'Bee Flow service is temporarily unavailable. Please try again.' }, { ok: false, status: 502 }));
            if (url.includes('/_runs/active')) return Promise.resolve(json({ active: [] }));
            if (url.includes('/runs?limit=1')) return Promise.resolve(json({ runs: [{ id: 'run-9', status: 'running', startedAt }] }));
            if (url.endsWith('/runs/run-9')) return Promise.resolve(json({ run: { id: 'run-9', status: 'success', startedAt } }));
            if (url.includes('/runs/run-9/steps')) return Promise.resolve(json({ steps: [{ stepId: 's2', status: 'success', output: { messages: 'ok' } }] }));
            return Promise.resolve(json({}));
        });
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        let out;
        await act(async () => { out = await result.current.executeStep('s2'); });
        expect(out).toEqual({ recovered: true });
        expect(result.current.state.error).toBeNull();
        const row = result.current.state.steps.find(s => s.stepId === 's2');
        expect(row.status).toBe('success');
        expect(result.current.state.executingStepId).toBeNull();
    });

    it('a 502 with no run to wait for still reports the failure', async () => {
        authFetch.mockImplementation((url) => {
            if (url.includes('/steps/s2/run')) return Promise.resolve(json({ error: 'gateway' }, { ok: false, status: 502 }));
            if (url.includes('/_runs/active')) return Promise.resolve(json({ active: [] }));
            if (url.includes('/runs?limit=1')) return Promise.resolve(json({ runs: [] }));
            return Promise.resolve(json({}));
        });
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        await act(async () => { await result.current.executeStep('s2'); });
        expect(result.current.state.error).toBe('gateway');
    });

    it('a run that started BEFORE the click is not mistaken for this one', async () => {
        authFetch.mockImplementation((url) => {
            if (url.includes('/steps/s2/run')) return Promise.reject(new TypeError('Failed to fetch'));
            if (url.includes('/_runs/active')) return Promise.resolve(json({ active: [] }));
            if (url.includes('/runs?limit=1')) return Promise.resolve(json({ runs: [{ id: 'old', status: 'success', startedAt: '2020-01-01T00:00:00Z' }] }));
            return Promise.resolve(json({}));
        });
        const { result } = renderHook(() => useAutomationBuilderStream({ automationId: 'a1' }));
        await act(async () => { await result.current.executeStep('s2'); });
        expect(result.current.state.error).toBe('Failed to fetch');
    });
});
