/**
 * The temporary copy of a recording that an Azure Whisper batch job downloads
 * (azureWhisperBatch.js): its object key, and the sweep that removes copies
 * nobody is coming back for.
 *
 * The transcription deletes its copy when it ends, whatever the outcome. A
 * process that stops while the job is still at Azure (a deploy, a crash)
 * never gets there, and the wait can be hours on a long meeting. The copy is
 * the audio of a meeting: it must not stay in object storage for good. So the
 * key carries the time it was written, and a periodic pass
 * (jobs/platformRetention.js) deletes every copy older than the longest wait
 * plus an hour.
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';

import { maxWhisperBatchWaitMs } from './whisperBatchWait.mts';

const nodeRequire = createRequire(import.meta.url);

export const WHISPER_TEMP_PREFIX = 'transcription-tmp/';

const GRACE_MS = 60 * 60_000;

/** The object key of a new temporary copy: the time it is written, a random id, the cleaned file name. */
export function whisperTempKey(fileName: string, now: number = Date.now()): string {
    const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${WHISPER_TEMP_PREFIX}${now}-${crypto.randomUUID()}-${safeName}.flac`;
}

/** When the key says it was written (ms), or null for a key from before keys carried it. */
export function whisperTempKeyWrittenAt(key: string): number | null {
    const name = key.startsWith(WHISPER_TEMP_PREFIX) ? key.slice(WHISPER_TEMP_PREFIX.length) : '';
    const dash = name.indexOf('-');
    const stamp = dash > 0 ? name.slice(0, dash) : '';
    // 13 digits: a millisecond time. The random id that an older key starts with has 8 hex characters there.
    if (stamp.length !== 13 || [...stamp].some((c) => c < '0' || c > '9')) return null;
    return Number(stamp);
}

export interface TempAudioStorage {
    isAvailable: () => boolean;
    /** The real store says which backend it runs on; only the object store can list a prefix. */
    getStatus?: () => { mode: string | null };
    listKeys: (prefix: string) => Promise<string[]>;
    deleteFile: (key: string) => Promise<unknown>;
}

/** Keys without a time in them, and when this process first saw each. */
const firstSeen = new Map<string, number>();

/** Can this store list a prefix right now? Only the object store can; the on-disk one cannot. */
function canList(store: TempAudioStorage): boolean {
    if (!store.isAvailable()) return false;
    const mode = store.getStatus?.().mode;
    return !mode || mode === 's3';
}

/** When a copy was written: from its key, else the first pass of this process that saw it. */
function writtenAtOf(key: string, now: number): number {
    const fromKey = whisperTempKeyWrittenAt(key);
    if (fromKey !== null) return fromKey;
    if (!firstSeen.has(key)) firstSeen.set(key, now);
    return firstSeen.get(key) ?? now;
}

/**
 * Delete the temporary copies that are older than any transcription can still
 * need. A key without a time in it (written by an older version) counts from
 * the first pass that saw it, so a job still running on an old replica during
 * a rolling update keeps its audio.
 * @returns how many copies were deleted
 */
export async function sweepStaleWhisperAudio(
    { storage, now = Date.now(), env = process.env }: { storage?: TempAudioStorage; now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
    const store = storage ?? (nodeRequire('../../stores/storageStore') as TempAudioStorage);
    if (!canList(store)) return 0;
    const staleBefore = now - (maxWhisperBatchWaitMs(env) + GRACE_MS);
    const keys = await store.listKeys(WHISPER_TEMP_PREFIX);
    const present = new Set(keys);
    for (const key of firstSeen.keys()) if (!present.has(key)) firstSeen.delete(key);
    let deleted = 0;
    for (const key of keys) {
        if (writtenAtOf(key, now) >= staleBefore) continue;
        await store.deleteFile(key);
        firstSeen.delete(key);
        deleted += 1;
    }
    return deleted;
}

/** Forget what earlier passes saw (tests). */
export function _resetForTests(): void {
    firstSeen.clear();
}
