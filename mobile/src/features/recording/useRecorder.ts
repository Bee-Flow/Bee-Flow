/**
 * The microphone, wrapped so a screen never has to touch expo-audio directly.
 *
 * Three decisions in here are the difference between a demo and something you
 * would trust with the only copy of a client meeting:
 *
 *   1. THE RECORDING SURVIVES THE SCREEN LOCKING. `allowsBackgroundRecording`
 *      puts expo-audio's AudioFocusService in the foreground, and
 *      plugins/withBeeFlowAndroid.js declares that service with
 *      `foregroundServiceType="microphone"` — Android 14 kills an untyped one
 *      outright. Without both halves, the recording stops the moment the phone
 *      sleeps, and nobody finds out until the meeting is over.
 *   2. THE FILE IS WRITTEN TO THE DOCUMENT DIRECTORY, not the cache. Android
 *      evicts the cache under storage pressure, and a two-hour meeting is
 *      exactly the kind of large, long-lived file it goes after first.
 *   3. STATUS IS POLLED ONLY WHILE RECORDING. expo-audio's own
 *      `useAudioRecorderState` polls forever at a fixed interval, which on a
 *      tab that is merely OPEN is a permanent wake-up every 500ms. This polls
 *      at 100ms while capturing (the meter needs it) and not at all otherwise.
 *
 * The meter's history and its "is it actually hearing anything?" verdict are
 * computed here rather than in the view, because this is where the samples
 * arrive: a component that derived them from a prop would be running a
 * setState inside an effect ten times a second, which is how you get cascading
 * renders during the one hour the app must not stutter.
 *
 * The permission flow deliberately does not start with a system dialog. See
 * MicPermissionCard — asking cold burns the one prompt Android gives you.
 */

import {
    RecordingPresets,
    getRecordingPermissionsAsync,
    requestRecordingPermissionsAsync,
    setAudioModeAsync,
    useAudioRecorder,
    type RecordingOptions,
} from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';

/**
 * Speech, not music.
 *
 * Mono AAC at 64 kbit/s is comfortably above what any transcription engine can
 * use, and it is a quarter the size of the HIGH_QUALITY preset's stereo
 * 128 kbit/s: a three-hour workshop lands around 85 MB instead of 340 MB. On a
 * phone that has to upload the result over whatever network is in the room,
 * that difference is the feature.
 */
const RECORDING_OPTIONS: RecordingOptions = {
    ...RecordingPresets.HIGH_QUALITY,
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: 64000,
    // The meter is not decoration — it is the only proof the microphone is
    // actually hearing the room rather than a covered mic or a dead headset.
    isMeteringEnabled: true,
    directory: 'document',
};

/** Keeps the wake lock tagged, so nothing else can release ours by accident. */
const KEEP_AWAKE_TAG = 'beeflow-recording';

/** Where finished recordings wait for their upload. */
export const RECORDINGS_DIRNAME = 'recordings';

/** Samples kept for the meter. 40 × 100ms ≈ the last four seconds. */
export const METER_HISTORY = 40;

/** Consecutive near-silent samples before we say something. ≈4s. */
const QUIET_SAMPLES = 40;
const QUIET_THRESHOLD = 0.04;

const POLL_MS = 100;

export type RecorderPhase = 'idle' | 'preparing' | 'recording' | 'paused' | 'stopping';

export interface PermissionState {
    granted: boolean;
    /** False once Android's "don't ask again" has been used up. */
    canAskAgain: boolean;
    /** True before the first check completes, so the UI can wait rather than lie. */
    unknown: boolean;
}

export interface CapturedAudio {
    uri: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number;
}

export interface Recorder {
    phase: RecorderPhase;
    /** Seconds captured so far. Frozen while paused, as the encoder is. */
    elapsed: number;
    /** The last METER_HISTORY normalised levels, oldest first. */
    history: number[];
    /** True after several seconds of near-silence — a covered or dead mic. */
    quiet: boolean;
    permission: PermissionState;
    error: string | null;
    active: boolean;
    refreshPermission: () => Promise<PermissionState>;
    /** Shows the system dialog. Only call after explaining why. */
    requestPermission: () => Promise<PermissionState>;
    start: () => Promise<boolean>;
    pause: () => void;
    resume: () => void;
    /** Stops and hands back the finished file, moved somewhere durable. */
    stop: () => Promise<CapturedAudio | null>;
    /** Stops and deletes. For "I did not mean to start that". */
    discard: () => Promise<void>;
    clearError: () => void;
}

