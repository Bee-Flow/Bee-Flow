/**
 * The outbox: recordings that exist only on this phone.
 *
 * This module exists because of one asymmetry. Everything else in Bee Flow is
 * a view onto server state — lose the local copy and you have lost nothing.
 * A meeting recording is the opposite: between "stop" and the server's 202,
 * the phone holds the ONLY copy of something that cannot be recreated. So:
 *
 *   - An entry is removed only after the server has acknowledged the upload.
 *     Not when the request is sent, not when the screen closes.
 *   - A failure leaves the entry AND the file exactly where they were, with a
 *     reason attached and a Retry that costs one tap.
 *   - The queue is persisted, so force-quitting the app mid-upload loses the
 *     progress bar and nothing else.
 *   - Deleting a recording is always an explicit, confirmed act by the user.
 *
 * State lives in zustand rather than React Query because it is not server
 * state: nothing here can be refetched, and a stale-time of any length would
 * be a lie. The store is a singleton so an upload survives navigating away
 * from the Record tab.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { create } from 'zustand';

import { uploadRecording } from './api';
import type { CaptureSettings, PendingRecording, TranscriptionAccepted } from './types';
import { describeError } from '../../ui/Feedback';

const STORAGE_KEY = 'beeflow.recordings.outbox.v1';

/** What actually gets written to disk — the transient bits are recomputed. */
type PersistedEntry = Omit<PendingRecording, 'progress' | 'status'> & {
    status: 'queued' | 'failed';
};

export interface NewPendingRecording {
    uri: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number;
    captureMode: 'recording' | 'upload';
    settings: CaptureSettings;
}

interface OutboxState {
    items: PendingRecording[];
    /** False until the persisted queue has been read back. */
    hydrated: boolean;
    hydrate: () => Promise<void>;
    enqueue: (input: NewPendingRecording) => Promise<PendingRecording>;
    updateSettings: (id: string, patch: Partial<CaptureSettings>) => void;
    upload: (id: string, onAccepted?: (note: TranscriptionAccepted) => void) => Promise<void>;
    cancel: (id: string) => void;
    /** Deletes the entry AND the audio file. Irreversible; confirm first. */
    discard: (id: string) => Promise<void>;
    /** Retries everything that is queued or failed, one at a time. */
    uploadAll: (onAccepted?: (note: TranscriptionAccepted) => void) => Promise<void>;
}

/**
 * In-flight aborts, keyed by entry id.
 *
 * Outside the store on purpose: an AbortController is not state anyone renders
 * and putting it in the store would make every progress tick re-render on a
 * value nothing reads.
 */
const inFlight = new Map<string, AbortController>();

