import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import useAutomationApi from './useAutomationApi';
import { authFetch } from '../utils/helpers';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

/**
 * The wire format of the RUN-level first-run gate (POST /runs/:id/approve).
 *
 * This is the seam between the two halves of the same fix: the buttons assert
 * they hand a decision word to `approveRun`, and the route asserts it reads
 * `req.body.decision` — but only this file proves the word actually becomes a
 * request body. When it did not, Reject reached a server that reads a missing
 * decision as an approval, ran the automation, and cleared the gate for good.
 */

const ok = (body = {}) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const sent = () => ({ url: authFetch.mock.calls[0][0], init: authFetch.mock.calls[0][1] });
const sentBody = () => JSON.parse(sent().init.body);

describe('useAutomationApi.approveRun', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockResolvedValue(ok({ accepted: true }));
    });

    it('POSTs the decision word to the run-level approve route', async () => {
        const { result } = renderHook(() => useAutomationApi());
        await result.current.approveRun('r1', 'reject');
        expect(sent().url).toBe('/api/automation/runs/r1/approve');
        expect(sent().init.method).toBe('POST');
        expect(sentBody()).toEqual({ decision: 'reject' });
    });

    it('still means APPROVE for a caller that passes only the run id', async () => {
        // The default is not "silence means consent": it is the only thing the
        // shipped callers of the bare form ever meant. Changing it would break
        // Approve in every open tab.
        const { result } = renderHook(() => useAutomationApi());
        await result.current.approveRun('r1');
        expect(sentBody()).toEqual({ decision: 'approve' });
    });

    it('carries an optional reason, which the server writes into the run summary', async () => {
        const { result } = renderHook(() => useAutomationApi());
        await result.current.approveRun('r1', 'reject', 'wrong recipient list');
        expect(sentBody()).toEqual({ decision: 'reject', reason: 'wrong recipient list' });
    });
});
