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
 * The queue itself lives in a ref, with React state as a mirror of it. That is
 * not premature cleverness: the pump is an async loop, and a loop that read
 * the list from state would close over the snapshot it started with and upload
 * the same file twice. `commit` is the only writer, so the two can never drift.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { uploadFile, type UploadFile, type UploadTarget } from './upload';
import { describeError } from '../../ui/Feedback';

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

let nextId = 0;

export function useUploadQueue(
    target: UploadTarget,
    opts: { onUploaded?: (result: unknown, item: UploadItem) => void } = {},
): UseUploadQueue {
    const [items, setItems] = useState<UploadItem[]>([]);
    const queue = useRef<UploadItem[]>([]);
    const inFlight = useRef<AbortController | null>(null);
    const running = useRef(false);

    // The latest-value pattern: the pump must see the current target and
    // callback without being torn down and restarted on every parent render,
    // which would abort an upload in progress.
    const onUploaded = useRef(opts.onUploaded);
    const targetRef = useRef(target);
    useEffect(() => {
        onUploaded.current = opts.onUploaded;
        targetRef.current = target;
    });

    useEffect(
        () => () => {
            inFlight.current?.abort();
        },
        [],
    );

    /** The single writer. Keeps the ref and the rendered copy identical. */
    const commit = useCallback((update: (prev: UploadItem[]) => UploadItem[]) => {
        const next = update(queue.current);
        queue.current = next;
        setItems(next);
    }, []);

    const patch = useCallback(
        (id: string, changes: Partial<UploadItem>) => {
            commit((prev) => prev.map((it) => (it.id === id ? { ...it, ...changes } : it)));
        },
        [commit],
    );

    const pump = useCallback(async () => {
        if (running.current) return;
        running.current = true;
        try {
            for (;;) {
                const next = queue.current.find((it) => it.status === 'queued');
                if (!next) break;

                const controller = new AbortController();
                inFlight.current = controller;
                patch(next.id, { status: 'uploading', progress: 0, error: null });

                try {
                    const result = await uploadFile<unknown>(targetRef.current, next, {
                        signal: controller.signal,
                        onProgress: (p) => patch(next.id, { progress: p.fraction }),
                    });
                    patch(next.id, { status: 'done', progress: 1 });
                    onUploaded.current?.(result, next);
                } catch (err) {
                    if (controller.signal.aborted) {
                        patch(next.id, { status: 'cancelled' });
                    } else {
                        // describeError turns a 402 into a plan message and a 409
                        // into the server's own "duplicate content" line, both of
                        // which are things the person can act on.
                        patch(next.id, { status: 'error', error: describeError(err).message });
                    }
                } finally {
                    inFlight.current = null;
                }
            }
        } finally {
            running.current = false;
        }
    }, [patch]);

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
                prev.map((it) =>
                    it.id === id ? { ...it, status: 'queued', error: null, progress: 0 } : it,
                ),
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
        [commit],
    );

    const clearFinished = useCallback(() => {
        commit((prev) => prev.filter((it) => it.status !== 'done' && it.status !== 'cancelled'));
    }, [commit]);

    const active = items.some((it) => it.status === 'queued' || it.status === 'uploading');

    return { items, active, add, retry, remove, clearFinished };
}
