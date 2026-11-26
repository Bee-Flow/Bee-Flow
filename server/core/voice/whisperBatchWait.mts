/**
 * The waiting half of an Azure Whisper batch transcription
 * (azureWhisperBatch.js): how long a job may take, what the job is asked to
 * do given the length of the audio, and the poll loop itself.
 *
 * A batch job is not a request that answers: Azure queues it, and a meeting of
 * several hours takes a multiple of what a five-minute clip takes. Every limit
 * here follows the length of the audio, so a short clip and a long meeting
 * each get what they need.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as { info: (...args: unknown[]) => void };

const WHISPER_BATCH_BYTES_PER_SECOND: Record<string, number> = {
    '.wav': 32000, '.flac': 16000, '.mp3': 16000,
    '.m4a': 12000, '.mp4': 12000, '.ogg': 8000, '.opus': 8000,
};

/**
 * Azure schedules batch jobs on a best-effort basis: at peak hours a job can
 * wait up to 30 minutes before it starts, and that wait already shows as
 * `Running`. Every job gets this much on top of its own audio.
 */
const QUEUE_ALLOWANCE_MS = 30 * 60_000;
/** Without a length, wait as for an hour of audio. */
const UNKNOWN_AUDIO_MS = 60 * 60_000;
/** The longest wait computed here; WHISPER_AZURE_POLL_TIMEOUT_MS sets any other value. */
const MAX_POLL_MS = 6 * 60 * 60_000;

/** The longest any batch job is waited for: the override when set, else the ceiling of the computed wait. */
export function maxWhisperBatchWaitMs(env: NodeJS.ProcessEnv = process.env): number {
    const override = Number(env.WHISPER_AZURE_POLL_TIMEOUT_MS);
    return override > 0 ? override : MAX_POLL_MS;
}

export interface WhisperBatchTimeouts {
    pollCapMs: number;
    urlTtlSeconds: number;
    estimatedSeconds: number | null;
    jobTimeToLive: string;
}

/**
 * Duration-scaled limits for an Azure Whisper batch run.
 *
 * The wait is the queue allowance plus the length of the audio. Both parts
 * matter: with the audio length alone a five-minute recording times out while
 * it is still in Azure's queue, and with a ceiling of an hour a meeting of two
 * hours or more gets the same wait as one of an hour. The download URL and the
 * job's own lifetime at Azure follow the wait: the URL must outlive the queue
 * time (Azure may only fetch the audio when the job starts), and the result
 * must still exist when the job finishes near the end of the wait.
 *
 * `durationSeconds` is the measured length (flacDurationSeconds) and wins over
 * the estimate from the byte size: FLAC shrinks quiet stretches to almost
 * nothing, so a long meeting with silences looks much shorter by its size.
 */
export function computeWhisperBatchTimeouts(
    { bytes, ext, durationSeconds = null, env = process.env }: { bytes?: number; ext?: string; durationSeconds?: number | null; env?: NodeJS.ProcessEnv } = {},
): WhisperBatchTimeouts {
    const bps = WHISPER_BATCH_BYTES_PER_SECOND[String(ext || '').toLowerCase()];
    const bySize = bps && Number(bytes) > 0 ? Math.round(Number(bytes) / bps) : null;
    const estimatedSeconds = Number(durationSeconds) > 0 ? Math.round(Number(durationSeconds)) : bySize;
    const override = Number(env.WHISPER_AZURE_POLL_TIMEOUT_MS);
    const audioMs = estimatedSeconds ? estimatedSeconds * 1000 : UNKNOWN_AUDIO_MS;
    const pollCapMs = override > 0 ? override : Math.min(MAX_POLL_MS, QUEUE_ALLOWANCE_MS + audioMs);
    const urlTtlSeconds = Math.round(pollCapMs / 1000) + 900;
    const jobTimeToLive = `PT${Math.max(4, Math.ceil(pollCapMs / 3_600_000) + 1)}H`;
    return { pollCapMs, urlTtlSeconds, estimatedSeconds, jobTimeToLive };
}

/**
 * The length of a FLAC file in seconds, read from its STREAMINFO block (the
 * sample rate and the total number of samples), or null when the header is
 * not there or does not say (a stream written without a final seek).
 */
export function flacDurationSeconds(buffer: Buffer): number | null {
    if (!Buffer.isBuffer(buffer) || buffer.length < 26 || buffer.toString('latin1', 0, 4) !== 'fLaC') return null;
    // The first metadata block is always STREAMINFO (type 0 in the low 7 bits).
    if ((buffer[4] & 0x7f) !== 0) return null;
    const sampleRate = (buffer[18] << 12) | (buffer[19] << 4) | (buffer[20] >> 4);
    const totalSamples = (buffer[21] & 0x0f) * 2 ** 32 + buffer.readUInt32BE(22);
    if (!sampleRate || !totalSamples) return null;
    return totalSamples / sampleRate;
}

