/**
 * The microphone side of the call: open the mic, meter it, and let the
 * silence gate decide when the turn is over.
 *
 * Everything about WHEN a turn ends is in model/silenceGate.ts, where it can
 * be tested without a microphone; the poll here only carries out what the gate
 * decided — restart a capture that heard only noise, or hand a finished one
 * to `onUtterance`.
 */

import { useAudioRecorder } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Poller } from './usePoller';
import { audioModeFor, discardFile, POLL_MS, TURN_RECORDING } from '../model/audio';
import { createSilenceGate } from '../model/silenceGate';
import type { VoicePhase } from '../model/types';

export interface RecorderEvents {
    setPhase: (next: VoicePhase) => void;
    onError: (err: unknown) => void;
    /** A finished utterance: the file (or null) and how long speech lasted. */
    onUtterance: (uri: string | null, spokenMs: number) => void;
}

export function useRecorderControl(poller: Poller, events: RecorderEvents) {
    const [level, setLevel] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const recorder = useAudioRecorder(TURN_RECORDING);
    const gate = useRef(createSilenceGate());
    // The poll is installed once per capture and outlives the render that
    // started it, so what it calls back into has to be read through a ref.
    const handlers = useRef(events);
    useEffect(() => {
        handlers.current = events;
    });
    const { start: startPoll, stop: stopPoll } = poller;

    /** Stop the encoder and hand back the file, or null if there is none. */
    const stopCapture = useCallback(async (): Promise<string | null> => {
        stopPoll();
        try {
            await recorder.stop();
        } catch {
            /* stopping a recorder that never started is not a failure */
        }
        setLevel(0);
        return recorder.uri ?? null;
    }, [recorder, stopPoll]);

    // The gate can restart a capture from inside the poll; the restart runs
    // the latest startListening, which is declared below.
    const relistenRef = useRef<() => void>(() => {});
    const meter = useCallback(
        () => {
            let status;
            try {
                status = recorder.getStatus();
            } catch {
                return;
            }
            const decision = gate.current.feed({ db: status.metering, durationMillis: status.durationMillis, now: Date.now() });
            setLevel(decision.level);
            setElapsed(decision.elapsedSeconds);
            if (decision.kind === 'restart') {
                stopPoll();
                void stopCapture().then((stale) => {
                    discardFile(stale);
                    relistenRef.current();
                });
            } else if (decision.kind === 'submit') {
                stopPoll();
                const { spokenMs } = decision;
                void stopCapture().then((uri) => handlers.current.onUtterance(uri, spokenMs));
            }
        },
        [recorder, stopCapture, stopPoll],
    );

    const startListening = useCallback(async (): Promise<boolean> => {
        await audioModeFor('record');
        try {
            await recorder.prepareToRecordAsync(TURN_RECORDING);
            recorder.record();
        } catch (err) {
            handlers.current.onError(err);
            handlers.current.setPhase('offline');
            return false;
        }
        gate.current.reset(Date.now());
        setLevel(0);
        setElapsed(0);
        handlers.current.setPhase('listening');
        startPoll(meter, POLL_MS);
        return true;
    }, [meter, recorder, startPoll]);
    useEffect(() => {
        relistenRef.current = () => void startListening();
    }, [startListening]);

    /** End the utterance by hand; the start time, when speech was heard. */
    const closeUtterance = useCallback((): number | null => gate.current.closeUtterance(), []);

    const resetMeter = useCallback(() => {
        setLevel(0);
        setElapsed(0);
    }, []);

    return { level, elapsed, startListening, stopCapture, closeUtterance, resetMeter };
}
