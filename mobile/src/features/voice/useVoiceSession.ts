/**
 * The voice conversation, as a state machine.
 *
 * Voice mode is a phone call with Bee Flow: the mic goes hot, you talk, it
 * answers out loud, and the mic goes hot again. Everything that makes that feel
 * like a call rather than like a form lives in here.
 *
 * Four decisions worth knowing before reading the code:
 *
 *   1. THE TURN ENDS BY ITSELF. Holding a button to talk is how a walkie-talkie
 *      works, not how a conversation does — and it makes the one-handed case
 *      (phone at your ear, or on a table while you cook) impossible. An
 *      energy-gated silence detector, fed by expo-audio's metering, submits the
 *      turn about a second after you stop talking. Tapping the orb submits
 *      immediately for the impatient case.
 *   2. THE SILENCE THRESHOLD IS ADAPTIVE. A fixed dB gate works in a quiet room
 *      and nowhere else: a car, a café or a laptop fan sits well above any
 *      threshold low enough to catch a soft voice. The noise floor is tracked
 *      continuously and speech is "meaningfully above the floor", which is the
 *      only version of this that survives leaving the office.
 *   3. THE HISTORY IS THE ONLY COPY. /ai/voice/turn is stateless (see the
 *      header of server/routes/ai/voice.js): every turn re-sends the whole
 *      conversation, and if this hook loses it, the assistant loses the thread
 *      mid-sentence. It is therefore held in a ref that nothing resets except
 *      an explicit hang-up.
 *   4. no_speech AND tts_unavailable ARE NOT ERRORS. Not hearing anything, and
 *      having no voice configured to answer with, are both ordinary outcomes of
 *      a working system. They set `notice`, which the screen shows as a line of
 *      text; `error` is reserved for things that actually broke.
 */

import {
    getRecordingPermissionsAsync,
    requestRecordingPermissionsAsync,
    setAudioModeAsync,
    useAudioPlayer,
    useAudioRecorder,
    type RecordingOptions,
} from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createSession, streamVoiceTurn, type CreateSessionInput } from './api';
import { createSilenceGate } from './silenceGate';
import {
    EMPTY_TURN,
    type DoneEvent,
    type LiveTurn,
    type TextDeltaEvent,
    type ToolResultEvent,
    type ToolUseEvent,
    type TranscriptEvent,
    type TtsEvent,
    type TtsUnavailableEvent,
    type VoiceHistoryEntry,
    type VoiceMessage,
    type VoicePhase,
    type VoiceSession,
    type VoiceToolActivity,
} from './types';
import { ApiError } from '../../api/client';

/**
 * Speech, in short bursts.
 *
 * Same encoder settings as the meeting recorder (src/features/recording/
 * useRecorder.ts) — mono AAC at 64 kbit/s is well above what Voxtral can use
 * and is known to prepare on the devices this app ships to. A 60-second turn is
 * under half a megabyte, so there is nothing to gain by squeezing it further
 * and a working microphone to lose.
 *
 * `directory: 'cache'` because a turn is worth nothing once it is transcribed;
 * the meeting recorder writes to the document directory precisely because the
 * opposite is true there.
 */
const TURN_RECORDING: RecordingOptions = {
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 64000,
    isMeteringEnabled: true,
    directory: 'cache',
    android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
    ios: { audioQuality: 96, outputFormat: 'aac ' },
    web: { mimeType: 'audio/webm', bitsPerSecond: 64000 },
};

/**
 * The container is MPEG-4 with AAC inside. `audio/m4a` is not a registered
 * type; `audio/mp4` satisfies both multer's `audio/*` filter and Voxtral.
 */
const TURN_MIME = 'audio/mp4';

const KEEP_AWAKE_TAG = 'beeflow-voice';

/** Metering poll. 10 Hz is enough for both the meter and the silence gate. */
const POLL_MS = 100;

