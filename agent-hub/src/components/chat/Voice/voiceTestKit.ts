import { act } from '@testing-library/react';
import { vi } from 'vitest';
import { authFetch } from '../../../utils/helpers';

// Shared fixtures of the useVoiceSession tests. jsdom has neither
// MediaRecorder, getUserMedia nor WebAudio, and the hook drives all three: the
// stubs are the minimum the VAD → record → submit path touches (an analyser
// whose RMS the test scripts frame by frame, a recorder that hands back one
// chunk on stop()). Callers mock '../../../utils/helpers' themselves.

/** The scripted mic energy and clock the VAD reads. */
export const mic = { rms: 0, nowMs: 0 };

class FakeMediaRecorder {
    state = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable?: (e: { data: Blob }) => void;
    onstop?: () => void;
    static isTypeSupported() { return true; }
    start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    }
    stop() { this.state = 'inactive'; this.onstop?.(); }
}

/** Fake timers, the scripted clock and the browser stubs; undo with `removeVoiceStubs`. */
export function installVoiceStubs(): void {
    mic.rms = 0;
    mic.nowMs = 0;
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => mic.nowMs);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [] }) }, configurable: true });
    vi.stubGlobal('AudioContext', class {
        createMediaStreamSource() { return { connect() {} }; }
        createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(buf: Float32Array) { buf.fill(mic.rms); } }; }
        close() {}
    });
}

export function removeVoiceStubs(): void {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
}

/** Run one VAD poll at the given energy, `dt` ms after the previous one. */
export async function vadFrame(energy: number, dt = 50): Promise<void> {
    mic.rms = energy;
    mic.nowMs += dt;
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
}

/** connect(), then speak one utterance and let the VAD close the turn. */
export async function speakOneTurn(result: { current: { connect: (o: object) => Promise<unknown> } }): Promise<void> {
    await act(async () => { await result.current.connect({ agentId: 'agent-42' }); });
    await vadFrame(0.05);          // loud   → startRecording()
    await vadFrame(0.001, 1000);   // silent → 1000ms trailing silence closes the turn
    // finishRecording awaits the recorder's blob before POSTing.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

export const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A response body that hands the given chunks over one read at a time. */
export function bodyOf(chunks: string[]) {
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

/** authFetch is mocked with loosely shaped fakes; this is the one place they meet its type. */
export function mockFetch(impl: (url: unknown, opts?: RequestInit) => Promise<unknown>): void {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(impl as typeof authFetch);
}
