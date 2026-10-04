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

describe('useAutomationApi: the stage that manages an automation refused the write', () => {
    beforeEach(() => { mockedFetch.mockReset(); });

    const refusal = {
        error: 'This part is managed by a Solution stage. Change it in Dev and deploy.',
        code: 'managed_part',
        correlationId: 'c1',
        details: { solutionId: 's1', stage: 'prd' },
    };

    it('a 409 managed_part on save becomes banner state, not a conflict', async () => {
        mockedFetch.mockResolvedValue(rejection(refusal, 409));
        const { result } = renderHook(() => useAutomationApi());
        const err = await failure(result.current.updateAutomation('a1', { definition: {} }));
        expect(err.status).toBe(409);
        expect(err.code).toBe('managed_part');
        expect(err.message).toBe('This part is managed by a Solution stage. Change it in Dev and deploy.');
        expect(err.managed).toEqual({
            reason: 'managed',
            code: 'managed_part',
            message: refusal.error,
            managed: { solutionId: 's1', solutionName: null, stage: 'prd', releaseSeq: null, devRef: null },
        });
        // The object details are not validator records.
        expect(err.details).toBeUndefined();
    });

    it('a 409 managed_part_not_deployed on a run maps to the not-deployed banner', async () => {
        mockedFetch.mockResolvedValue(rejection({
            error: 'This automation is managed by a Solution stage and has not been deployed yet. Deploy it before running it.',
            code: 'managed_part_not_deployed',
            details: { automationId: 'a1' },
        }, 409));
        const { result } = renderHook(() => useAutomationApi());
        const err = await failure(result.current.run('a1', {}));
        expect(err.managed).toMatchObject({ reason: 'not_deployed', managed: null });
    });

    it('a Step save carries it too, and any other 409 carries none', async () => {
        mockedFetch.mockResolvedValue(rejection(refusal, 409));
        const { result } = renderHook(() => useAutomationApi());
        expect((await failure(result.current.updateStep('b1', { definition: {} }))).managed?.reason).toBe('managed');

        mockedFetch.mockResolvedValue(rejection({ error: 'Version changed', code: 'version_changed' }, 409));
        const other = await failure(result.current.updateAutomation('a1', { title: 'x' }));
        expect(other.code).toBe('version_changed');
        expect(other.managed).toBeUndefined();
    });
});
