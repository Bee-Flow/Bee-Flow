/**
 * Unsaved edits, kept on this phone until the server has them.
 *
 * Every edit is saved to the server within a second (scheduler.ts), and that
 * stays the one real copy. But a phone loses its connection, and Android can
 * end the app at any moment: an edit the server has not confirmed would then
 * be gone. So while the draft is dirty it is ALSO written here — sealed
 * (core/crypto/sealed: AES-256-GCM, the key in the Keystore, wiped on
 * sign-out) — and removed the moment the server confirms it.
 *
 * On the next open, `restoreFromDisk` puts it back. When the server's copy is
 * still the one the edits started from, the edits are simply re-applied as
 * one undoable step, and autosave sends them. When someone changed the
 * routine elsewhere in the meantime, it is not the phone's call which copy
 * wins: the screen asks (LocalDraftBanner).
 */

import type { DraftStore } from './types';
import { sameDraft } from '../model/history';
import type { FlowDefinition } from '../model/types';

export interface DiskDraft {
    definition: FlowDefinition;
    /** The server version the edits started from. */
    baseVersion: number | null;
    savedAt: number;
}

/** Where drafts go: sealed storage in the app, a map in a test. */
export interface DiskIO {
    put: (automationId: string, draft: DiskDraft) => Promise<unknown>;
    get: (automationId: string) => Promise<DiskDraft | null>;
    remove: (automationId: string) => Promise<void>;
}

export const DISK_WRITE_DELAY_MS = 500;

export interface DiskKeeper {
    /** Write a pending draft now (the app is going to the background). */
    writeNow: () => void;
    stop: () => void;
}

/**
 * Mirror the store's unsaved draft to disk: written (debounced) while dirty,
 * removed once saved. Only a routine with an id is kept — until its first save
 * a new routine has nothing on the server to come back to.
 */
export function keepOnDisk(store: DraftStore, io: DiskIO, now: () => number = Date.now, delayMs = DISK_WRITE_DELAY_MS): DiskKeeper {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let written: string | null = null;

    const write = () => {
        timer = null;
        const s = store.getState();
        if (!s.dirty || !s.definition || !s.automationId) return;
        written = s.automationId;
        void io.put(s.automationId, { definition: s.definition, baseVersion: s.version, savedAt: now() });
    };
    const onChange = () => {
        const s = store.getState();
        if (s.dirty && s.definition && s.automationId) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(write, delayMs);
            return;
        }
        if (timer) clearTimeout(timer);
        timer = null;
        if (!s.dirty && written) {
            void io.remove(written);
            written = null;
        }
    };
    const unsubscribe = store.subscribe((next, prev) => {
        if (next.definition !== prev.definition || next.dirty !== prev.dirty || next.automationId !== prev.automationId) onChange();
    });
    return {
        writeNow: () => {
            if (!timer) return;
            clearTimeout(timer);
            write();
        },
        stop: () => {
            if (timer) clearTimeout(timer);
            timer = null;
            unsubscribe();
        },
    };
}

export type RestoreResult = { kind: 'none' } | { kind: 'restored' } | { kind: 'conflict'; draft: DiskDraft };

/**
 * After the server's copy is loaded: bring back what this phone kept. Call
 * once per open, with the store hydrated.
 */
export async function restoreFromDisk(store: DraftStore, io: DiskIO): Promise<RestoreResult> {
    const id = store.getState().automationId;
    if (!id) return { kind: 'none' };
    const draft = await io.get(id);
    const s = store.getState();
    if (!draft || !s.ready || !s.definition) return { kind: 'none' };
    // Already on screen (the store outlived its screens), or the server has it after all.
    if (sameDraft(draft.definition, s.definition)) {
        if (!s.dirty) await io.remove(id);
        return { kind: 'none' };
    }
    if (s.dirty) return { kind: 'none' };
    if (draft.baseVersion === null || s.version === null || draft.baseVersion === s.version) {
        s.replaceDefinition(draft.definition);
        return { kind: 'restored' };
    }
    return { kind: 'conflict', draft };
}

/** The person chose: the phone's edits go on top of the server's copy (one undo away), or are dropped. */
export async function resolveConflict(store: DraftStore, io: DiskIO, draft: DiskDraft, keepPhone: boolean): Promise<void> {
    const s = store.getState();
    if (keepPhone) s.replaceDefinition(draft.definition);
    else if (s.automationId) await io.remove(s.automationId);
}
