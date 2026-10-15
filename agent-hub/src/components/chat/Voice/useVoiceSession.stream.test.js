import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useVoiceSession from './useVoiceSession';
import { authFetch } from '../../../utils/helpers';

// Characterisation of what a turn's SSE events do to the hook's state, the
// host callback, the form the turn is POSTed with and the failure paths.
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

let rms = 0;
let nowMs = 0;

class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    }
    stop() { this.state = 'inactive'; this.onstop?.(); }
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A body that hands the frames over in the given chunks (frames may be split mid-way). */
function bodyOf(chunks) {
    return {
        getReader: () => {
            let i = 0;
            return {
                read: async () => (i < chunks.length
                    ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
                    : { done: true, value: undefined }),
            };
        },
    };
}

let turnResponse;
let lastTurnForm;

beforeEach(() => {
    rms = 0;
    nowMs = 0;
    lastTurnForm = null;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.MediaRecorder = FakeMediaRecorder;
    globalThis.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [] }) };
    globalThis.AudioContext = class {
        createMediaStreamSource() { return { connect() {} }; }
        createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(buf) { buf.fill(rms); } }; }
        close() {}
    };
    authFetch.mockReset();
    authFetch.mockImplementation(async (url, opts) => {
        if (String(url).endsWith('/ai/voice/session')) return { ok: true, json: async () => ({ model: 'm1', language: 'nl' }) };
        lastTurnForm = opts.body;
        return turnResponse;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete globalThis.MediaRecorder;
    delete globalThis.AudioContext;
});

