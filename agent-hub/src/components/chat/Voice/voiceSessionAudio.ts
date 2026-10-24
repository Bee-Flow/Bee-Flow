import type { MutableRefObject } from 'react';
import type { VoiceState, VoiceStates } from './useVoiceSession.types';
import { logger } from '../../../utils/logger';

export const VOICE_STATES: VoiceStates = {
    IDLE: 'idle',           // mic hot, waiting for speech
    LISTENING: 'listening', // actively capturing speech
    THINKING: 'thinking',   // STT + LLM in flight
    SPEAKING: 'speaking',   // TTS playing (barge-in enabled)
    ERROR: 'error',
};

// ─── VAD tuning ────────────────────────────────────────────────
export const VAD_FFT_SIZE = 1024;              // analyser block size
export const VAD_POLL_MS = 50;                 // evaluate energy 20×/s
export const VAD_SPEECH_RMS = 0.018;           // start-of-speech threshold
export const VAD_SILENCE_RMS = 0.012;          // end-of-speech threshold (hysteresis)
export const VAD_SILENCE_MS = 900;             // trailing silence to end a turn
export const VAD_MIN_UTTERANCE_MS = 400;       // discard anything shorter
export const VAD_MAX_UTTERANCE_MS = 30_000;    // hard cap — always flush at 30s

export function pickMimeType() {
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
    ];
    for (const m of candidates) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) {
            return m;
        }
    }
    return '';
}

/** Root-mean-square energy of the analyser's current time-domain block. */
export function readRms(analyser: AnalyserNode): number {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
}

export interface PipelineRefs {
    mediaStreamRef: MutableRefObject<MediaStream | null>;
    audioCtxRef: MutableRefObject<AudioContext | null>;
    analyserRef: MutableRefObject<AnalyserNode | null>;
}

/**
 * Ask for the mic and build the VAD pipeline. Each ref is written as soon as
 * its object exists, so a failure part-way still leaves the earlier ones for
 * the caller's cleanup to release.
 */
export async function openVadPipeline(refs: PipelineRefs): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    });
    refs.mediaStreamRef.current = stream;

    // Set up the VAD pipeline.
    // NB: AudioContext sample rate may differ from mic capture rate,
    // but for energy-based VAD the absolute rate doesn't matter — we
    // only care about relative amplitude.
    const AudioCtxCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtxCtor();
    refs.audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = VAD_FFT_SIZE;
    source.connect(analyser);
    refs.analyserRef.current = analyser;
}

export interface PlaybackDeps {
    audioElRef: MutableRefObject<HTMLAudioElement | null>;
    voiceActiveRef: MutableRefObject<boolean>;
    setStateSync: (next: VoiceState) => void;
}

/** Play a base64 TTS clip; SPEAKING while it plays, back to IDLE when it ends or fails. */
export function playTtsAudio(b64: string, mime: string, deps: PlaybackDeps): void {
    const { audioElRef, voiceActiveRef, setStateSync } = deps;
    try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioElRef.current = audio;
        audio.onplay = () => setStateSync(VOICE_STATES.SPEAKING);
        const finish = () => {
            URL.revokeObjectURL(url);
            audioElRef.current = null;
            if (voiceActiveRef.current) setStateSync(VOICE_STATES.IDLE);
        };
        audio.onended = finish;
        audio.onerror = finish;
        audio.play().catch(finish);
    } catch (err) {
        console.error('[useVoiceSession] playback error:', err);
        if (voiceActiveRef.current) setStateSync(VOICE_STATES.IDLE);
    }
}

export interface ReleaseRefs extends PipelineRefs {
    recorderRef: MutableRefObject<MediaRecorder | null>;
    abortRef: MutableRefObject<AbortController | null>;
    audioElRef: MutableRefObject<HTMLAudioElement | null>;
    chunksRef: MutableRefObject<Blob[]>;
    speakingRef: MutableRefObject<boolean>;
}

/** Stop the recorder, mic tracks, audio context, in-flight turn and playback, then clear every ref (in that order). */
export function releaseVoiceResources(r: ReleaseRefs): void {
    try { r.recorderRef.current?.stop(); } catch (err) { logger.debug('noop', err); }
    try { r.mediaStreamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop()); } catch (err) { logger.debug('noop', err); }
    try { r.audioCtxRef.current?.close(); } catch (err) { logger.debug('noop', err); }
    try { r.abortRef.current?.abort(); } catch (err) { logger.debug('noop', err); }
    try { r.audioElRef.current?.pause(); } catch (err) { logger.debug('noop', err); }
    r.recorderRef.current = null;
    r.mediaStreamRef.current = null;
    r.audioCtxRef.current = null;
    r.analyserRef.current = null;
    r.abortRef.current = null;
    r.audioElRef.current = null;
    r.chunksRef.current = [];
    r.speakingRef.current = false;
}
