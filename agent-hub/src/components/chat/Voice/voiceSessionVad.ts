import type { MutableRefObject } from 'react';
import type { VoiceState } from './useVoiceSession.types';
import {
    VAD_MAX_UTTERANCE_MS,
    VAD_MIN_UTTERANCE_MS,
    VAD_SILENCE_MS,
    VAD_SILENCE_RMS,
    VAD_SPEECH_RMS,
    VOICE_STATES,
    readRms,
} from './voiceSessionAudio';

/** What one VAD poll reads and writes: the hook's refs plus its recording callbacks. */
export interface VadCtx {
    analyserRef: MutableRefObject<AnalyserNode | null>;
    stateRef: MutableRefObject<VoiceState>;
    audioElRef: MutableRefObject<HTMLAudioElement | null>;
    speakingRef: MutableRefObject<boolean>;
    lastVoiceAtRef: MutableRefObject<number>;
    speechStartRef: MutableRefObject<number>;
    setLevel: (level: number) => void;
    startRecording: () => void;
    finishRecording: (submit: boolean) => Promise<void>;
    setStateSync: (next: VoiceState) => void;
}

/** One energy-VAD poll: meter, barge-in, start of speech, end of utterance. */
export function runVadTick(c: VadCtx): void {
    const analyser = c.analyserRef.current;
    if (!analyser) return;

    const rms = readRms(analyser);
    c.setLevel(Math.min(1, rms * 8));

    const now = performance.now();
    const cur = c.stateRef.current;

    // Barge-in: user starts speaking while TTS plays → interrupt.
    if (cur === VOICE_STATES.SPEAKING && rms > VAD_SPEECH_RMS) {
        try { c.audioElRef.current?.pause(); } catch (_) { /* noop */ }
        c.audioElRef.current = null;
        c.speakingRef.current = true;
        c.lastVoiceAtRef.current = now;
        c.startRecording();
        return;
    }

    // THINKING: server is working, don't capture more audio.
    if (cur === VOICE_STATES.THINKING) return;

    // IDLE: waiting for speech. Start recording on first voiced frame.
    if (!c.speakingRef.current) {
        if (rms > VAD_SPEECH_RMS) {
            c.speakingRef.current = true;
            c.lastVoiceAtRef.current = now;
            c.startRecording();
        }
        return;
    }

    // LISTENING: already capturing. Track trailing silence.
    if (rms > VAD_SILENCE_RMS) {
        c.lastVoiceAtRef.current = now;
    }
    const trailingSilenceMs = now - c.lastVoiceAtRef.current;
    const utteranceMs = now - c.speechStartRef.current;

    if (trailingSilenceMs >= VAD_SILENCE_MS || utteranceMs >= VAD_MAX_UTTERANCE_MS) {
        const wasLongEnough = utteranceMs >= VAD_MIN_UTTERANCE_MS;
        c.speakingRef.current = false;
        if (wasLongEnough) {
            c.setStateSync(VOICE_STATES.THINKING);
            c.finishRecording(true);
        } else {
            // Too short — drop it, resume listening without a turn.
            c.finishRecording(false);
        }
    }
}
