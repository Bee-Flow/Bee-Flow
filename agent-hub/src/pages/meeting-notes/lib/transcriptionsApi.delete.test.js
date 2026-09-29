/**
 * Deleting a meeting note, and the 409 that stands in the way (M2).
 *
 * The server refuses the first DELETE with `409 {code:'in_use', usage,
 * unchecked}` whenever something still collects, runs on or holds a copy of
 * the meeting — and also when it could not CHECK one of those. That payload
 * is the whole point of the guard, and the old `throw new Error('HTTP ' +
 * status)` threw it away, which is why the meeting delete could not talk to
 * `shared/DangerZone.jsx` at all.
 *
 * These tests pin the two halves that have to line up: the error this module
 * throws, and the shape DangerZone's `inUsePayload` reads. They import the
 * real `inUsePayload` rather than restating it, so the contract cannot drift
 * on one side only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(), isDemoMode: () => false }));

import { deleteTranscription } from './transcriptionsApi';
import { inUsePayload } from '../../../components/shared/DangerZone';
import { authFetch } from '../../../utils/helpers';

const ok = (body = { success: true }) => ({ ok: true, status: 200, json: async () => body });
const conflict = (body) => ({ ok: false, status: 409, json: async () => body });

const IN_USE = {
    error: 'This meeting is still in use',
    code: 'in_use',
    usage: [{ kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains' }],
    unchecked: ['notebook'],
};

describe('deleteTranscription', () => {
    beforeEach(() => vi.clearAllMocks());

    it('asks unconfirmed by default — the server gets to check first', async () => {
        authFetch.mockResolvedValue(ok());
        await deleteTranscription('m-1');
        expect(authFetch).toHaveBeenCalledWith('/api/transcriptions/m-1', { method: 'DELETE' });
    });

    it('confirmedBreaking is the ONLY thing that adds ?confirm=1', async () => {
        authFetch.mockResolvedValue(ok());
        await deleteTranscription('m-1', { confirmedBreaking: true });
        expect(authFetch).toHaveBeenCalledWith('/api/transcriptions/m-1?confirm=1', { method: 'DELETE' });

        authFetch.mockClear();
        await deleteTranscription('m-1', { confirmedBreaking: false });
        expect(authFetch).toHaveBeenCalledWith('/api/transcriptions/m-1', { method: 'DELETE' });
    });

    it('a 409 arrives in the shape the shared danger zone reads', async () => {
        authFetch.mockResolvedValue(conflict(IN_USE));
        const err = await deleteTranscription('m-1').catch((e) => e);
        expect(err.status).toBe(409);
        expect(err.code).toBe('in_use');
        expect(err.message).toBe('This meeting is still in use');
        // The half that used to be lost.
        expect(inUsePayload(err)).toEqual(IN_USE.usage);
        expect(err.body.unchecked).toEqual(['notebook']);
    });

    it('a 204 has no body and is not parsed as one', async () => {
        authFetch.mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
        await expect(deleteTranscription('m-1')).resolves.toEqual({ success: true });
    });

    it('a bodyless failure still throws, and inUsePayload finds nothing to confirm', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError('<html>'); } });
        const err = await deleteTranscription('m-1').catch((e) => e);
        expect(err.message).toBe('HTTP 502');
        expect(inUsePayload(err)).toBeNull();
    });

    it('a 409 with no usage array is not mistaken for a confirmable conflict', async () => {
        authFetch.mockResolvedValue(conflict({ error: 'nope', code: 'in_use' }));
        const err = await deleteTranscription('m-1').catch((e) => e);
        expect(inUsePayload(err)).toBeNull();
    });
});
