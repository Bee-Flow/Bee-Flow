/**
 * The parts of one capture that outlive a single call into the recorder hook:
 * what it holds (the recorder, the meter, the file it is writing), how it is
 * released, and how a recording the SYSTEM ended is kept.
 *
 * That last case is the reason this file exists. expo-audio reports a
 * recorder that died under us (the media server crashed, the encoder failed)
 * as a status event, not a rejected promise, and the hook used to only show
 * the error. The phase stayed "recording", the clock froze, and the file —
 * valid audio up to that moment — was never handed to the outbox. Now the
 * file is kept, the session released, and the person is told.
 */

import { setAudioModeAsync, type AudioRecorder } from 'expo-audio';
import { deactivateKeepAwake } from 'expo-keep-awake';
import type { RefObject } from 'react';

import type { useLevelMeter } from './useLevelMeter';
import { fileSize, moveIntoLibrary, type CapturedAudio } from '../model/files';
import { estimateSeconds, moveJournal } from '../model/journal';

/** Keeps the wake lock tagged, so nothing else can release ours by accident. */
export const KEEP_AWAKE_TAG = 'beeflow-recording';

export type RecorderPhase = 'idle' | 'preparing' | 'recording' | 'paused' | 'stopping';

/** What this capture is doing, readable from a native event's callback. */
export interface CaptureFlags {
    /** Recording or paused: a finish event now is not one we asked for. */
    live: boolean;
    /** We asked for the stop; the finish event that follows is ours. */
    stopping: boolean;
    /** The file being written, from the moment the recorder was prepared. */
    uri: string | null;
    /** Where Stop (or a salvage) moved that file, until the outbox takes it. */
    kept: string | null;
}

export interface Capture {
    audio: AudioRecorder;
    meter: ReturnType<typeof useLevelMeter>;
    flags: RefObject<CaptureFlags>;
    bitRate: number;
    setPhase: (phase: RecorderPhase) => void;
    setError: (message: string | null) => void;
}

export const IDLE_FLAGS: CaptureFlags = { live: false, stopping: false, uri: null, kept: null };

/** Release the audio session and the wake lock. Safe to call twice. */
export async function teardown({ meter }: Capture): Promise<void> {
    meter.stop();
    meter.reset();
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    try {
        await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
    } catch {
        /* the session is being torn down anyway */
    }
}

/**
 * The recorder ended without being asked to: keep what it wrote.
 *
 * The length comes from the file, not the recorder: after a failure its status
 * is whatever the native side left behind. Returns null when there is nothing
 * worth keeping (no file, or an empty one).
 */
export async function salvageCapture(capture: Capture): Promise<CapturedAudio | null> {
    const { audio, flags, setPhase } = capture;
    const uri = flags.current.uri;
    flags.current = { ...flags.current, live: false, stopping: true };
    try {
        await audio.stop();
    } catch {
        /* a recorder that already failed may refuse to stop; the file is what matters */
    }
    await teardown(capture);
    setPhase('idle');
    const size = uri ? fileSize(uri) : 0;
    if (!uri || size === 0) return null;
    const captured = moveIntoLibrary(uri, estimateSeconds(size, capture.bitRate));
    flags.current = { ...flags.current, kept: captured.uri };
    await moveJournal(captured.uri);
    return captured;
}
