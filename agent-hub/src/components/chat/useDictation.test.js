/**
 * useDictation — the request it makes.
 *
 * REGRESSION (2026-09-11): the hook posted to `${API_BASE}/dictate` and every
 * recording came back "Transcription failed (404)". API_BASE carries NO `/api`
 * segment — routes mounted under `/api/*` on the server are called as
 * `${API_BASE}/api/...` (see pages/meeting-notes/lib/transcriptionsApi.js),
 * while the `/ai/*` routes are called without it. The two conventions live side
 * by side, so the path is worth pinning rather than remembering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://beeflow.test',
    authFetch: (...args) => authFetch(...args),
}));

const { default: useDictation } = await import('./useDictation');

function okResponse(body) {
    return { ok: true, status: 200, json: async () => body };
}

describe('useDictation', () => {
    beforeEach(() => { authFetch.mockReset(); });

    it('posts to /api/dictate — the prefix whose absence caused the 404', async () => {
        authFetch.mockResolvedValue(okResponse({ text: 'hallo daar' }));
        const onText = vi.fn();
        const { result } = renderHook(() => useDictation({ onText }));

        // Drive the private transcribe path the way onstop does, without
        // needing a real MediaRecorder in jsdom.
        await act(async () => {
            await result.current.__test_transcribe(new Blob([new Uint8Array(4000)], { type: 'audio/webm' }));
        });

        expect(authFetch).toHaveBeenCalledTimes(1);
        const [url, options] = authFetch.mock.calls[0];
        expect(url).toBe('https://beeflow.test/api/dictate');
        expect(url).not.toBe('https://beeflow.test/dictate');
        expect(options.method).toBe('POST');
        expect(options.body).toBeInstanceOf(FormData);
        expect(options.body.get('audio')).toBeTruthy();
        await waitFor(() => expect(onText).toHaveBeenCalledWith('hallo daar'));
    });

    it('a clip too short to be speech is never sent', async () => {
        const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
        await act(async () => {
            await result.current.__test_transcribe(new Blob([new Uint8Array(10)], { type: 'audio/webm' }));
        });
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('surfaces the server error text rather than a bare status', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'Speech recognition is not available.' }) });
        const { result } = renderHook(() => useDictation({ onText: vi.fn() }));
        await act(async () => {
            await result.current.__test_transcribe(new Blob([new Uint8Array(4000)], { type: 'audio/webm' }));
        });
        await waitFor(() => expect(result.current.error).toBe('Speech recognition is not available.'));
        expect(result.current.state).toBe('idle');
    });

    it('an empty transcript is reported, not silently appended', async () => {
        authFetch.mockResolvedValue(okResponse({ text: '   ' }));
        const onText = vi.fn();
        const { result } = renderHook(() => useDictation({ onText }));
        await act(async () => {
            await result.current.__test_transcribe(new Blob([new Uint8Array(4000)], { type: 'audio/webm' }));
        });
        await waitFor(() => expect(result.current.error).toBe('No speech detected.'));
        expect(onText).not.toHaveBeenCalled();
    });
});
