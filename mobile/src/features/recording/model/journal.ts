/**
 * The recording journal: the one line of state that lets a meeting survive the
 * app dying mid-recording.
 *
 * The outbox only learns about a recording when Stop is pressed. Everything
 * before that — the whole meeting — exists only as a file expo-audio is still
 * writing. If the process dies first (a battery manager, a crash, a reboot),
 * nothing on the phone remembers that file, and the meeting is gone without
 * anybody deleting it. So:
 *
 *   - `openJournal` is written when a recording starts, BEFORE the first
 *     sample, with the file's location;
 *   - `moveJournal` follows the file when Stop moves it into the library, so
 *     dying between the move and the outbox entry cannot lose track of it;
 *   - `closeJournal` runs only once the outbox holds the file (or it was
 *     discarded on purpose);
 *   - `recoverInterrupted`, on the next open, turns a journal entry with no
 *     live recording behind it into a file the outbox can take.
 *
 * Android records AAC in ADTS frames, which have no trailing index: a file cut
 * off mid-write is valid audio up to its last whole frame. Nothing here ever
 * deletes a recording; a recovered one is handed to the person to upload or
 * delete.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { fileSize, moveIntoLibrary, type CapturedAudio } from './files';

const JOURNAL_KEY = 'beeflow.recordings.journal.v1';

export interface JournalEntry {
    /** Where the in-progress file is (or, after Stop, where it was moved to). */
    uri: string;
    /** ISO time the recording started. */
    startedAt: string;
    /** Enough of the encoder settings to estimate a length from a size. */
    settings: { extension: string; bitRate: number };
}

export interface RecoveredRecording {
    audio: CapturedAudio;
    startedAt: string;
}

function isEntry(value: unknown): value is JournalEntry {
    const entry = value as JournalEntry | null;
    return (
        typeof entry?.uri === 'string' &&
        typeof entry.startedAt === 'string' &&
        typeof entry.settings?.bitRate === 'number'
    );
}

export async function readJournal(): Promise<JournalEntry | null> {
    try {
        const raw = await AsyncStorage.getItem(JOURNAL_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return isEntry(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Written before recording starts. A failed write is swallowed: the recording
 * itself is worth more than the insurance on it.
 */
export async function openJournal(entry: JournalEntry): Promise<void> {
    try {
        await AsyncStorage.setItem(JOURNAL_KEY, JSON.stringify(entry));
    } catch {
        /* recording without the journal beats not recording */
    }
}

/** The file moved (Stop put it in the library): follow it. */
export async function moveJournal(uri: string): Promise<void> {
    const entry = await readJournal();
    if (entry) await openJournal({ ...entry, uri });
}

export async function closeJournal(): Promise<void> {
    try {
        await AsyncStorage.removeItem(JOURNAL_KEY);
    } catch {
        /* a stale entry is recovered as a duplicate at worst, never lost */
    }
}

/** Constant-bit-rate AAC: bytes × 8 ÷ bit rate is within a few percent. */
export function estimateSeconds(sizeBytes: number, bitRate: number): number {
    if (!(sizeBytes > 0) || !(bitRate > 0)) return 0;
    return Math.round((sizeBytes * 8) / bitRate);
}

export interface RecoverChecks {
    /** True while this uri is being recorded right now: not an orphan. */
    isLive: (uri: string) => boolean;
    /** True when the outbox already holds this uri (it died after the enqueue). */
    isQueued: (uri: string) => boolean;
}

/**
 * The journal's entry, if it outlived its recording, moved into the library.
 *
 * Returns null (and clears the journal) when there is nothing to recover: no
 * entry, the outbox already has the file, or the file is missing or empty. A
 * live recording is left alone, journal and all. The journal is NOT cleared on
 * success — the caller clears it once the outbox holds the file.
 */
export async function recoverInterrupted(checks: RecoverChecks): Promise<RecoveredRecording | null> {
    const entry = await readJournal();
    if (!entry || checks.isLive(entry.uri)) return null;
    const size = fileSize(entry.uri);
    if (checks.isQueued(entry.uri) || size === 0) {
        await closeJournal();
        return null;
    }
    const started = new Date(entry.startedAt);
    const stamp = Number.isNaN(started.getTime()) ? new Date() : started;
    const audio = moveIntoLibrary(entry.uri, estimateSeconds(size, entry.settings.bitRate), stamp);
    await moveJournal(audio.uri);
    return { audio, startedAt: entry.startedAt };
}