/**
 * Build the batch `diarization` property from an optional speaker count.
 * Exact count → minCount=maxCount=N; unknown → 1..35. maxCount must be < 36.
 */
export function azureDiarizationSpeakers(numSpeakers: number | null | undefined): { speakers: { minCount: number; maxCount: number } } {
    const n = Number(numSpeakers);
    if (Number.isFinite(n) && n >= 1) {
        const c = Math.min(Math.round(n), 35);
        return { speakers: { minCount: c, maxCount: c } };
    }
    return { speakers: { minCount: 1, maxCount: 35 } };
}

/**
 * Azure refuses a speaker range (`diarization.speakers`) on a file longer than
 * 240 minutes. Above that the range is left out: `diarizationEnabled` alone
 * still separates two voices, which beats a job that Azure rejects.
 */
const SPEAKER_RANGE_MAX_SECONDS = 240 * 60;

/** The `properties` of a batch job. */
export function whisperBatchJobProperties(
    { numSpeakers = null, durationSeconds = null, jobTimeToLive }: { numSpeakers?: number | null; durationSeconds?: number | null; jobTimeToLive: string },
) {
    const speakerRange = !(Number(durationSeconds) > SPEAKER_RANGE_MAX_SECONDS);
    return {
        diarizationEnabled: true,
        // `diarizationEnabled` alone caps at 2 speakers. The modern
        // `diarization.speakers` unlocks 3–35 (max must be < 36). Use the
        // user's per-meeting count as an exact hint when given, else a
        // wide 1–35 range so real multi-speaker meetings get separated.
        ...(speakerRange ? { diarization: azureDiarizationSpeakers(numSpeakers) } : {}),
        punctuationMode: 'DictatedAndAutomatic',
        profanityFilterMode: 'None',
        timeToLive: jobTimeToLive,
    };
}

/**
 * How long to wait before the next status poll. A job that is still running
 * after a few minutes is in the queue or on a long recording: asking every
 * five seconds for an hour is 700 requests and as many log lines for nothing.
 */
export function whisperBatchPollDelayMs(elapsedMs: number): number {
    if (elapsedMs < 2 * 60_000) return 5_000;
    if (elapsedMs < 15 * 60_000) return 15_000;
    return 30_000;
}

export interface WhisperBatchPoll {
    status?: string;
    properties?: { error?: { code?: string; message?: string } };
}

interface PollResponse { ok: boolean; status: number; json: () => Promise<unknown> }

export interface PollWhisperBatchJobOptions {
    jobUrl: string;
    speechKey: string;
    pollCapMs: number;
    /** `sleep`, `now` and `fetchJob` are test seams. */
    sleep?: (ms: number) => Promise<unknown>;
    now?: () => number;
    fetchJob?: (url: string, init: { headers: Record<string, string> }) => Promise<PollResponse>;
}

const realSleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

function fixedEndpointFetch(url: string, init: { headers: Record<string, string> }): Promise<PollResponse> {
    const { fetchFixedEndpoint } = nodeRequire('../../utils/fixedEndpointFetch.mts') as typeof import('../../utils/fixedEndpointFetch.mts');
    return fetchFixedEndpoint(url, init);
}

/**
 * Poll a batch job until Azure reports a final status, and return that last
 * poll response. Gives up after `pollCapMs` with an error coded `timeout`, so
 * a meeting import can tell "took too long" from "failed".
 */
export async function pollWhisperBatchJob(
    { jobUrl, speechKey, pollCapMs, sleep = realSleep, now = Date.now, fetchJob = fixedEndpointFetch }: PollWhisperBatchJobOptions,
): Promise<WhisperBatchPoll> {
    const pollStart = now();
    let loggedStatus = '';
    let loggedAt = pollStart;
    for (;;) {
        const elapsedMs = now() - pollStart;
        if (elapsedMs > pollCapMs) {
            throw Object.assign(
                new Error(`Azure Whisper batch job timed out after ${Math.round(pollCapMs / 60000)} minutes.`),
                { code: 'timeout' },
            );
        }
        await sleep(whisperBatchPollDelayMs(elapsedMs));
        const pollResp = await fetchJob(jobUrl, { headers: { 'Ocp-Apim-Subscription-Key': speechKey } });
        if (!pollResp.ok) throw new Error(`Polling failed: HTTP ${pollResp.status}`);
        const pollData = await pollResp.json() as WhisperBatchPoll;
        const status = String(pollData.status);
        // A status change, and otherwise one line a minute: enough to see it is alive.
        if (status !== loggedStatus || now() - loggedAt >= 60_000) {
            log.info(`[Transcription:AzureWhisper] Status: ${status} (${Math.round((now() - pollStart) / 1000)}s)`);
            loggedStatus = status;
            loggedAt = now();
        }
        if (status !== 'Running' && status !== 'NotStarted') return pollData;
    }
}