/** Anything shorter than this is a cough, a door, or a knuckle on the desk. */
const MIN_UTTERANCE_MS = 400;

/**
 * Turns of context sent with each turn.
 *
 * The whole history goes up the wire on EVERY turn, so this is a bandwidth and
 * a latency number as much as a memory one. Twelve exchanges is far more than a
 * spoken conversation refers back to, and keeps the multipart body small enough
 * that the upload is never the slow part.
 */
const MAX_HISTORY_MESSAGES = 24;

/** Token flush interval — same reasoning as useChatStream's. */
const FLUSH_INTERVAL_MS = 50;

const PLAYBACK_POLL_MS = 250;

/** How long to wait for playback to actually start before giving up on it. */
const PLAYBACK_START_GRACE_MS = 8_000;

export interface MicPermission {
    granted: boolean;
    /** False once Android's "don't ask again" has been spent. */
    canAskAgain: boolean;
    /** True until the first check resolves, so the UI can wait rather than lie. */
    unknown: boolean;
}

export type UseVoiceSessionOptions = CreateSessionInput;

export interface UseVoiceSession {
    phase: VoicePhase;
    session: VoiceSession | null;
    /** Committed turns, oldest first. The only copy that exists. */
    messages: VoiceMessage[];
    /** The turn in flight — partial transcript, streaming reply, live tools. */
    live: LiveTurn;
    /** Mic level, 0..1, for the orb. Meaningful only while listening. */
    level: number;
    /** Seconds of the current utterance. Zero while nothing is being said. */
    elapsed: number;
    permission: MicPermission;
    /** Something broke. Shown as an error, with a way out. */
    error: unknown;
    /** Something ordinary happened that the user should know about. */
    notice: string | null;
    connect: () => Promise<void>;
    hangUp: () => void;
    /**
     * The one big button. Does the right thing for the current phase: send the
     * turn now, interrupt the reply, cancel the request, or start the call.
     */
    pressPrimary: () => void;
    /** Re-read the OS permission without prompting. Cheap and idempotent. */
    refreshPermission: () => Promise<MicPermission>;
    /** Shows the system dialog. Only call after explaining why. */
    requestPermission: () => Promise<MicPermission>;
    clearError: () => void;
    clearNotice: () => void;
}

