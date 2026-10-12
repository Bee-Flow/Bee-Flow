/**
 * The phone's copy of unsaved edits (state/diskDraft.ts), wired to the app:
 * sealed storage for the signed-in person, one keeper per draft store, and
 * one restore per store once the server's copy is loaded. A restore that
 * needs the person's say (the automation changed elsewhere) is held here until
 * LocalDraftBanner answers it.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { sealedGet, sealedPut, sealedRemove } from '@/core/crypto/sealed';

import { keepOnDisk, resolveConflict, restoreFromDisk, type DiskDraft, type DiskIO, type DiskKeeper } from '../state/diskDraft';
import type { DraftStore } from '../state/types';

const NAMESPACE = 'flow';

export function sealedDiskIO(owner: string): DiskIO {
    return {
        put: (id, draft) => sealedPut(owner, NAMESPACE, id, draft),
        get: (id) => sealedGet<DiskDraft>(owner, NAMESPACE, id),
        remove: (id) => sealedRemove(NAMESPACE, id),
    };
}

interface Attached {
    io: DiskIO;
    keeper: DiskKeeper;
    restored: boolean;
    conflict: DiskDraft | null;
}

const attached = new WeakMap<DraftStore, Attached>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Start keeping this store's unsaved edits on the phone. Idempotent. */
export function attachDisk(store: DraftStore, owner: string | null | undefined): void {
    if (!owner || attached.has(store)) return;
    const io = sealedDiskIO(owner);
    attached.set(store, { io, keeper: keepOnDisk(store, io), restored: false, conflict: null });
}

/** The app is going to the background: write a pending draft now. */
export function writeDiskNow(store: DraftStore): void {
    attached.get(store)?.keeper.writeNow();
}

export interface LocalDraft {
    /** The phone's copy, when the automation changed elsewhere since it was made. */
    conflict: DiskDraft | null;
    /** Keep the phone's edits (on top of the server's copy, one undo away), or drop them. */
    resolve: (keepPhone: boolean) => void;
}

/** Bring back what the phone kept, once per store, after the server's copy is in. */
export function useLocalDraft(store: DraftStore, loaded: boolean, onRestored?: () => void): LocalDraft {
    useEffect(() => {
        const entry = attached.get(store);
        if (!loaded || !entry || entry.restored) return;
        entry.restored = true;
        void restoreFromDisk(store, entry.io).then((result) => {
            if (result.kind === 'restored') onRestored?.();
            if (result.kind === 'conflict') {
                entry.conflict = result.draft;
                emit();
            }
        });
    }, [store, loaded, onRestored]);

    const conflict = useSyncExternalStore(
        (onChange) => {
            listeners.add(onChange);
            return () => listeners.delete(onChange);
        },
        () => attached.get(store)?.conflict ?? null,
    );
    return {
        conflict,
        resolve: (keepPhone) => {
            const entry = attached.get(store);
            if (!entry?.conflict) return;
            const draft = entry.conflict;
            entry.conflict = null;
            emit();
            void resolveConflict(store, entry.io, draft, keepPhone);
        },
    };
}
