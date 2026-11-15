// The Save of the org-level Meeting Notes cards: a failure is never reported as saved.
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stub } from '@/test/mocks';
import { jsonResponse, stubRecordingFetch } from '@/test/recordingFetch';
import { useOrgNotesSave } from './useOrgNotesSave';

afterEach(() => { vi.unstubAllGlobals(); });

/**
 * Save once while the server answers `outcome` (a Response), or the request
 * fails with `fails`: thrown while the answer is read, not by the stub itself
 * (vitest reports a value a spy rejects with as the test's own error).
 */
async function saveWith(outcome: Response | { fails: unknown }) {
    const failing = { get ok(): boolean { throw (outcome as { fails: unknown }).fails; } };
    const calls = stubRecordingFetch(() => (outcome instanceof Response ? outcome : stub<Response>(failing)));
    const { result } = renderHook(() => useOrgNotesSave('talk', 'org-1', { autoRecord: true }));
    await act(async () => { await result.current.save(); });
    return { state: result.current, calls };
}

describe('useOrgNotesSave', () => {
    it('PUTs the whole form of the organisation and says it is saved', async () => {
        const { state, calls } = await saveWith(jsonResponse({ ok: true }));
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toMatch(/\/api\/talk-notes-settings\/org-1$/);
        expect(calls[0]?.method).toBe('PUT');
        expect(calls[0]?.body).toEqual({ autoRecord: true });
        expect(state.saveState).toBe('saved');
        expect(state.error).toBeNull();
    });

    it('says a refused save with the server\'s reason', async () => {
        const { state } = await saveWith(jsonResponse({ error: 'Not your organisation' }, 403));
        expect(state.saveState).toBe('error');
        expect(state.error).toBe('Not your organisation');
    });

    it('never calls a failure without a message "saved"', async () => {
        const { state } = await saveWith({ fails: { reason: 'odd' } });
        expect(state.saveState).toBe('error');
    });
});
