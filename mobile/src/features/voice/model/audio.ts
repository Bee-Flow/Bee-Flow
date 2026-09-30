/**
 * The audio settings and file chores behind a voice call: how a turn is
 * recorded, how long each loop waits, and where replies are written.
 */

import { setAudioModeAsync, type RecordingOptions } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * Speech, in short bursts.
 *
 * Same encoder settings as the meeting recorder — mono AAC at 64 kbit/s is
 * well above what Voxtral can use and is known to prepare on the devices this
 * app ships to. A 60-second turn is under half a megabyte. `directory: 'cache'`
 * because a turn is worth nothing once it is transcribed.
 */
export const TURN_RECORDING: RecordingOptions = {
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
export const TURN_MIME = 'audio/mp4';

export const KEEP_AWAKE_TAG = 'beeflow-voice';

/** Metering poll. 10 Hz is enough for both the meter and the silence gate. */
export const POLL_MS = 100;

/** Anything shorter than this is a cough, a door, or a knuckle on the desk. */
export const MIN_UTTERANCE_MS = 400;

/**
 * Turns of context sent with each turn. The whole history goes up the wire on
 * EVERY turn, so this is a bandwidth and latency number as much as a memory
 * one; twelve exchanges is far more than a spoken conversation refers back to.
 */
export const MAX_HISTORY_MESSAGES = 24;

/** Token flush interval — same reasoning as the chat stream's. */
export const FLUSH_INTERVAL_MS = 50;

export const PLAYBACK_POLL_MS = 250;

/** How long to wait for playback to actually start before giving up on it. */
export const PLAYBACK_START_GRACE_MS = 8_000;

/**
 * Android routes playback to the earpiece — quietly, and at call volume —
 * while a capture session is open, so the reply has to be spoken with
 * recording explicitly off. Flipping back before the next turn is what makes
 * the loop work at all.
 */
export async function audioModeFor(mode: 'record' | 'play'): Promise<void> {
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
}

export function discardFile(uri: string | null): void {
    if (!uri) return;
    try {
        new File(uri).delete();
    } catch {
        /* already gone */
    }
}

/**
 * Write a reply's base64 MP3 to the cache. expo-audio wants a source it can
 * open, and File.write() takes base64 directly, so nothing is decoded in JS.
 * A new name per reply rather than one reused file: the player may still hold
 * the previous one open, and overwriting a file ExoPlayer has a handle on is
 * how the last answer gets played twice.
 */
export function writeReplyFile(audioBase64: string): string {
    const dir = new Directory(Paths.cache, 'voice');
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `reply-${Date.now()}.mp3`);
    file.create({ overwrite: true });
    file.write(audioBase64, { encoding: 'base64' });
    return file.uri;
}
