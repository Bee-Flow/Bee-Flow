/**
 * The clock, the meter's history and the quiet-mic verdict, fed by polling the
 * recorder's status.
 *
 * Polled ONLY while recording: expo-audio's own `useAudioRecorderState` polls
 * forever at a fixed interval, which on a tab that is merely OPEN is a
 * permanent wake-up every 500ms. This polls at 100ms while capturing (the
 * meter needs it) and not at all otherwise. The history is derived here,
 * where the samples arrive, rather than in the view: a component deriving it
 * from a prop would run a setState in an effect ten times a second.
 */

import { useEffect, useRef, useState } from 'react';

import { QUIET_SAMPLES, SILENT_HISTORY, nextQuietRun, normaliseMetering, smoothLevel } from '../model/meter';

const POLL_MS = 100;

export interface RecorderStatus {
    durationMillis: number;
    metering?: number;
}

export function useLevelMeter(readStatus: () => RecorderStatus) {
    const [elapsed, setElapsed] = useState(0);
    const [history, setHistory] = useState<number[]>(SILENT_HISTORY);
    const [quiet, setQuiet] = useState(false);

    // Smoothing and the silence counter live in refs: they update ten times a
    // second and nothing renders them directly.
    const smoothed = useRef(0);
    const quietRun = useRef(0);
    const polling = useRef<ReturnType<typeof setInterval> | null>(null);

    const stop = () => {
        if (polling.current) clearInterval(polling.current);
        polling.current = null;
    };

    const sample = () => {
        const status = readStatus();
        setElapsed(status.durationMillis / 1000);
        const raw = normaliseMetering(status.metering);
        smoothed.current = smoothLevel(smoothed.current, raw);
        const level = smoothed.current;
        setHistory((prev) => [...prev.slice(1), level]);
        quietRun.current = nextQuietRun(quietRun.current, raw);
        if (quietRun.current >= QUIET_SAMPLES) setQuiet(true);
        else if (quietRun.current === 0) setQuiet(false);
    };

    const start = () => {
        stop();
        polling.current = setInterval(sample, POLL_MS);
    };

    /** Back to a silent, flat meter. `elapsed` is left to the caller. */
    const reset = () => {
        setHistory(SILENT_HISTORY);
        setQuiet(false);
        smoothed.current = 0;
        quietRun.current = 0;
    };

    // A live interval would keep polling a released recorder.
    useEffect(
        () => () => {
            if (polling.current) clearInterval(polling.current);
            polling.current = null;
        },
        [],
    );

    return { elapsed, setElapsed, history, setHistory, quiet, start, stop, reset };
}
