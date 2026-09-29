import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useVoiceSession from './useVoiceSession';
import { authFetch } from '../../../utils/helpers';

// The hook's only network seam.
vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

// ─── Browser stubs ────────────────────────────────────────────────────────────
// jsdom has neither MediaRecorder, getUserMedia nor WebAudio, and the hook
// drives all three. The stubs are the minimum the VAD → record → submit path
// touches: an analyser whose RMS we script frame by frame, and a recorder that
// hands back one chunk on stop().

let rms = 0;          // scripted mic energy for the next VAD tick
let nowMs = 0;        // scripted performance.now()

class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    }
    stop() {
        this.state = 'inactive';
        this.onstop?.();
    }
}

const sseResponse = () => ({
    ok: true,
    body: {
        getReader: () => {
            let sent = false;
            return {
                read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return {
                        done: false,
                        value: new TextEncoder().encode('event: done\ndata: {}\n\n'),
                    };
                },
            };
        },
    },
});

const SESSION = {
    model: 'claude-sonnet-4-5',
    systemPrompt: 'You are the Finance agent.',
    agentId: 'agent-42',
    voice: 'nl-nova',
    agentName: 'Finance',
};

/** Captured FormData of the last POST /ai/voice/turn. */
let lastTurnForm = null;

beforeEach(() => {
    rms = 0;
    nowMs = 0;
    lastTurnForm = null;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    globalThis.MediaRecorder = FakeMediaRecorder;
    globalThis.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [] }) };
    globalThis.AudioContext = class {
        createMediaStreamSource() { return { connect() {} }; }
        createAnalyser() {
            return {
                fftSize: 1024,
                getFloatTimeDomainData(buf) { buf.fill(rms); },
            };
        }
        close() {}
    };

    authFetch.mockReset();
    authFetch.mockImplementation(async (url, opts) => {
        if (String(url).endsWith('/ai/voice/session')) {
            return { ok: true, json: async () => SESSION };
        }
        if (String(url).endsWith('/ai/voice/turn')) {
            lastTurnForm = opts.body;
            return sseResponse();
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete globalThis.MediaRecorder;
    delete globalThis.AudioContext;
});

/** Run one VAD poll at the given energy, `dt` ms after the previous one. */
async function vadFrame(energy, dt = 50) {
    rms = energy;
    nowMs += dt;
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

/** connect(), then speak one utterance and let the VAD close the turn. */
async function speakOneTurn(result) {
    await act(async () => { await result.current.connect({ agentId: 'agent-42' }); });
    await vadFrame(0.05);          // loud   → startRecording()
    await vadFrame(0.001, 1000);   // silent → 1000ms trailing silence closes the turn
    // finishRecording awaits the recorder's blob before POSTing.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe('useVoiceSession', () => {
    it('connect() stores the resolved session', async () => {
        const { result } = renderHook(() => useVoiceSession({ getHistory: () => [] }));
        await act(async () => { await result.current.connect({ agentId: 'agent-42' }); });
        expect(result.current.session).toEqual(SESSION);
    });

    // Regression: finishRecording/vadTick/connect are all memoized on stable
    // deps, so they are created once on the FIRST render. Reading `session`
    // out of the render scope inside submitTurn therefore pinned every
    // VAD-driven turn to render 1's `session === null`, and the agent's
    // systemPrompt/model/agentId silently never reached POST /ai/voice/turn —
    // every voice turn ran the server's DEFAULT_SYSTEM_PROMPT and
    // DEFAULT_LLM_MODEL with the user's full (unrestricted) tool set.
    it('sends the agent prompt/model/agentId from the connected session on a VAD-driven turn', async () => {
        const { result } = renderHook(() => useVoiceSession({ getHistory: () => [] }));
        await speakOneTurn(result);

        expect(lastTurnForm).toBeInstanceOf(FormData);
        expect(lastTurnForm.get('systemPrompt')).toBe(SESSION.systemPrompt);
        expect(lastTurnForm.get('model')).toBe(SESSION.model);
        expect(lastTurnForm.get('agentId')).toBe(SESSION.agentId);
        expect(lastTurnForm.get('voice')).toBe(SESSION.voice);
        expect(lastTurnForm.get('audio')).toBeTruthy();
    });

    it('hangup() clears the session so a later turn cannot resurrect it', async () => {
        const { result } = renderHook(() => useVoiceSession({ getHistory: () => [] }));
        await act(async () => { await result.current.connect({ agentId: 'agent-42' }); });
        act(() => { result.current.hangup(); });
        expect(result.current.session).toBeNull();
    });
});