function asRecord(data: unknown): Record<string, unknown> {
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

export function useVoiceSession(options: UseVoiceSessionOptions = {}): UseVoiceSession {
    const [phase, setPhaseState] = useState<VoicePhase>('offline');
    const [session, setSession] = useState<VoiceSession | null>(null);
    const [messages, setMessages] = useState<VoiceMessage[]>([]);
    const [live, setLive] = useState<LiveTurn>(EMPTY_TURN);
    const [level, setLevel] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState<unknown>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [permission, setPermission] = useState<MicPermission>({
        granted: false,
        canAskAgain: true,
        unknown: true,
    });

    const recorder = useAudioRecorder(TURN_RECORDING);
    // No source yet; each reply replaces it. The hook releases the player on
    // unmount, which is what stops a half-spoken answer when the screen closes.
    const player = useAudioPlayer(null, { updateInterval: PLAYBACK_POLL_MS });

    // ── Machine state ────────────────────────────────────────────────
    // The polling loops below are installed once and therefore capture the
    // first render's closures; everything they read has to live in a ref. Same
    // bug, and the same fix, as the web hook's sessionRef.
    const phaseRef = useRef<VoicePhase>('offline');
    const sessionRef = useRef<VoiceSession | null>(null);
    const sessionAt = useRef(0);
    const historyRef = useRef<VoiceHistoryEntry[]>([]);
    const optionsRef = useRef(options);
    const abortRef = useRef<AbortController | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const flusherRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const liveRef = useRef<LiveTurn>({ ...EMPTY_TURN });
    const dirtyRef = useRef(false);

    /** The cache file the current reply is playing from, so it can be cleaned. */
    const lastReply = useRef<string | null>(null);

    // Silence gate.
    const gate = useRef(createSilenceGate());

    /**
     * Sticky STT language.
     *
     * Voxtral guesses the language per clip and gets it wrong on short ones — a
     * single Dutch word is regularly tagged Italian, and the server turns that
     * guess into a "reply in Italian" directive. Once a substantial transcript
     * has named a language, it is pinned for the rest of the call.
     */
    const stickyLanguage = useRef<string | null>(null);

    useEffect(() => {
        optionsRef.current = options;
    }, [options]);

    const setPhase = useCallback((next: VoicePhase) => {
        phaseRef.current = next;
        setPhaseState(next);
    }, []);

    const publishLive = useCallback(() => {
        if (!dirtyRef.current) return;
        dirtyRef.current = false;
        setLive({ ...liveRef.current, tools: [...liveRef.current.tools] });
    }, []);

    const stopFlusher = useCallback(() => {
        if (flusherRef.current) clearInterval(flusherRef.current);
        flusherRef.current = null;
        publishLive();
    }, [publishLive]);

    const stopPolling = useCallback(() => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
    }, []);

    // ── Permissions ──────────────────────────────────────────────────

    const refreshPermission = useCallback(async (): Promise<MicPermission> => {
        try {
            const res = await getRecordingPermissionsAsync();
            const next = { granted: res.granted, canAskAgain: res.canAskAgain, unknown: false };
            setPermission(next);
            return next;
        } catch {
            // Failing to READ the permission is not a denial.
            const next = { granted: false, canAskAgain: true, unknown: false };
            setPermission(next);
            return next;
        }
    }, []);

    const requestPermission = useCallback(async (): Promise<MicPermission> => {
        try {
            const res = await requestRecordingPermissionsAsync();
            const next = { granted: res.granted, canAskAgain: res.canAskAgain, unknown: false };
            setPermission(next);
            return next;
        } catch (err) {
            setError(err);
            const next = { granted: false, canAskAgain: false, unknown: false };
            setPermission(next);
            return next;
        }
    }, []);

    // ── Audio session ────────────────────────────────────────────────

    /**
     * Android routes playback to the earpiece — quietly, and at call volume —
     * while a capture session is open, so the reply has to be spoken with
     * recording explicitly off. Flipping back before the next turn is what
     * makes the loop work at all.
     */
    const audioModeFor = useCallback(async (mode: 'record' | 'play') => {
        try {
            await setAudioModeAsync({
                allowsRecording: mode === 'record',
                playsInSilentMode: true,
                shouldRouteThroughEarpiece: false,
                interruptionMode: 'doNotMix',
            });
        } catch {
            /* the session is being reconfigured anyway */
        }
    }, []);

    // ── Capture ──────────────────────────────────────────────────────

    const resetGate = useCallback(() => {
        gate.current.reset(Date.now());
        setLevel(0);
        setElapsed(0);
    }, []);

    /** Stop the encoder and hand back the file, or null if there is none. */
    const stopCapture = useCallback(async (): Promise<string | null> => {
        stopPolling();
        try {
            await recorder.stop();
        } catch {
            /* stopping a recorder that never started is not a failure */
        }
        setLevel(0);
        return recorder.uri ?? null;
    }, [recorder, stopPolling]);

    const discardFile = useCallback((uri: string | null) => {
        if (!uri) return;
        try {
            new File(uri).delete();
        } catch {
            /* already gone */
        }
    }, []);

    // Forward declarations: the poll loop both submits and restarts the capture
    // it is itself running inside, and each of those calls back into the loop.
    // Refs break the cycle without hoisting anything into anything else.
    const submitRef = useRef<(uri: string | null, spokeMs: number) => void>(() => {});
    const relistenRef = useRef<() => void>(() => {});

    const startListening = useCallback(async (): Promise<boolean> => {
        await audioModeFor('record');
        try {
            await recorder.prepareToRecordAsync(TURN_RECORDING);
            recorder.record();
        } catch (err) {
            setError(err);
            setPhase('offline');
            return false;
        }

        resetGate();
        setPhase('listening');

        stopPolling();
        pollRef.current = setInterval(() => {
            let status;
            try {
                status = recorder.getStatus();
            } catch {
                return;
            }
            // Everything about WHEN the turn ends is in silenceGate.ts, where
            // it can be put in a café without a microphone. This loop only
            // carries out what the gate decided.
            const decision = gate.current.feed({
                db: status.metering,
                durationMillis: status.durationMillis,
                now: Date.now(),
            });
            setLevel(decision.level);
            setElapsed(decision.elapsedSeconds);

            if (decision.kind === 'restart') {
                stopPolling();
                void (async () => {
                    const stale = await stopCapture();
                    discardFile(stale);
                    relistenRef.current();
                })();
                return;
            }

            if (decision.kind === 'submit') {
                stopPolling();
                const { spokenMs } = decision;
                void (async () => {
                    const uri = await stopCapture();
                    submitRef.current(uri, spokenMs);
                })();
            }
        }, POLL_MS);

        return true;
    }, [audioModeFor, discardFile, recorder, resetGate, setPhase, stopCapture, stopPolling]);

    // ── Playback ─────────────────────────────────────────────────────

    /**
     * Play the reply.
     *
     * The `tts` frame carries base64 MP3 inline, and expo-audio wants a source
     * it can open. Rather than trust a `data:` URI through ExoPlayer's data
     * sources, the bytes go to a file in the cache — expo-file-system's
     * File.write() takes base64 directly, so nothing has to be decoded in JS.
     * Exactly one reply file is kept alive at a time (the previous one is
     * removed as soon as the player has moved on), so a long call does not
     * leave a trail of MP3s behind it.
     */
    const playReply = useCallback(
        async (tts: TtsEvent): Promise<boolean> => {
            try {
                const dir = new Directory(Paths.cache, 'voice');
                if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
                // A new name per reply rather than one reused file: the player
                // may still hold the previous one open, and overwriting a file
                // ExoPlayer has a handle on is how you get the last answer
                // played twice. The old one is removed once the player has
                // moved on, below.
                const file = new File(dir, `reply-${Date.now()}.mp3`);
                file.create({ overwrite: true });
                file.write(tts.audioBase64, { encoding: 'base64' });

                await audioModeFor('play');
                player.replace({ uri: file.uri });
                player.play();

                const previous = lastReply.current;
                lastReply.current = file.uri;
                discardFile(previous);
                return true;
            } catch (err) {
                // Playback is the part that can fail without the answer being
                // lost — the text is already on screen. Say so and move on.
                if (__DEV__) console.warn('[voice] playback failed', err);
                return false;
            }
        },
        [audioModeFor, discardFile, player],
    );

    /**
     * Watch the reply to its end and reopen the mic.
     *
     * Polled rather than event-driven: `didJustFinish` does arrive, but a
     * playback that never starts (a truncated MP3, a device with the media
     * session taken) emits nothing at all, and a call that silently stops
     * listening is worse than one that cuts an answer short. `startedAt` gives
     * that case a bounded wait.
     */
    const watchPlayback = useCallback(() => {
        stopPolling();
        const startedAt = Date.now();
        let sawPlaying = false;

        pollRef.current = setInterval(() => {
            if (phaseRef.current !== 'speaking') {
                stopPolling();
                return;
            }
            if (player.playing) {
                sawPlaying = true;
                return;
            }
            const waited = Date.now() - startedAt;
            if (!sawPlaying && waited < PLAYBACK_START_GRACE_MS) return;

            stopPolling();
            void startListening();
        }, PLAYBACK_POLL_MS);
    }, [player, startListening, stopPolling]);

    // ── One turn ─────────────────────────────────────────────────────

    /** Refresh the session once it is older than the server's stated lifetime. */
    const ensureSession = useCallback(async (): Promise<VoiceSession> => {
        const current = sessionRef.current;
        const age = Date.now() - sessionAt.current;
        if (current && age < current.sessionTimeoutMs) return current;

        // The history is deliberately NOT cleared: the server holds no state,
        // so a new session id costs nothing and the conversation continues.
        const next = await createSession(optionsRef.current);
        sessionRef.current = next;
        sessionAt.current = Date.now();
        setSession(next);
        return next;
    }, []);

    const submit = useCallback(
        async (uri: string | null, spokenMs: number) => {
            if (!uri) {
                void startListening();
                return;
            }
            if (spokenMs < MIN_UTTERANCE_MS) {
                // A door, a cough, a knuckle on the table. Drop it silently and
                // keep listening — announcing it would be noise about noise.
                discardFile(uri);
                void startListening();
                return;
            }

            setPhase('thinking');
            setNotice(null);
            liveRef.current = { ...EMPTY_TURN };
            dirtyRef.current = true;
            publishLive();
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

            if (flusherRef.current) clearInterval(flusherRef.current);
            flusherRef.current = setInterval(publishLive, FLUSH_INTERVAL_MS);

            const controller = new AbortController();
            abortRef.current = controller;

            let heardNothing = false;
            let tts: TtsEvent | null = null;
            let ttsNotice: string | null = null;
            let finalText = '';
            let failed: string | null = null;

            try {
                const active = await ensureSession();
                for await (const frame of streamVoiceTurn({
                    audioUri: uri,
                    mimeType: TURN_MIME,
                    fileName: 'turn.m4a',
                    history: historyRef.current.slice(-MAX_HISTORY_MESSAGES),
                    session: active,
                    language: stickyLanguage.current ?? active.language,
                    signal: controller.signal,
                })) {
                    const d = asRecord(frame.data);
                    switch (frame.event) {
                        case 'transcript': {
                            const payload = d as unknown as TranscriptEvent;
                            liveRef.current.transcript = payload.text ?? '';
                            dirtyRef.current = true;
                            // Only promote a language once a real sentence has
                            // confirmed it — see stickyLanguage.
                            if (
                                !stickyLanguage.current &&
                                payload.language &&
                                (payload.text?.length ?? 0) >= 8
                            ) {
                                stickyLanguage.current = String(payload.language)
                                    .toLowerCase()
                                    .slice(0, 2);
                            }
                            break;
                        }
                        case 'no_speech':
                            heardNothing = true;
                            break;
                        case 'text': {
                            const payload = d as unknown as TextDeltaEvent;
                            if (payload.delta) {
                                liveRef.current.reply += payload.delta;
                                dirtyRef.current = true;
                            }
                            break;
                        }
                        case 'thinking':
                            // The model's scratchpad. Deliberately not shown:
                            // there is nowhere to read it in a hands-free UI,
                            // and it is not what gets spoken.
                            break;
                        case 'tool_use': {
                            const payload = d as unknown as ToolUseEvent;
                            const tool: VoiceToolActivity = {
                                id: payload.id || payload.name,
                                name: payload.name,
                                status: 'running',
                            };
                            liveRef.current.tools = [...liveRef.current.tools, tool];
                            dirtyRef.current = true;
                            break;
                        }
                        case 'tool_result': {
                            const payload = d as unknown as ToolResultEvent;
                            liveRef.current.tools = liveRef.current.tools.map((t) =>
                                t.id === payload.id || t.name === payload.name
                                    ? {
                                          ...t,
                                          status: payload.ok ? 'done' : 'error',
                                          summary: payload.summary ?? t.summary,
                                      }
                                    : t,
                            );
                            dirtyRef.current = true;
                            break;
                        }
                        case 'llm_done':
                            // Per-round latency metrics. Useful in a dashboard,
                            // meaningless to someone holding a phone.
                            break;
                        case 'tts':
                            tts = d as unknown as TtsEvent;
                            break;
                        case 'tts_unavailable':
                            ttsNotice = describeTtsGap(d as unknown as TtsUnavailableEvent);
                            break;
                        case 'done': {
                            const payload = d as unknown as DoneEvent;
                            // Prefer the server's cleaned text: it is what TTS
                            // actually said, with any leaked JSON stripped.
                            finalText = payload.assistantText?.trim()
                                ? payload.assistantText
                                : liveRef.current.reply;
                            if (payload.transcript) liveRef.current.transcript = payload.transcript;
                            break;
                        }
                        case 'error':
                            failed = typeof d.message === 'string' ? d.message : 'Voice turn failed';
                            break;
                        default:
                            if (__DEV__) console.warn(`[voice] unhandled SSE event: ${frame.event}`);
                    }
                }
            } catch (err) {
                stopFlusher();
                discardFile(uri);
                if (controller.signal.aborted) {
                    // The user cancelled, or hung up. Nothing to report.
                    if (phaseRef.current !== 'offline') void startListening();
                    return;
                }
                setError(err);
                // A refusal is settled — retrying by talking louder will not fix
                // a plan limit or a missing API key, so end the call and let the
                // screen explain. Anything else, keep the mic open.
                const settled =
                    err instanceof ApiError &&
                    (err.status === 402 || err.status === 403 || err.status === 409);
                if (settled) {
                    setPhase('offline');
                    void audioModeFor('play');
                } else {
                    void startListening();
                }
                return;
            } finally {
                stopFlusher();
                abortRef.current = null;
            }

            discardFile(uri);

            if (failed) {
                // An `error` frame is a real failure (STT down, the model call
                // throwing) but a recoverable one, so it is reported as an
                // error and the mic reopens. Wrapped in ApiError purely so
                // describeError says what the server said rather than "Try
                // again."
                setError(new ApiError(failed));
                void startListening();
                return;
            }

            if (heardNothing) {
                setNotice('I did not catch that.');
                void startListening();
                return;
            }

            const spokenTranscript = liveRef.current.transcript.trim();
            const reply = (finalText || liveRef.current.reply).trim();
            const tools = [...liveRef.current.tools];
            const at = Date.now();
            const committed: VoiceMessage[] = [];
            if (spokenTranscript) {
                committed.push({
                    id: Crypto.randomUUID(),
                    role: 'user',
                    content: spokenTranscript,
                    at,
                });
                historyRef.current.push({ role: 'user', content: spokenTranscript });
            }
            if (reply || tools.length) {
                committed.push({
                    id: Crypto.randomUUID(),
                    role: 'assistant',
                    content: reply,
                    tools: tools.length ? tools : undefined,
                    at: at + 1,
                });
                if (reply) historyRef.current.push({ role: 'assistant', content: reply });
            }
            if (committed.length) setMessages((prev) => [...prev, ...committed]);

            liveRef.current = { ...EMPTY_TURN };
            dirtyRef.current = true;
            publishLive();

            if (ttsNotice) setNotice(ttsNotice);

            if (tts?.audioBase64) {
                setPhase('speaking');
                const started = await playReply(tts);
                if (started) {
                    watchPlayback();
                    return;
                }
                setNotice('The reply could not be played aloud.');
            }
            void startListening();
        },
        [
            audioModeFor,
            discardFile,
            ensureSession,
            playReply,
            publishLive,
            setPhase,
            startListening,
            stopFlusher,
            watchPlayback,
        ],
    );

    useEffect(() => {
        submitRef.current = (uri, spokenMs) => {
            void submit(uri, spokenMs);
        };
    }, [submit]);

    useEffect(() => {
        relistenRef.current = () => {
            void startListening();
        };
    }, [startListening]);

    // ── Lifecycle ────────────────────────────────────────────────────

    const connect = useCallback(async () => {
        setError(null);
        setNotice(null);
        setPhase('connecting');

        const perm = permission.unknown ? await refreshPermission() : permission;
        if (!perm.granted) {
            const asked = await requestPermission();
            if (!asked.granted) {
                setPhase('offline');
                return;
            }
        }

        try {
            const next = await createSession(optionsRef.current);
            sessionRef.current = next;
            sessionAt.current = Date.now();
            setSession(next);
        } catch (err) {
            setError(err);
            setPhase('offline');
            return;
        }

        // A conversation you have to keep tapping to keep alive is not a
        // conversation. The lock is released on hang-up and on unmount.
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
        await startListening();
    }, [permission, refreshPermission, requestPermission, setPhase, startListening]);

    const hangUp = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        stopPolling();
        stopFlusher();
        setPhase('offline');
        try {
            player.pause();
        } catch {
            /* nothing loaded */
        }
        void (async () => {
            const uri = await stopCapture();
            discardFile(uri);
            discardFile(lastReply.current);
            lastReply.current = null;
            await audioModeFor('play');
        })();
        deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
        liveRef.current = { ...EMPTY_TURN };
        dirtyRef.current = true;
        publishLive();
        setLevel(0);
        setElapsed(0);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }, [
        audioModeFor,
        discardFile,
        player,
        publishLive,
        setPhase,
        stopCapture,
        stopFlusher,
        stopPolling,
    ]);

    const pressPrimary = useCallback(() => {
        switch (phaseRef.current) {
            case 'offline':
                void connect();
                return;
            case 'connecting':
                return;
            case 'listening': {
                // Send what we have — ALWAYS, even if the silence gate never
                // opened. A tap that does nothing because the room was noisier
                // than the gate expected is the worst possible failure here;
                // sending it and hearing "I did not catch that" at least tells
                // the user what happened.
                const startedAt = gate.current.closeUtterance();
                stopPolling();
                void (async () => {
                    const uri = await stopCapture();
                    const spokenMs = startedAt ? Date.now() - startedAt : MIN_UTTERANCE_MS;
                    void submit(uri, Math.max(spokenMs, MIN_UTTERANCE_MS));
                })();
                return;
            }
            case 'thinking':
                // Abort the request. The reader's cancel closes the socket,
                // which is what stops the model call server-side.
                abortRef.current?.abort();
                return;
            case 'speaking':
                // Barge-in, by tap. A phone cannot listen through its own
                // speaker well enough to do this by voice.
                try {
                    player.pause();
                } catch {
                    /* nothing loaded */
                }
                stopPolling();
                void startListening();
                return;
        }
    }, [connect, player, startListening, stopCapture, stopPolling, submit]);

    // Belt and braces: a live interval polling a released recorder, or a wake
    // lock nobody releases, both outlive the screen.
    useEffect(
        () => () => {
            abortRef.current?.abort();
            if (pollRef.current) clearInterval(pollRef.current);
            if (flusherRef.current) clearInterval(flusherRef.current);
            deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
            void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        },
        [],
    );

    return {
        phase,
        session,
        messages,
        live,
        level,
        elapsed,
        permission,
        error,
        notice,
        connect,
        hangUp,
        pressPrimary,
        refreshPermission,
        requestPermission,
        clearError: () => setError(null),
        clearNotice: () => setNotice(null),
    };
}

/**
 * Turn a `tts_unavailable` reason into something an end user can act on.
 *
 * The web client shows admin-facing prose here ("create a voice via POST
 * /v1/audio/voices"); on a phone the person holding it is usually not the
 * person with the API keys, so this says what happened and who can fix it.
 */
function describeTtsGap(event: TtsUnavailableEvent): string {
    switch (event.reason) {
        case 'no_voice_configured':
            return 'No voice is set up to speak with yet — showing the reply as text. An administrator can add one in Admin → AI Config.';
        case 'tts_failed':
            return 'Speaking the reply failed, so here it is as text.';
        default:
            return 'No text-to-speech is configured on this server, so replies appear as text.';
    }
}