/**
 * dBFS → 0..1.
 *
 * expo-audio reports metering as decibels relative to full scale: 0 is
 * clipping, and anything below about -60 dB is a quiet room. Mapping the
 * bottom 60 dB across the full bar is what makes normal speech sit in the
 * middle of the meter instead of pinned at either end.
 */
function normaliseMetering(db: number | undefined): number {
    if (db === undefined || Number.isNaN(db)) return 0;
    const floor = -60;
    if (db <= floor) return 0;
    if (db >= 0) return 1;
    return (db - floor) / -floor;
}

const SILENT_HISTORY: number[] = new Array<number>(METER_HISTORY).fill(0);

export function useRecorder(): Recorder {
    const [phase, setPhase] = useState<RecorderPhase>('idle');
    const [elapsed, setElapsed] = useState(0);
    const [history, setHistory] = useState<number[]>(SILENT_HISTORY);
    const [quiet, setQuiet] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [permission, setPermission] = useState<PermissionState>({
        granted: false,
        canAskAgain: true,
        unknown: true,
    });

    const recorder = useAudioRecorder(RECORDING_OPTIONS, (status) => {
        // The encoder failing mid-meeting is the worst outcome this hook has,
        // and it arrives here rather than as a rejected promise.
        if (status.hasError && status.error) setError(status.error);
    });

    // Smoothing and the silence counter live in refs: they update ten times a
    // second and nothing renders them directly.
    const smoothed = useRef(0);
    const quietRun = useRef(0);
    const polling = useRef<ReturnType<typeof setInterval> | null>(null);

    const stopPolling = () => {
        if (polling.current) {
            clearInterval(polling.current);
            polling.current = null;
        }
    };

    const startPolling = () => {
        stopPolling();
        polling.current = setInterval(() => {
            const status = recorder.getStatus();
            setElapsed(status.durationMillis / 1000);

            const raw = normaliseMetering(status.metering);
            // Asymmetric smoothing: jump to a new peak immediately so a
            // syllable registers, then fall gently. A symmetric filter makes
            // speech look like a slow sine wave, which reads as "not working".
            smoothed.current = raw > smoothed.current ? raw : smoothed.current * 0.82 + raw * 0.18;
            const level = smoothed.current;
            setHistory((prev) => [...prev.slice(1), level]);

            // Hysteresis, not a threshold test: a natural pause in a
            // conversation is silent for a second or two, and a meter that
            // cries wolf every time someone stops to think teaches people to
            // ignore it.
            quietRun.current = raw < QUIET_THRESHOLD ? quietRun.current + 1 : 0;
            if (quietRun.current >= QUIET_SAMPLES) setQuiet(true);
            else if (quietRun.current === 0) setQuiet(false);
        }, POLL_MS);
    };

    // Belt and braces on unmount: a live interval would keep polling a
    // released recorder, and an unreleased wake lock means the screen never
    // sleeps again.
    useEffect(
        () => () => {
            if (polling.current) clearInterval(polling.current);
            polling.current = null;
            deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
        },
        [],
    );

    const refreshPermission = async (): Promise<PermissionState> => {
        try {
            const res = await getRecordingPermissionsAsync();
            const next = { granted: res.granted, canAskAgain: res.canAskAgain, unknown: false };
            setPermission(next);
            return next;
        } catch {
            // A failure to READ the permission is not a denial; treat it as
            // "unknown but askable" so the user still gets a path forward.
            const next = { granted: false, canAskAgain: true, unknown: false };
            setPermission(next);
            return next;
        }
    };

    const requestPermission = async (): Promise<PermissionState> => {
        try {
            const res = await requestRecordingPermissionsAsync();
            const next = { granted: res.granted, canAskAgain: res.canAskAgain, unknown: false };
            setPermission(next);
            return next;
        } catch (err) {
            setError((err as Error)?.message ?? 'Could not ask for microphone access.');
            const next = { granted: false, canAskAgain: false, unknown: false };
            setPermission(next);
            return next;
        }
    };

    /** Release the audio session and the wake lock. Safe to call twice. */
    const teardown = async () => {
        stopPolling();
        setHistory(SILENT_HISTORY);
        setQuiet(false);
        smoothed.current = 0;
        quietRun.current = 0;
        deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
        try {
            await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
        } catch {
            /* the session is being torn down anyway */
        }
    };

    const start = async (): Promise<boolean> => {
        setError(null);
        const current = permission.unknown ? await refreshPermission() : permission;
        if (!current.granted) return false;

        setPhase('preparing');
        try {
            // Exclusive focus so the podcast someone forgot to stop does not
            // end up in the meeting, and background recording so a locked
            // screen (or a switch to the calendar app mid-meeting) does not
            // end the capture.
            await setAudioModeAsync({
                allowsRecording: true,
                playsInSilentMode: true,
                interruptionMode: 'doNotMix',
                allowsBackgroundRecording: true,
            });
            await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
            recorder.record();
            await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
            smoothed.current = 0;
            quietRun.current = 0;
            setElapsed(0);
            setHistory(SILENT_HISTORY);
            setQuiet(false);
            setPhase('recording');
            startPolling();
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            return true;
        } catch (err) {
            setPhase('idle');
            await teardown();
            setError(
                (err as Error)?.message ??
                    'The microphone could not be started. Another app may be using it.',
            );
            return false;
        }
    };

    const pause = () => {
        try {
            recorder.pause();
            setPhase('paused');
            stopPolling();
            // One last read so the timer shows the true length at the moment of
            // pausing rather than whatever the last tick happened to see.
            setElapsed(recorder.getStatus().durationMillis / 1000);
            setHistory(SILENT_HISTORY);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch (err) {
            setError((err as Error)?.message ?? 'Could not pause the recording.');
        }
    };

    const resume = () => {
        try {
            recorder.record();
            setPhase('recording');
            startPolling();
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        } catch (err) {
            setError((err as Error)?.message ?? 'Could not resume the recording.');
        }
    };

    const stop = async (): Promise<CapturedAudio | null> => {
        if (phase !== 'recording' && phase !== 'paused') return null;
        setPhase('stopping');
        // Read the length BEFORE stopping: once the recorder is stopped its
        // status resets, and the duration is what the note is titled with.
        const capturedSeconds = recorder.getStatus().durationMillis / 1000;
        try {
            await recorder.stop();
            const uri = recorder.uri;
            await teardown();
            setPhase('idle');
            if (!uri) {
                setError('The recording finished but produced no file.');
                return null;
            }
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            return moveIntoLibrary(uri, capturedSeconds);
        } catch (err) {
            await teardown();
            setPhase('idle');
            setError((err as Error)?.message ?? 'The recording could not be finished.');
            return null;
        }
    };

    const discard = async (): Promise<void> => {
        if (phase === 'idle') return;
        setPhase('stopping');
        try {
            await recorder.stop();
            const uri = recorder.uri;
            if (uri) {
                try {
                    new File(uri).delete();
                } catch {
                    /* already gone, or never written */
                }
            }
        } catch {
            /* stopping a recorder that already failed is not itself a failure */
        } finally {
            await teardown();
            setElapsed(0);
            setPhase('idle');
        }
    };

    return {
        phase,
        elapsed,
        history,
        quiet,
        permission,
        error,
        active: phase === 'recording' || phase === 'paused',
        refreshPermission,
        requestPermission,
        start,
        pause,
        resume,
        stop,
        discard,
        clearError: () => setError(null),
    };
}

/**
 * Move the finished file somewhere we control, and name it something a person
 * would recognise in a file listing.
 *
 * expo-audio writes to a generated name; renaming it here means that if the
 * upload later fails and the user goes looking for the file, they find
 * "Meeting 2026-08-29 14-05.m4a" rather than a UUID. `moveSync` rather than a
 * copy: two copies of a 90 MB recording on a full phone is how the SECOND one
 * fails to write.
 */
function moveIntoLibrary(uri: string, durationSeconds: number): CapturedAudio {
    const source = new File(uri);
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const fileName =
        `Meeting ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
        ` ${pad(stamp.getHours())}-${pad(stamp.getMinutes())}.m4a`;

    try {
        const dir = new Directory(Paths.document, RECORDINGS_DIRNAME);
        if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
        const destination = new File(dir, fileName);
        source.moveSync(destination, { overwrite: true });
        return {
            uri: destination.uri,
            fileName,
            // The container is MPEG-4 with AAC audio. `audio/m4a` is not a
            // registered type, and multer's filter checks `audio/*` or a known
            // extension — `audio/mp4` satisfies both readings.
            mimeType: 'audio/mp4',
            sizeBytes: destination.size,
            durationSeconds,
        };
    } catch {
        // The move failed but the ORIGINAL is still there and still valid.
        // Losing a meeting over a filename is not an acceptable trade.
        return {
            uri: source.uri,
            fileName,
            mimeType: 'audio/mp4',
            sizeBytes: source.exists ? source.size : 0,
            durationSeconds,
        };
    }
}
