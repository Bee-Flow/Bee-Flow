import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The wire contract of the full-output route (BFSF-402): which sentinels point
 * at a copy, what URL the copy is read from — a layer sub-step's id carries a
 * slash — and that a refusal is not retried.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import { authFetch } from '../../utils/helpers';
import { ApiError } from '../client';
import { fetchRunFullOutput, fullOutputRefOf } from './runFullOutput';

const fetchMock = vi.mocked(authFetch);

function json(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

afterEach(() => { fetchMock.mockReset(); });

describe('fullOutputRefOf', () => {
    it('reads the ref off a sentinel that has one', () => {
        expect(fullOutputRefOf({ __truncated__: true, fullOutputRef: { runId: 'r1', stepId: 's1', attempts: 2 } }))
            .toEqual({ runId: 'r1', stepId: 's1', attempts: 2 });
    });

    it('finds none on an older sentinel, on real data, or on a malformed ref', () => {
        expect(fullOutputRefOf({ __truncated__: true, originalBytes: 1, headSample: '' })).toBeNull();
        expect(fullOutputRefOf({ fullOutputRef: { runId: 'r1', stepId: 's1', attempts: 1 } })).toBeNull();
        expect(fullOutputRefOf({ __truncated__: true, fullOutputRef: { runId: 'r1' } })).toBeNull();
        expect(fullOutputRefOf(null)).toBeNull();
        expect(fullOutputRefOf('text')).toBeNull();
    });

    it('reads a missing attempt number as the first attempt', () => {
        expect(fullOutputRefOf({ __truncated__: true, fullOutputRef: { runId: 'r1', stepId: 's1' } })?.attempts).toBe(1);
    });
});

describe('fetchRunFullOutput', () => {
    it('reads the leg\'s row, with the step id encoded and the attempt as a query', async () => {
        fetchMock.mockResolvedValue(json({ output: { items: [1, 2] } }));
        const out = await fetchRunFullOutput({ runId: 'run-1', stepId: 'cl1/out', attempts: 2 });
        expect(out).toEqual({ items: [1, 2] });
        expect(String(fetchMock.mock.calls[0][0])).toBe('/api/automation/runs/run-1/steps/cl1%2Fout/full-output?attempts=2');
    });

    it('throws on a 404 and asks only once', async () => {
        fetchMock.mockResolvedValue(json({ error: 'No full copy of this output was kept' }, 404));
        await expect(fetchRunFullOutput({ runId: 'run-1', stepId: 's1', attempts: 1 })).rejects.toBeInstanceOf(ApiError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not retry a server error either — the button is the retry', async () => {
        fetchMock.mockResolvedValue(json({ error: 'boom' }, 500));
        await expect(fetchRunFullOutput({ runId: 'run-1', stepId: 's1', attempts: 1 })).rejects.toBeInstanceOf(ApiError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
