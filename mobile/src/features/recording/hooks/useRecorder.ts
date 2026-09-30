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
 *   2. THE FILE IS WRITTEN TO THE DOCUMENT DIRECTORY, not the cache
 *      (model/files.ts), in a container that survives being cut off, and the
 *      journal (model/journal.ts) knows where it is from the first sample —
 *      so a recording the system killed is recovered on the next open.
 *   3. STATUS IS POLLED ONLY WHILE RECORDING (useLevelMeter).
 *
 * A recording the system ends (the encoder or media server failing) is kept
 * and handed to `onInterrupted`, never left behind a frozen clock.
 */

import {
    RecordingPresets,
    setAudioModeAsync,
    useAudioRecorder,
    type RecordingOptions,
    type RecordingStatus,
} from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';

import { useMicPermission, type MicPermission } from '@/shared/device/useMicPermission';

import {
    IDLE_FLAGS,
    KEEP_AWAKE_TAG,
    salvageCapture,
    teardown,
    type Capture,
    type CaptureFlags,
    type RecorderPhase,
} from './captureSession';
import { useLevelMeter } from './useLevelMeter';
import { deleteQuietly, moveIntoLibrary, type CapturedAudio } from '../model/files';
import { closeJournal, moveJournal, openJournal } from '../model/journal';
import { SILENT_HISTORY } from '../model/meter';

export type { RecorderPhase } from './captureSession';

/**
 * Speech, not music.
 *
 * Mono AAC at 64 kbit/s is comfortably above what any transcription engine can
 * use, and it is a quarter the size of the HIGH_QUALITY preset's stereo
 * 128 kbit/s: a three-hour workshop lands around 85 MB instead of 340 MB. On a
 * phone that has to upload the result over whatever network is in the room,
 * that difference is the feature.
 *
 * On Android the AAC goes into ADTS (`.aac`), not MPEG-4. An MPEG-4 file
 * writes its index (the moov atom) only when the recording is stopped, so one
 * whose process was killed mid-meeting is unreadable from the first second.
 * ADTS is a stream of self-describing frames: a file cut off anywhere is valid
 * audio up to its last whole frame. The server accepts `.aac` and decodes it
 * with ffmpeg like any other upload.
 */
const BIT_RATE = 64000;
const RECORDING_OPTIONS: RecordingOptions = {
    ...RecordingPresets.HIGH_QUALITY,
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 1,
    bitRate: BIT_RATE,
    android: { extension: '.aac', outputFormat: 'aac_adts', audioEncoder: 'aac' },
    // The meter is not decoration — it is the only proof the microphone is
    // actually hearing the room rather than a covered mic or a dead headset.
    isMeteringEnabled: true,
    directory: 'document',
};

export interface Recorder {
    phase: RecorderPhase;
    /** Seconds captured so far. Frozen while paused, as the encoder is. */
    elapsed: number;
    /** The last METER_HISTORY normalised levels, oldest first. */
    history: number[];
    /** True after several seconds of near-silence — a covered or dead mic. */
    quiet: boolean;
    permission: MicPermission;
    error: string | null;
    active: boolean;
    refreshPermission: () => Promise<MicPermission>;
    /** Shows the system dialog. Only call after explaining why. */
    requestPermission: () => Promise<MicPermission>;
    start: () => Promise<boolean>;
    pause: () => void;
    resume: () => void;
    /** Stops and hands back the finished file, moved somewhere durable. */
    stop: () => Promise<CapturedAudio | null>;
    /** Stops and deletes. For "I did not mean to start that". */
    discard: () => Promise<void>;
    clearError: () => void;
    /** True for the file this recorder is writing, or has just finished. */
    owns: (uri: string) => boolean;
}

function reason(err: unknown, fallback: string): string {
    return (err as Error)?.message ?? fallback;
}

/**
 * Tell the journal where this meeting is going BEFORE the first sample, so a
 * process killed at any point after this leaves a recording we can find.
 */
async function registerFile(capture: Capture): Promise<void> {
    const uri = capture.audio.uri || null;
    capture.flags.current = { ...IDLE_FLAGS, uri };
    if (!uri) return;
    await openJournal({
        uri,
        startedAt: new Date().toISOString(),
        settings: { extension: RECORDING_OPTIONS.android?.extension ?? RECORDING_OPTIONS.extension, bitRate: BIT_RATE },
    });
}

async function beginCapture(capture: Capture): Promise<boolean> {
    const { audio, meter, flags, setPhase, setError } = capture;
    setPhase('preparing');
    try {
        // Exclusive focus so the podcast someone forgot to stop does not end
        // up in the meeting, and background recording so a locked screen (or a
        // switch to the calendar app mid-meeting) does not end the capture.
        await setAudioModeAsync({
            allowsRecording: true,
            playsInSilentMode: true,
            interruptionMode: 'doNotMix',
            allowsBackgroundRecording: true,
        });
        await audio.prepareToRecordAsync(RECORDING_OPTIONS);
        await registerFile(capture);
        audio.record();
        flags.current = { ...flags.current, live: true };
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
        meter.reset();
        meter.setElapsed(0);
        setPhase('recording');
        meter.start();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return true;
    } catch (err) {
        flags.current = IDLE_FLAGS;
        setPhase('idle');
        await teardown(capture);
        await closeJournal();
        setError(reason(err, 'The microphone could not be started. Another app may be using it.'));
        return false;
    }
}

