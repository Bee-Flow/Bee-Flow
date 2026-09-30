/**
 * Starting, ending and steering the call: connect, hang up, and the one big
 * button, which does the right thing for the current phase.
 */

import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, type MutableRefObject } from 'react';

import type { MicPermission, useMicPermission } from '@/shared/device/useMicPermission';

import type { usePlayback } from './usePlayback';
import type { Poller } from './usePoller';
import type { useRecorderControl } from './useRecorderControl';
import { audioModeFor, discardFile, KEEP_AWAKE_TAG, MIN_UTTERANCE_MS } from '../model/audio';
import type { VoicePhase, VoiceSession } from '../model/types';

export interface CallDeps {
    phaseRef: MutableRefObject<VoicePhase>;
    setPhase: (next: VoicePhase) => void;
    setError: (err: unknown) => void;
    setNotice: (notice: string | null) => void;
    abortRef: MutableRefObject<AbortController | null>;
    poller: Poller;
    mic: ReturnType<typeof useMicPermission>;
    recorder: ReturnType<typeof useRecorderControl>;
    playback: ReturnType<typeof usePlayback>;
    clearLive: () => void;
    startSession: () => Promise<VoiceSession>;
    submit: (uri: string | null, spokenMs: number) => Promise<void>;
}

export function useCallControls(deps: CallDeps) {
    const { phaseRef, setPhase, setError, setNotice, abortRef, poller, mic, recorder, playback } = deps;
    const { clearLive, startSession, submit } = deps;

    const connect = useCallback(async () => {
        setError(null);
        setNotice(null);
        setPhase('connecting');
        const perm: MicPermission = mic.permission.unknown ? await mic.refreshPermission() : mic.permission;
        if (!perm.granted && !(await mic.requestPermission()).granted) {
            setPhase('offline');
            return;
        }
        try {
            await startSession();
        } catch (err) {
            setError(err);
            setPhase('offline');
            return;
        }
        // A conversation you have to keep tapping to keep alive is not a
        // conversation. The lock is released on hang-up and on unmount.
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
        await recorder.startListening();
    }, [mic, recorder, setError, setNotice, setPhase, startSession]);

    const hangUp = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        poller.stop();
        setPhase('offline');
        playback.pause();
        void (async () => {
            discardFile(await recorder.stopCapture());
            playback.releaseReply();
            await audioModeFor('play');
        })();
        deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
        clearLive();
        recorder.resetMeter();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }, [abortRef, clearLive, playback, poller, recorder, setPhase]);

    /** Send what was heard — ALWAYS, even if the gate never opened. */
    const sendNow = useCallback(() => {
        // A tap that does nothing because the room was louder than the gate
        // expected is the worst failure here; "I did not catch that" at least
        // tells the user what happened.
        const startedAt = recorder.closeUtterance();
        poller.stop();
        void (async () => {
            const uri = await recorder.stopCapture();
            const spokenMs = startedAt ? Date.now() - startedAt : MIN_UTTERANCE_MS;
            void submit(uri, Math.max(spokenMs, MIN_UTTERANCE_MS));
        })();
    }, [poller, recorder, submit]);

    const pressPrimary = useCallback(() => {
        switch (phaseRef.current) {
            case 'offline':
                return void connect();
            case 'connecting':
                return;
            case 'listening':
                return sendNow();
            case 'thinking':
                // The reader's cancel closes the socket, which is what stops
                // the model call server-side.
                abortRef.current?.abort();
                return;
            case 'speaking':
                // Barge-in, by tap: a phone cannot listen through its own
                // speaker well enough to do this by voice.
                playback.pause();
                poller.stop();
                return void recorder.startListening();
        }
    }, [abortRef, connect, phaseRef, playback, poller, recorder, sendNow]);

    return { connect, hangUp, pressPrimary };
}
