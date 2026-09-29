import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationApi, { type AutomationApiError } from './useAutomationApi';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * BFSF-58 — a rejected definition carries the validator's structured records.
 * They used to survive only as prose inside the error message, so the builder
 * could toast them but not put them on the canvas. The error now carries them
 * as `details`, next to the sentence it always had.
 */

const mockedFetch = vi.mocked(authFetch);
const records = [{ code: 'switch.cases_missing', message: 'Step sw_1: switch requires at least one case.', path: 'steps[sw_1].cases' }];
const rejection = (body: unknown, status = 400) =>
    ({ ok: false, status, statusText: 'Bad Request', json: async () => body }) as unknown as Response;

async function failure(p: Promise<unknown>): Promise<AutomationApiError> {
    try { await p; } catch (e) { return e as AutomationApiError; }
    throw new Error('expected the request to fail');
}

describe('useAutomationApi — validator details on a rejected save', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    it('an automation PUT rejection carries status, sentence and records', async () => {
        mockedFetch.mockResolvedValue(rejection({ error: 'Invalid definition', details: records }));
        const { result } = renderHook(() => useAutomationApi());
        const err = await failure(result.current.updateAutomation('a1', { definition: {} }));
        expect(err.status).toBe(400);
        expect(err.message).toBe('Invalid definition: Step sw_1: switch requires at least one case.');
        expect(err.details).toEqual(records);
    });

    it('a Step PUT rejection carries them too', async () => {
        mockedFetch.mockResolvedValue(rejection({ error: 'Invalid Step definition', details: records }));
        const { result } = renderHook(() => useAutomationApi());
        const err = await failure(result.current.updateStep('b1', { definition: {} }));
        expect(err.status).toBe(400);
        expect(err.details).toEqual(records);
    });

    it('an error without records has no details', async () => {
        mockedFetch.mockResolvedValue(rejection({ error: 'Forbidden' }, 403));
        const { result } = renderHook(() => useAutomationApi());
        const err = await failure(result.current.updateAutomation('a1', { title: 'x' }));
        expect(err.status).toBe(403);
        expect(err.details).toBeUndefined();
    });
});
