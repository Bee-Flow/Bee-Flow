/**
 * useVoiceSession — Continuous voice conversation hook (Beta v2).
 *
 * This revision removes the push-to-talk model entirely. Voice mode now
 * behaves like a phone call:
 *   - As soon as the session connects, the mic is hot.
 *   - An energy-based VAD (Voice Activity Detector) watches the stream.
 *   - When speech is detected, recording starts automatically.
 *   - When silence persists for SILENCE_MS, the turn is auto-submitted.
 *   - While TTS is playing, speech detection causes barge-in: playback
 *     stops and a new turn begins immediately.
 *
 * The host chat still owns message state — `getHistory` feeds prior
 * messages into each turn, `onTurnComplete` emits completed turns back
 * so they render as regular chat bubbles.
 *
 * Tuning constants at the top of the file. They favor responsiveness
 * over strict gating: a bit of background noise is OK because the
 * min-utterance cutoff discards clips that are too short to be speech,
 * and Voxtral's STT returns empty text for nonsense which the hook
 * treats as a no-op.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { VAD_POLL_MS, VOICE_STATES, openVadPipeline, pickMimeType, playTtsAudio, releaseVoiceResources } from './voiceSessionAudio';
import { runVadTick } from './voiceSessionVad';
import { fetchVoiceSession, streamVoiceTurn } from './voiceSessionTurn';
import type { ConnectOptions, UseVoiceSessionArgs, VoiceLatency, VoiceSessionInfo, VoiceState, VoiceTool } from './useVoiceSession.types';

const STATES = VOICE_STATES;

// The connected session, mirrored into a ref.
//
// Every function on the turn path is memoized on stable deps and is
// therefore created ONCE, on the first render: finishRecording deps
// [setStateSync], vadTick deps [finishRecording, startRecording,
// setStateSync], connect deps [cleanup, setStateSync, vadTick]. connect
// then installs setInterval(vadTick, …), so every VAD-driven turn runs the
// first render's closures. Reading the `session` STATE inside submitTurn
// therefore always saw render 1's value (`null`) no matter what
// setSession() stored, and the agent's systemPrompt/model/agentId were
// silently dropped from POST /ai/voice/turn — the server fell back to
// DEFAULT_SYSTEM_PROMPT / DEFAULT_LLM_MODEL and, with no agentId, to the
// user's full integration tool set instead of the agent's allow-list.
// A ref is the same fix the file already uses for getHistory/onTurnComplete.
export default function useVoiceSession({ getHistory, onTurnComplete }: UseVoiceSessionArgs = {}) {
    const [state, setState] = useState<VoiceState>(STATES.IDLE);
    const [session, setSession] = useState<VoiceSessionInfo | null>(null);
    const [partialReply, setPartialReply] = useState('');
    const [partialTranscript, setPartialTranscript] = useState('');
    const [turnTools, setTurnTools] = useState<VoiceTool[]>([]);
    const [level, setLevel] = useState(0);          // 0..1 mic energy for the UI meter
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [latency, setLatency] = useState<VoiceLatency | null>(null);

    const mediaStreamRef = useRef<MediaStream | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const audioElRef = useRef<HTMLAudioElement | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const stateRef = useRef<VoiceState>(STATES.IDLE);
    const speechStartRef = useRef(0);
    const lastVoiceAtRef = useRef(0);
    const speakingRef = useRef(false);
    const getHistoryRef = useRef(getHistory);
    const onTurnCompleteRef = useRef(onTurnComplete);
    // The connected session, mirrored into a ref (see the note above the hook).
    const sessionRef = useRef<VoiceSessionInfo | null>(null);
    const voiceActiveRef = useRef(false);           // true from connect() until hangup()
    // Sticky language — Voxtral is unreliable at language detection on short
    // utterances (a single Dutch word can be tagged as Italian). Once we get
    // a detected language from the server, we pass it as a hint on every
    // subsequent turn so STT stops oscillating.
    const stickyLanguageRef = useRef<string | null>(null);

    useEffect(() => { getHistoryRef.current = getHistory; }, [getHistory]);
    useEffect(() => { onTurnCompleteRef.current = onTurnComplete; }, [onTurnComplete]);

    const setStateSync = useCallback((next: VoiceState) => {
        stateRef.current = next;
        setState(next);
    }, []);

    // Same shape as setStateSync: keep the ref (read by the frozen turn-path
    // closures) and the state (read by the UI) in lockstep.
    const setSessionSync = useCallback((next: VoiceSessionInfo | null) => {
        sessionRef.current = next;
        setSession(next);
    }, []);

    const stopVad = useCallback(() => {
        if (vadIntervalRef.current) {
            clearInterval(vadIntervalRef.current);
            vadIntervalRef.current = null;
        }
    }, []);

    const cleanup = useCallback(() => {
        voiceActiveRef.current = false;
        stopVad();
        releaseVoiceResources({
            recorderRef, mediaStreamRef, audioCtxRef, analyserRef, abortRef, audioElRef, chunksRef, speakingRef,
        });
    }, [stopVad]);

    useEffect(() => () => cleanup(), [cleanup]);

    /* ── Recording helpers ─────────────────────────────────── */

    const startRecording = useCallback(() => {
        if (!mediaStreamRef.current) return;
        if (recorderRef.current && recorderRef.current.state !== 'inactive') return;

        chunksRef.current = [];
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(
            mediaStreamRef.current,
            mimeType ? { mimeType } : undefined
        );
        recorder.ondataavailable = (e: BlobEvent) => {
            if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onerror = (e: Event) => {
            console.error('[useVoiceSession] recorder error:', e);
            setError('Microphone error');
            setStateSync(STATES.ERROR);
        };
        recorderRef.current = recorder;
        recorder.start();
        speechStartRef.current = performance.now();
        setPartialTranscript('');
        setPartialReply('');
        setTurnTools([]);
        setStateSync(STATES.LISTENING);
    }, [setStateSync]);

    const finishRecording = useCallback(async (submit: boolean) => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === 'inactive') return;

        const blobPromise = new Promise<{ blob: Blob | null; mimeType: string }>((resolve) => {
            recorder.onstop = () => {
                const mimeType = recorder.mimeType || 'audio/webm';
                const blob = new Blob(chunksRef.current, { type: mimeType });
                chunksRef.current = [];
                resolve({ blob, mimeType });
            };
            try { recorder.stop(); } catch (_) { resolve({ blob: null, mimeType: 'audio/webm' }); }
        });
        const { blob, mimeType } = await blobPromise;

        if (!submit || !blob || !blob.size) {
            if (voiceActiveRef.current) setStateSync(STATES.IDLE);
            return;
        }
        await submitTurn(blob, mimeType);
        // After submission, state transitions are driven by SSE events and
        // the TTS lifecycle. The VAD keeps polling in the background.
    }, [setStateSync]);

    /* ── VAD loop ──────────────────────────────────────────── */

    const vadTick = useCallback(() => runVadTick({
        analyserRef, stateRef, audioElRef, speakingRef, lastVoiceAtRef, speechStartRef,
        setLevel, startRecording, finishRecording, setStateSync,
    }), [finishRecording, startRecording, setStateSync]);

    /* ── Connect / hangup ──────────────────────────────────── */

    const connect = useCallback(async (opts: ConnectOptions = {}) => {
        setError(null);
        setNotice(null);
        try {
            const data = await fetchVoiceSession(opts);
            setSessionSync(data);

            await openVadPipeline({ mediaStreamRef, audioCtxRef, analyserRef });

            voiceActiveRef.current = true;
            speakingRef.current = false;
            setStateSync(STATES.IDLE);
            vadIntervalRef.current = setInterval(vadTick, VAD_POLL_MS);

            return data;
        } catch (err) {
            console.error('[useVoiceSession] connect error:', err);
            setError((err as Error).message || 'Could not start voice session');
            setStateSync(STATES.ERROR);
            cleanup();
            throw err;
        }
    }, [cleanup, setSessionSync, setStateSync, vadTick]);

    /* ── Turn submission (SSE stream parser) ───────────────── */

    const submitTurn = useCallback((blob: Blob, mimeType: string) => streamVoiceTurn({
        sessionRef, getHistoryRef, onTurnCompleteRef, stickyLanguageRef, abortRef, voiceActiveRef,
        setPartialReply, setPartialTranscript, setTurnTools, setNotice, setError, setLatency, setStateSync,
        playTts: (b64, mime) => playTts(b64, mime),
    }, blob, mimeType), [setStateSync]);

    const playTts = useCallback((b64: string, mime: string) => {
        playTtsAudio(b64, mime, { audioElRef, voiceActiveRef, setStateSync });
    }, [setStateSync]);

    const hangup = useCallback(() => {
        cleanup();
        setStateSync(STATES.IDLE);
        setSessionSync(null);
        setPartialReply('');
        setPartialTranscript('');
        setTurnTools([]);
        setError(null);
        setNotice(null);
        setLevel(0);
        stickyLanguageRef.current = null;
    }, [cleanup, setSessionSync, setStateSync]);

    return {
        state,
        STATES,
        session,
        partialReply,
        partialTranscript,
        turnTools,
        level,
        error,
        notice,
        latency,
        connect,
        hangup,
    };
}
