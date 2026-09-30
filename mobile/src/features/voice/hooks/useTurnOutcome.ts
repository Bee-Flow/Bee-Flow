/**
 * How a voice turn ends: commit the exchange and speak the answer, or say what
 * went wrong — and in every case but a settled refusal, listen again.
 *
 * no_speech and tts_unavailable are NOT errors: not hearing anything, and
 * having no voice to answer with, are ordinary outcomes of a working system.
 * They set `notice`; `error` is for things that actually broke.
 */

import * as Crypto from 'expo-crypto';
import { useCallback } from 'react';

import { ApiError } from '@/core/api/client';

import type { VoiceTurnDeps } from './useVoiceTurn';
import { audioModeFor } from '../model/audio';
import { commitTurn, type TurnFold } from '../model/turnFold';

/**
 * A refusal is settled — talking louder will not fix a plan limit or a
 * missing API key — so the call ends and the screen explains.
 */
function isSettledRefusal(err: unknown): boolean {
    return err instanceof ApiError && (err.status === 402 || err.status === 403 || err.status === 409);
}

export function useTurnOutcome(deps: VoiceTurnDeps) {
    const { phaseRef, setPhase, setError, setNotice, setMessages, historyRef, liveTurn, playback, startListening } = deps;

    /** The stream failed. A user's cancel reports nothing; anything else is an error. */
    const failed = useCallback(
        (err: unknown, aborted: boolean) => {
            if (aborted) {
                if (phaseRef.current !== 'offline') void startListening();
                return;
            }
            setError(err);
            if (isSettledRefusal(err)) {
                setPhase('offline');
                void audioModeFor('play');
            } else {
                void startListening();
            }
        },
        [phaseRef, setError, setPhase, startListening],
    );

    /** The stream ended: report, or commit and speak, then listen again. */
    const finished = useCallback(
        async (turn: TurnFold) => {
            if (turn.failed) {
                // A real but recoverable failure (STT down, the model call
                // throwing). ApiError so describeError says what the server said.
                setError(new ApiError(turn.failed));
                return void startListening();
            }
            if (turn.heardNothing) {
                setNotice('I did not catch that.');
                return void startListening();
            }
            const committed = commitTurn(turn, Date.now(), () => Crypto.randomUUID());
            historyRef.current.push(...committed.history);
            if (committed.messages.length) setMessages((prev) => [...prev, ...committed.messages]);
            liveTurn.clear();
            if (turn.ttsNotice) setNotice(turn.ttsNotice);
            if (turn.tts?.audioBase64) {
                setPhase('speaking');
                if (await playback.playReply(turn.tts)) {
                    playback.watchPlayback(() => phaseRef.current === 'speaking', () => void startListening());
                    return;
                }
                setNotice('The reply could not be played aloud.');
            }
            void startListening();
        },
        [historyRef, liveTurn, phaseRef, playback, setError, setMessages, setNotice, setPhase, startListening],
    );

    return { failed, finished };
}
