/**
 * The upload queue.
 *
 * Uploading in this app is a first-class flow, not a fire-and-forget: a person
 * picks three PDFs on a train, one of them fails halfway through a tunnel, and
 * the other two must still land. So every file gets a row that survives its
 * own failure, remembers the local uri, and can be retried without re-picking.
 *
 * Sequential on purpose. Three concurrent multipart POSTs on a phone radio are
 * slower than three in a row, and the server parses each one into memory
 * (multer.memoryStorage) — a 50 MB fan-out is not a favour to anybody.
 *
 * The queue itself lives in a ref, with React state as a mirror of it. The
 * pump is an async loop, and a loop that read the list from state would close
 * over the snapshot it started with and upload the same file twice. `commit`
 * is the only writer, so the two can never drift.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import { describeError } from '@/core/api/errors';

import { uploadFile, type UploadFile, type UploadTarget } from '../api/upload';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadItem extends UploadFile {
    id: string;
    status: UploadStatus;
    /** 0..1. Stays at 0 until the first progress event. */
    progress: number;
    error: string | null;
}

export interface UseUploadQueue {
    items: UploadItem[];
    /** True while anything is queued or in flight — drives the busy banner. */
    active: boolean;
    add: (files: UploadFile[]) => void;
    retry: (id: string) => void;
    /** Aborts if in flight, drops the row either way. */
    remove: (id: string) => void;
    /** Clears finished rows. Failed ones stay until dismissed by hand. */
    clearFinished: () => void;
}

type Patch = (id: string, changes: Partial<UploadItem>) => void;

interface Pump {
    queue: MutableRefObject<UploadItem[]>;
    inFlight: MutableRefObject<AbortController | null>;
    patch: Patch;
    target: () => UploadTarget;
    onUploaded: (result: unknown, item: UploadItem) => void;
}

let nextId = 0;

/** Upload one row, and leave it in exactly one terminal state. */
async function uploadOne(next: UploadItem, pump: Pump): Promise<void> {
    const controller = new AbortController();
    pump.inFlight.current = controller;
    pump.patch(next.id, { status: 'uploading', progress: 0, error: null });
    try {
        const result = await uploadFile<unknown>(pump.target(), next, {
            signal: controller.signal,
            onProgress: (p) => pump.patch(next.id, { progress: p.fraction }),
        });
        pump.patch(next.id, { status: 'done', progress: 1 });
        pump.onUploaded(result, next);
    } catch (err) {
        // describeError turns a 402 into a plan message and a 409 into the
        // server's own "duplicate content" line, both of which a person can act on.
        pump.patch(
            next.id,
            controller.signal.aborted
                ? { status: 'cancelled' }
                : { status: 'error', error: describeError(err).message },
        );
    } finally {
        pump.inFlight.current = null;
    }
}

/** The ref and its rendered mirror, with `commit` as the single writer. */
function useQueueStore() {
    const [items, setItems] = useState<UploadItem[]>([]);
    const queue = useRef<UploadItem[]>([]);

    const commit = useCallback((update: (prev: UploadItem[]) => UploadItem[]) => {
        const next = update(queue.current);
        queue.current = next;
        setItems(next);
    }, []);

    const patch = useCallback<Patch>(
        (id, changes) => commit((prev) => prev.map((it) => (it.id === id ? { ...it, ...changes } : it))),
        [commit],
    );

    return { items, queue, commit, patch };
}

/**
 * The sequential pump. It reads the target and callback through refs (the
 * latest-value pattern): tearing it down on every parent render would abort
 * an upload in progress.
 */
function useQueuePump(
    store: ReturnType<typeof useQueueStore>,
    target: UploadTarget,
    onUploaded: ((result: unknown, item: UploadItem) => void) | undefined,
) {
    const { queue, patch } = store;
    const inFlight = useRef<AbortController | null>(null);
    const running = useRef(false);
    const callback = useRef(onUploaded);
    const targetRef = useRef(target);
    useEffect(() => {
        callback.current = onUploaded;
        targetRef.current = target;
    });

    useEffect(() => () => inFlight.current?.abort(), []);

    const pump = useCallback(async () => {
        if (running.current) return;
        running.current = true;
        const deps: Pump = {
            queue,
            inFlight,
            patch,
            target: () => targetRef.current,
            onUploaded: (result, item) => callback.current?.(result, item),
        };
        const queued = () => queue.current.find((it) => it.status === 'queued');
        try {
            for (let next = queued(); next; next = queued()) await uploadOne(next, deps);
        } finally {
            running.current = false;
        }
    }, [patch, queue]);

    return { pump, inFlight };
}

export function useUploadQueue(
    target: UploadTarget,
    opts: { onUploaded?: (result: unknown, item: UploadItem) => void } = {},
): UseUploadQueue {
    const store = useQueueStore();
    const { items, queue, commit } = store;
    const { pump, inFlight } = useQueuePump(store, target, opts.onUploaded);

    const add = useCallback(
        (files: UploadFile[]) => {
            if (files.length === 0) return;
            const rows: UploadItem[] = files.map((f) => ({
                ...f,
                id: `up-${(nextId += 1)}`,
                status: 'queued',
                progress: 0,
                error: null,
            }));
            commit((prev) => [...prev, ...rows]);
            void pump();
        },
        [commit, pump],
    );

    const retry = useCallback(
        (id: string) => {
            commit((prev) =>
                prev.map((it) => (it.id === id ? { ...it, status: 'queued', error: null, progress: 0 } : it)),
            );
            void pump();
        },
        [commit, pump],
    );

    const remove = useCallback(
        (id: string) => {
            const row = queue.current.find((it) => it.id === id);
            if (row?.status === 'uploading') inFlight.current?.abort();
            commit((prev) => prev.filter((it) => it.id !== id));
        },
        [commit, inFlight, queue],
    );

    const clearFinished = useCallback(() => {
        commit((prev) => prev.filter((it) => it.status !== 'done' && it.status !== 'cancelled'));
    }, [commit]);

    const active = items.some((it) => it.status === 'queued' || it.status === 'uploading');

    return { items, active, add, retry, remove, clearFinished };
}