function pauseCapture({ audio, meter, setPhase, setError }: Capture): void {
    try {
        audio.pause();
        setPhase('paused');
        meter.stop();
        // One last read so the timer shows the true length at the moment of
        // pausing rather than whatever the last tick happened to see.
        meter.setElapsed(audio.getStatus().durationMillis / 1000);
        meter.setHistory(SILENT_HISTORY);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
        setError(reason(err, 'Could not pause the recording.'));
    }
}

function resumeCapture({ audio, meter, setPhase, setError }: Capture): void {
    try {
        audio.record();
        setPhase('recording');
        meter.start();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
        setError(reason(err, 'Could not resume the recording.'));
    }
}

async function finishCapture(capture: Capture): Promise<CapturedAudio | null> {
    const { audio, flags, setPhase, setError } = capture;
    flags.current = { ...flags.current, live: false, stopping: true };
    setPhase('stopping');
    // Read the length BEFORE stopping: once the recorder is stopped its
    // status resets, and the duration is what the note is titled with.
    const capturedSeconds = audio.getStatus().durationMillis / 1000;
    try {
        await audio.stop();
        const uri = audio.uri;
        await teardown(capture);
        setPhase('idle');
        if (!uri) {
            await closeJournal();
            setError('The recording finished but produced no file.');
            return null;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        const captured = moveIntoLibrary(uri, capturedSeconds);
        flags.current = { ...flags.current, kept: captured.uri };
        // The caller closes the journal once the outbox holds the file.
        await moveJournal(captured.uri);
        return captured;
    } catch (err) {
        // A stop that threw still leaves the frames written so far: keep them.
        const kept = await salvageCapture(capture);
        if (!kept) setError(reason(err, 'The recording could not be finished.'));
        return kept;
    }
}

async function abandonCapture(capture: Capture): Promise<void> {
    capture.flags.current = { ...capture.flags.current, live: false, stopping: true };
    capture.setPhase('stopping');
    try {
        await capture.audio.stop();
        if (capture.audio.uri) deleteQuietly(capture.audio.uri);
    } catch {
        /* stopping a recorder that already failed is not itself a failure */
    } finally {
        await teardown(capture);
        await closeJournal();
        capture.meter.setElapsed(0);
        capture.setPhase('idle');
    }
}

export interface RecorderOptions {
    /**
     * The recorder ended without Stop (the encoder or the media server
     * failed). `audio` is what was kept, already in the library, or null when
     * nothing was written. The caller queues it and tells the person.
     */
    onInterrupted?: (audio: CapturedAudio | null, reason: string | null) => void;
}

export function useRecorder(options: RecorderOptions = {}): Recorder {
    const [phase, setPhase] = useState<RecorderPhase>('idle');
    const [error, setError] = useState<string | null>(null);
    const mic = useMicPermission((err) =>
        setError((err as Error)?.message ?? 'Could not ask for microphone access.'),
    );
    const flags = useRef<CaptureFlags>(IDLE_FLAGS);
    // expo-audio subscribes the listener once, so it reads the latest handler
    // through a ref rather than the first render's closure.
    const onStatus = useRef<(status: RecordingStatus) => void>(() => {});
    const audio = useAudioRecorder(RECORDING_OPTIONS, (status) => onStatus.current(status));
    const meter = useLevelMeter(() => audio.getStatus());
    const capture: Capture = { audio, meter, flags, bitRate: BIT_RATE, setPhase, setError };

    useEffect(() => {
        onStatus.current = (status) => {
            // The encoder failing mid-meeting is the worst outcome this hook
            // has, and it arrives here rather than as a rejected promise.
            if (status.hasError && status.error) setError(status.error);
            if (!status.isFinished || !flags.current.live || flags.current.stopping) return;
            void salvageCapture(capture).then((kept) => options.onInterrupted?.(kept, status.error));
        };
    });

    // An unreleased wake lock means the screen never sleeps again.
    useEffect(() => () => void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {}), []);

    const start = async (): Promise<boolean> => {
        setError(null);
        const current = mic.permission.unknown ? await mic.refreshPermission() : mic.permission;
        return current.granted ? beginCapture(capture) : false;
    };

    const capturing = phase === 'recording' || phase === 'paused';
    return {
        phase,
        elapsed: meter.elapsed,
        history: meter.history,
        quiet: meter.quiet,
        permission: mic.permission,
        error,
        active: capturing,
        refreshPermission: mic.refreshPermission,
        requestPermission: mic.requestPermission,
        start,
        pause: () => pauseCapture(capture),
        resume: () => resumeCapture(capture),
        stop: async () => (capturing ? finishCapture(capture) : null),
        discard: async () => (phase === 'idle' ? undefined : abandonCapture(capture)),
        clearError: () => setError(null),
        owns: (uri) => uri === flags.current.uri || uri === flags.current.kept,
    };
}