export const useOutbox = create<OutboxState>()((set, get) => ({
    items: [],
    hydrated: false,

    hydrate: async () => {
        if (get().hydrated) return;
        let restored: PendingRecording[] = [];
        try {
            const raw = await AsyncStorage.getItem(STORAGE_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : [];
            const entries = Array.isArray(parsed) ? (parsed as PersistedEntry[]) : [];
            restored = entries
                // A file that is no longer on disk cannot be uploaded and its
                // row would be a permanent, un-actionable failure. This happens
                // when the user clears app storage — rare, but a ghost row that
                // can never succeed is worse than no row.
                .filter((entry) => {
                    try {
                        return new File(entry.uri).exists;
                    } catch {
                        return false;
                    }
                })
                .map((entry) => ({
                    ...entry,
                    // Anything that claimed to be uploading was killed with the
                    // process. It is queued again, not failed: nothing went
                    // wrong, the app just stopped existing.
                    status: entry.status === 'failed' ? 'failed' : 'queued',
                    progress: 0,
                }));
        } catch {
            restored = [];
        }
        set({ items: restored, hydrated: true });
        if (restored.length) void persist(restored);
    },

    enqueue: async (input) => {
        const entry: PendingRecording = {
            id: Crypto.randomUUID(),
            ...input,
            createdAt: new Date().toISOString(),
            status: 'queued',
            progress: 0,
            attempts: 0,
            error: null,
        };
        const items = [entry, ...get().items];
        set({ items });
        await persist(items);
        return entry;
    },

    updateSettings: (id, patch) => {
        const items = get().items.map((item) =>
            item.id === id ? { ...item, settings: { ...item.settings, ...patch } } : item,
        );
        set({ items });
        void persist(items);
    },

    upload: async (id, onAccepted) => {
        const entry = get().items.find((item) => item.id === id);
        if (!entry || entry.status === 'uploading') return;

        const controller = new AbortController();
        inFlight.set(id, controller);
        patchItem(set, get, id, { status: 'uploading', progress: 0, error: null });

        try {
            const note = await uploadRecording(
                {
                    uri: entry.uri,
                    fileName: entry.fileName,
                    mimeType: entry.mimeType,
                    captureMode: entry.captureMode,
                    settings: entry.settings,
                },
                {
                    signal: controller.signal,
                    onProgress: ({ fraction }) => {
                        // Only the in-flight row changes, and only when the bar
                        // would actually move a pixel.
                        const current = get().items.find((item) => item.id === id);
                        if (!current || current.status !== 'uploading') return;
                        if (Math.abs(current.progress - fraction) < 0.01 && fraction < 1) return;
                        patchItem(set, get, id, { progress: fraction });
                    },
                },
            );

            // Acknowledged. Only NOW is it safe to delete the local file: the
            // server has the bytes and a note to write the transcript onto.
            try {
                const file = new File(entry.uri);
                if (file.exists) file.delete();
            } catch {
                /* an orphaned file wastes space; a lost note wastes a meeting */
            }
            const items = get().items.filter((item) => item.id !== id);
            set({ items });
            await persist(items);
            onAccepted?.(note);
        } catch (err) {
            const cancelled = controller.signal.aborted;
            patchItem(set, get, id, {
                status: cancelled ? 'queued' : 'failed',
                progress: 0,
                attempts: (get().items.find((item) => item.id === id)?.attempts ?? 0) + 1,
                // describeError turns a 402 into "Plan limit reached" instead
                // of "HTTP 402" — this row is where the user reads it.
                error: cancelled ? null : describeError(err).message,
            });
            await persist(get().items);
        } finally {
            inFlight.delete(id);
        }
    },

    cancel: (id) => {
        inFlight.get(id)?.abort();
    },

    discard: async (id) => {
        inFlight.get(id)?.abort();
        const entry = get().items.find((item) => item.id === id);
        if (entry) {
            try {
                const file = new File(entry.uri);
                if (file.exists) file.delete();
            } catch {
                /* nothing left to delete */
            }
        }
        const items = get().items.filter((item) => item.id !== id);
        set({ items });
        await persist(items);
    },

    uploadAll: async (onAccepted) => {
        // Sequential, oldest first. Parallel uploads of two 200 MB files over
        // one phone radio finish later than the same two in sequence, and both
        // progress bars crawl in a way that reads as "stuck".
        const pending = [...get().items]
            .filter((item) => item.status !== 'uploading')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const item of pending) {
            await get().upload(item.id, onAccepted);
        }
    },
}));

function patchItem(
    set: (partial: Partial<OutboxState>) => void,
    get: () => OutboxState,
    id: string,
    patch: Partial<PendingRecording>,
): void {
    set({ items: get().items.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
}

async function persist(items: PendingRecording[]): Promise<void> {
    try {
        const persisted: PersistedEntry[] = items.map(({ progress: _progress, status, ...rest }) => ({
            ...rest,
            status: status === 'failed' ? 'failed' : 'queued',
        }));
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
        // The in-memory queue is still correct and the files are still on disk;
        // only the survive-a-force-quit guarantee is lost. Not worth an alert.
    }
}

