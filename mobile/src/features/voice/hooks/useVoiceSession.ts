/**
 * The voice conversation, as a state machine.
 *
 * Voice mode is a phone call with Bee Flow: the mic goes hot, you talk, it
 * answers out loud, and the mic goes hot again. Four decisions worth knowing:
 *
 *   1. THE TURN ENDS BY ITSELF. An energy-gated silence detector (model/
 *      silenceGate.ts, fed by expo-audio's metering) submits about a second
 *      after you stop talking; tapping the orb submits immediately. Holding a
 *      button to talk makes the one-handed case impossible.
 *   2. THE SILENCE THRESHOLD IS ADAPTIVE. A fixed dB gate works in a quiet
 *      room and nowhere else; speech is "meaningfully above the noise floor".
 *   3. THE HISTORY IS THE ONLY COPY. /ai/voice/turn is stateless, so every
 *      turn re-sends the conversation; it lives in a ref nothing resets except
 *      an explicit hang-up.
 *   4. no_speech AND tts_unavailable ARE NOT ERRORS (see useVoiceTurn).
 *
 * The parts: the mic (useRecorderControl), the speaker (usePlayback), one
 * turn (useVoiceTurn), the call's controls (useCallControls), and the pure
 * frame fold (model/turnFold.ts).
 */

import { setAudioModeAsync } from 'expo-audio';
import { deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useMicPermission, type MicPermission } from '@/shared/device/useMicPermission';

import { useCallControls } from './useCallControls';
import { useLiveTurn } from './useLiveTurn';
import { usePlayback } from './usePlayback';
import { usePoller } from './usePoller';
import { useRecorderControl } from './useRecorderControl';
import { useVoiceSessionKeeper } from './useVoiceSessionKeeper';
import { useVoiceTurn } from './useVoiceTurn';
import type { CreateSessionInput } from '../api/endpoints';
import { KEEP_AWAKE_TAG } from '../model/audio';
import type { LiveTurn, VoiceHistoryEntry, VoiceMessage, VoicePhase, VoiceSession } from '../model/types';

export type { MicPermission } from '@/shared/device/useMicPermission';

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
    /** The one big button: send now, interrupt, cancel, or start the call. */
    pressPrimary: () => void;
    /** Re-read the OS permission without prompting. Cheap and idempotent. */
    refreshPermission: () => Promise<MicPermission>;
    /** Shows the system dialog. Only call after explaining why. */
    requestPermission: () => Promise<MicPermission>;
    clearError: () => void;
    clearNotice: () => void;
}

export function useVoiceSession(options: UseVoiceSessionOptions = {}): UseVoiceSession {
    const [phase, setPhaseState] = useState<VoicePhase>('offline');
    const [messages, setMessages] = useState<VoiceMessage[]>([]);
    const [error, setError] = useState<unknown>(null);
    const [notice, setNotice] = useState<string | null>(null);
    // The polls capture their first render's closures, so what they read of
    // the machine lives in refs — the same fix as the web hook's sessionRef.
    const phaseRef = useRef<VoicePhase>('offline');
    const historyRef = useRef<VoiceHistoryEntry[]>([]);
    const stickyLanguageRef = useRef<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const submitRef = useRef<(uri: string | null, spokenMs: number) => void>(() => {});

    const setPhase = useCallback((next: VoicePhase) => {
        phaseRef.current = next;
        setPhaseState(next);
    }, []);

    const poller = usePoller();
    const liveTurn = useLiveTurn();
    const mic = useMicPermission(setError);
    const playback = usePlayback(poller);
    const keeper = useVoiceSessionKeeper(options);
    const recorder = useRecorderControl(poller, {
        setPhase,
        onError: setError,
        onUtterance: (uri, spokenMs) => submitRef.current(uri, spokenMs),
    });
    const submit = useVoiceTurn({
        ...{ phaseRef, setPhase, setError, setNotice, setMessages, historyRef, stickyLanguageRef, abortRef },
        liveTurn,
        playback,
        ensureSession: keeper.ensureSession,
        startListening: recorder.startListening,
    });
    useEffect(() => {
        submitRef.current = (uri, spokenMs) => void submit(uri, spokenMs);
    }, [submit]);

    const { stop: stopLive, clear: clearLiveTurn } = liveTurn;
    const clearLive = useCallback(() => {
        stopLive();
        clearLiveTurn();
    }, [stopLive, clearLiveTurn]);
    const controls = useCallControls({
        ...{ phaseRef, setPhase, setError, setNotice, abortRef, poller, mic, recorder, playback, clearLive },
        startSession: keeper.startSession,
        submit,
    });

    // Belt and braces: a wake lock nobody releases, or a mic session left
    // open, both outlive the screen. (The poller and the flusher clear their
    // own intervals.)
    useEffect(
        () => () => {
            abortRef.current?.abort();
            deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
            void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
        },
        [],
    );

    return {
        phase,
        session: keeper.session,
        messages,
        live: liveTurn.live,
        level: recorder.level,
        elapsed: recorder.elapsed,
        permission: mic.permission,
        error,
        notice,
        ...controls,
        refreshPermission: mic.refreshPermission,
        requestPermission: mic.requestPermission,
        clearError: () => setError(null),
        clearNotice: () => setNotice(null),
    };
}
