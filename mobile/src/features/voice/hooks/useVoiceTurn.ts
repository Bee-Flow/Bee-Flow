/**
 * One spoken turn: send the recording, fold the reply's frames, then commit
 * the exchange and speak the answer — or say what went wrong and listen again.
 *
 * What happens once the stream ends is useTurnOutcome.
 */

import * as Haptics from 'expo-haptics';
import { useCallback, type MutableRefObject } from 'react';

import type { useLiveTurn } from './useLiveTurn';
import type { usePlayback } from './usePlayback';
import { useTurnOutcome } from './useTurnOutcome';
import { streamVoiceTurn } from '../api/endpoints';
import { discardFile, MAX_HISTORY_MESSAGES, MIN_UTTERANCE_MS, TURN_MIME } from '../model/audio';
import { applyVoiceFrame, type TurnFold } from '../model/turnFold';
import type { VoiceHistoryEntry, VoiceMessage, VoicePhase, VoiceSession } from '../model/types';

export interface VoiceTurnDeps {
    phaseRef: MutableRefObject<VoicePhase>;
    setPhase: (next: VoicePhase) => void;
    setError: (err: unknown) => void;
    setNotice: (notice: string | null) => void;
    setMessages: (update: (prev: VoiceMessage[]) => VoiceMessage[]) => void;
    /** The only copy of the conversation — the server keeps none. */
    historyRef: MutableRefObject<VoiceHistoryEntry[]>;
    /** A language pinned by an earlier transcript; see turnFold.ts. */
    stickyLanguageRef: MutableRefObject<string | null>;
    abortRef: MutableRefObject<AbortController | null>;
    liveTurn: ReturnType<typeof useLiveTurn>;
    playback: ReturnType<typeof usePlayback>;
    ensureSession: () => Promise<VoiceSession>;
    startListening: () => Promise<boolean>;
}

export function useVoiceTurn(deps: VoiceTurnDeps) {
    const { setPhase, setNotice, historyRef, stickyLanguageRef, abortRef, liveTurn, ensureSession, startListening } = deps;

    const fold = useCallback(
        async (uri: string, turn: TurnFold, signal: AbortSignal) => {
            const active = await ensureSession();
            for await (const frame of streamVoiceTurn({
                audioUri: uri,
                mimeType: TURN_MIME,
                fileName: 'turn.m4a',
                history: historyRef.current.slice(-MAX_HISTORY_MESSAGES),
                session: active,
                language: stickyLanguageRef.current ?? active.language,
                signal,
            })) {
                if (!applyVoiceFrame(turn, frame.event, frame.data)) {
                    if (__DEV__) console.warn(`[voice] unhandled SSE event: ${frame.event}`);
                }
                // Pinned the moment a real sentence names it, for every later turn.
                if (!stickyLanguageRef.current && turn.language) stickyLanguageRef.current = turn.language;
            }
        },
        [ensureSession, historyRef, stickyLanguageRef],
    );

    const { failed, finished } = useTurnOutcome(deps);

    return useCallback(
        async (uri: string | null, spokenMs: number) => {
            if (!uri) return void startListening();
            if (spokenMs < MIN_UTTERANCE_MS) {
                // A door, a cough, a knuckle on the table: drop it silently.
                discardFile(uri);
                return void startListening();
            }
            setPhase('thinking');
            setNotice(null);
            const turn = liveTurn.begin();
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            const controller = new AbortController();
            abortRef.current = controller;
            try {
                await fold(uri, turn, controller.signal);
            } catch (err) {
                liveTurn.stop();
                discardFile(uri);
                return failed(err, controller.signal.aborted);
            } finally {
                liveTurn.stop();
                abortRef.current = null;
            }
            discardFile(uri);
            await finished(turn);
        },
        [abortRef, failed, finished, fold, liveTurn, setNotice, setPhase, startListening],
    );
}
