/**
 * What a transcription engine gets of a recording: its sound, never its picture.
 *
 * A Nextcloud Talk recording made in video mode is an .mp4/.webm/.mkv with a
 * picture. The whole file is kept for playback (the meeting player shows the
 * picture), but the engine only needs the sound: sending the picture to an
 * outside provider is data it has no use for, and it makes the upload ten to
 * thirty times bigger (0.4-1 GB per hour of video against ~30 MB of audio).
 *
 *   hasVideoStream(path)               true when the file has a picture track
 *   audioForTranscription(path, opts)  the file to hand the engine: the original when it
 *                                      has no picture, else a mono AAC .m4a next to it, or
 *                                      in `opts.outDir` (`extracted: true`, the caller deletes it)
 *   engineFileName(fileName, heardPath) the name the engine is told: an engine that reads the
 *                                      format from the name (Voxtral's content type) must not
 *                                      hear "meeting.webm" for an .m4a
 *
 * Detection asks ffmpeg to decode one frame of the first video stream: an
 * audio-only file fails with "matches no streams", any other failure counts as
 * "no picture" so the recording goes to the engine as it did before.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const { runFfmpeg } = nodeRequire('../media/ffmpeg.js') as {
    runFfmpeg(args: string[], opts?: { timeoutMs?: number }): Promise<{ stderr: string }>;
};
const { extractTimeoutMs } = nodeRequire('./gmeetDownload.js') as { extractTimeoutMs(): number };
const log = nodeRequire('../../telemetry/log.js') as { warn: (message: string) => void };

/** Probing reads one frame; a minute is far more than it ever needs. */
const PROBE_TIMEOUT_MS = 60_000;

export async function hasVideoStream(filePath: string): Promise<boolean> {
    try {
        await runFfmpeg(
            ['-hide_banner', '-v', 'error', '-i', filePath, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'],
            { timeoutMs: PROBE_TIMEOUT_MS },
        );
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('matches no streams')) {
            log.warn(`[RecordingAudioTrack] video probe failed, treating the recording as audio: ${message.slice(0, 300)}`);
        }
        return false;
    }
}

export interface TranscriptionAudio {
    path: string;
    extracted: boolean;
}

export function engineFileName(fileName: string, heardPath: string): string {
    const heardExt = path.extname(heardPath);
    const { name } = path.parse(fileName);
    return heardExt && path.extname(fileName).toLowerCase() !== heardExt.toLowerCase() ? `${name}${heardExt}` : fileName;
}

export async function audioForTranscription(filePath: string, opts: { outDir?: string } = {}): Promise<TranscriptionAudio> {
    if (!(await hasVideoStream(filePath))) return { path: filePath, extracted: false };
    const { dir, name } = path.parse(filePath);
    // In a scratch dir the name is fresh: two runs over the same saved file
    // (a double-clicked Retry on two replicas) must not share one output.
    const audioPath = opts.outDir
        ? path.join(opts.outDir, `${name}-${randomUUID()}.audio.m4a`)
        : path.join(dir, `${name}.audio.m4a`);
    const limitMs = extractTimeoutMs();
    await runFfmpeg(
        ['-y', '-i', filePath, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', audioPath],
        limitMs ? { timeoutMs: limitMs } : {},
    );
    return { path: audioPath, extracted: true };
}