async function vadFrame(energy, dt = 50) {
    rms = energy;
    nowMs += dt;
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

async function speakOneTurn(result) {
    await act(async () => { await result.current.connect({}); });
    await vadFrame(0.05);
    await vadFrame(0.001, 1000);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe('useVoiceSession — turn stream', () => {
    it('reports a completed turn: transcript, streamed text, tools, server-cleaned text, latency, back to idle', async () => {
        turnResponse = {
            ok: true,
            // The transcript frame is split across two chunks on purpose.
            body: bodyOf([
                frame('transcript', { text: 'wat is mijn saldo', latencyMs: 120, language: 'NL-nl' }).slice(0, 20),
                frame('transcript', { text: 'wat is mijn saldo', latencyMs: 120, language: 'NL-nl' }).slice(20)
                + frame('no_speech', {})
                + frame('text', { delta: 'Je saldo ' }) + frame('text', { delta: 'is 5.' })
                + frame('tool_use', { id: 't1', name: 'bank', input: { a: 1 }, round: 2 })
                + frame('tool_result', { id: 't1', name: 'bank', ok: true, summary: 'saldo 5' })
                + frame('tool_use', { id: 't2', name: 'mail' })
                + frame('tool_result', { id: 't2', name: 'mail', ok: false })
                + frame('llm_done', { rounds: [{ ttftMs: 77 }] })
                + frame('done', { assistantText: '  Je saldo is 5 euro.  ' }),
            ]),
        };
        const onTurnComplete = vi.fn();
        const { result } = renderHook(() => useVoiceSession({
            getHistory: () => [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hidden', isHidden: true },
                { role: 'assistant', content: 'streaming', isStreaming: true },
                { role: 'assistant', content: 42 },
                null,
            ],
            onTurnComplete,
        }));
        await speakOneTurn(result);

        expect(JSON.parse(lastTurnForm.get('history'))).toEqual([{ role: 'user', content: 'hi' }]);
        expect(lastTurnForm.get('language')).toBe('nl');
        expect(onTurnComplete).toHaveBeenCalledTimes(1);
        const turn = onTurnComplete.mock.calls[0][0];
        expect(turn.user).toEqual({ role: 'user', content: 'wat is mijn saldo', source: 'voice' });
        expect(turn.assistant.content).toBe('  Je saldo is 5 euro.  ');
        expect(turn.assistant.tools).toEqual([
            { id: 't1', name: 'bank', input: { a: 1 }, status: 'done', round: 2, summary: 'saldo 5' },
            { id: 't2', name: 'mail', status: 'error', round: 0, summary: 'failed' },
        ]);
        expect(result.current.latency).toMatchObject({ sttMs: 120, ttftMs: 77, ttsMs: null });
        expect(result.current.partialTranscript).toBe('');
        expect(result.current.partialReply).toBe('');
        expect(result.current.turnTools).toEqual([]);
        expect(result.current.state).toBe('idle');
    });

    it('falls back to the streamed text and sticks the first confirmed language on the next turn', async () => {
        turnResponse = {
            ok: true,
            body: bodyOf([frame('transcript', { text: 'dit is een zin', language: 'NL-nl' })
                + frame('text', { delta: 'Hallo' }) + frame('done', {})]),
        };
        const onTurnComplete = vi.fn();
        const { result } = renderHook(() => useVoiceSession({ onTurnComplete }));
        await speakOneTurn(result);
        expect(onTurnComplete.mock.calls[0][0].assistant).toEqual({ role: 'assistant', content: 'Hallo', source: 'voice', tools: [] });
        // second turn: sticky 'nl' beats the session language
        turnResponse = { ok: true, body: bodyOf([frame('done', {})]) };
        await vadFrame(0.05);
        await vadFrame(0.001, 1000);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(lastTurnForm.get('language')).toBe('nl');
    });

    it('does not report a turn without a transcript', async () => {
        turnResponse = { ok: true, body: bodyOf([frame('no_speech', {}) + frame('done', {})]) };
        const onTurnComplete = vi.fn();
        const { result } = renderHook(() => useVoiceSession({ onTurnComplete }));
        await speakOneTurn(result);
        expect(onTurnComplete).not.toHaveBeenCalled();
        expect(result.current.state).toBe('idle');
    });

    it.each([
        ['no_voice_configured', /Voxtral TTS needs a voice/],
        ['tts_failed', /Voice synthesis failed/],
        ['other', /No text-to-speech provider is configured/],
    ])('tts_unavailable (%s) sets the matching notice', async (reason, text) => {
        turnResponse = { ok: true, body: bodyOf([frame('tts_unavailable', { reason }) + frame('done', {})]) };
        const { result } = renderHook(() => useVoiceSession({}));
        await speakOneTurn(result);
        expect(result.current.notice).toMatch(text);
    });

    it('an error event puts the hook in the error state with the message', async () => {
        turnResponse = { ok: true, body: bodyOf([frame('error', { message: 'boom' })]) };
        const { result } = renderHook(() => useVoiceSession({}));
        await speakOneTurn(result);
        expect(result.current.error).toBe('boom');
        expect(result.current.state).toBe('error');
    });

    it('a non-OK turn response shows the server message and errors', async () => {
        turnResponse = { ok: false, status: 500, json: async () => ({ message: 'upstream down' }) };
        const { result } = renderHook(() => useVoiceSession({}));
        await speakOneTurn(result);
        expect(result.current.error).toBe('upstream down');
        expect(result.current.state).toBe('error');
    });

    it('a network failure errors; an abort goes back to idle', async () => {
        const { result } = renderHook(() => useVoiceSession({}));
        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/ai/voice/session')) return { ok: true, json: async () => ({}) };
            throw new Error('offline');
        });
        await speakOneTurn(result);
        expect(result.current.error).toBe('offline');
        expect(result.current.state).toBe('error');

        const second = renderHook(() => useVoiceSession({}));
        authFetch.mockImplementation(async (url) => {
            if (String(url).endsWith('/ai/voice/session')) return { ok: true, json: async () => ({}) };
            const e = new Error('aborted');
            e.name = 'AbortError';
            throw e;
        });
        await speakOneTurn(second.result);
        expect(second.result.current.error).toBeNull();
        expect(second.result.current.state).toBe('idle');
    });

    it('connect() surfaces the server message of a failed session start and releases everything', async () => {
        authFetch.mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({ error: 'no voice for you' }) }));
        const { result } = renderHook(() => useVoiceSession({}));
        await act(async () => { await expect(result.current.connect({})).rejects.toThrow('no voice for you'); });
        expect(result.current.error).toBe('no voice for you');
        expect(result.current.state).toBe('error');
    });
});
