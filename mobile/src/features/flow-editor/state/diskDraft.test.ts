/**
 * Unsaved edits kept on the phone: written while the server does not have
 * them, gone once it does, and brought back on the next open — silently when
 * the server's copy is unchanged, by asking when it moved on.
 */

import { OfflineError } from '@/core/api/client';

import { keepOnDisk, resolveConflict, restoreFromDisk, type DiskDraft, type DiskIO } from './diskDraft';
import { createDraftStore } from './draftStore';
import type { DraftDeps, DraftStore } from './types';
import { applyPatchStep } from '../model/index';
import type { FlowDefinition } from '../model/types';

const BASE: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
    steps: [{ id: 's1', type: 'set', label: 'First', position: { x: 300, y: 0 } }],
    edges: [{ from: 'trg', to: 's1' }],
};
const renamed = (label: string) => applyPatchStep(BASE, 's1', { label });

function memoryIO() {
    const disk = new Map<string, DiskDraft>();
    const io: DiskIO = {
        put: jest.fn(async (id: string, d: DiskDraft) => void disk.set(id, d)),
        get: jest.fn(async (id: string) => disk.get(id) ?? null),
        remove: jest.fn(async (id: string) => void disk.delete(id)),
    };
    return { disk, io };
}

const offline = (): DraftDeps => ({
    save: jest.fn(async () => {
        throw new OfflineError();
    }),
    create: jest.fn(),
    retryDelaysMs: [],
});

function loaded(deps: DraftDeps, version = 3): DraftStore {
    const store = createDraftStore({ automationId: 'a1', deps });
    store.getState().hydrate(BASE, version);
    return store;
}

async function settle() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('keepOnDisk', () => {
    it('writes a dirty draft, with the version it started from', async () => {
        const { disk, io } = memoryIO();
        const store = loaded(offline());
        keepOnDisk(store, io, () => 42);
        store.getState().applyOp(() => renamed('Second'));
        jest.advanceTimersByTime(500);
        await settle();
        expect(disk.get('a1')).toEqual({ definition: renamed('Second'), baseVersion: 3, savedAt: 42 });
    });

    it('removes it once the server has it', async () => {
        const { disk, io } = memoryIO();
        const deps: DraftDeps = {
            save: jest.fn(async (id: string, definition: FlowDefinition) => ({ automation: { id, version: 4, definition } as never, warnings: [], answers: null })),
            create: jest.fn(),
        };
        const store = loaded(deps);
        keepOnDisk(store, io);
        store.getState().applyOp(() => renamed('Second'));
        jest.advanceTimersByTime(500);
        await settle();
        expect(disk.has('a1')).toBe(true);
        jest.advanceTimersByTime(900);
        await settle();
        expect(store.getState().dirty).toBe(false);
        expect(disk.has('a1')).toBe(false);
    });

    it('writes at once when asked (the app goes to the background)', async () => {
        const { disk, io } = memoryIO();
        const store = loaded(offline());
        const keeper = keepOnDisk(store, io);
        store.getState().applyOp(() => renamed('Now'));
        keeper.writeNow();
        await settle();
        expect(disk.get('a1')?.definition).toEqual(renamed('Now'));
    });
});

describe('restoreFromDisk', () => {
    it('re-applies the edits when the server copy is the one they started from', async () => {
        const { disk, io } = memoryIO();
        disk.set('a1', { definition: renamed('Kept'), baseVersion: 3, savedAt: 1 });
        const store = loaded(offline(), 3);
        expect(await restoreFromDisk(store, io)).toEqual({ kind: 'restored' });
        expect(store.getState().definition).toEqual(renamed('Kept'));
        expect(store.getState().dirty).toBe(true);
        // One undo away from the server's copy.
        store.getState().undo();
        expect(store.getState().definition).toEqual(BASE);
    });

    it('asks when the routine changed elsewhere', async () => {
        const { disk, io } = memoryIO();
        const draft = { definition: renamed('Mine'), baseVersion: 2, savedAt: 1 };
        disk.set('a1', draft);
        const store = loaded(offline(), 5);
        expect(await restoreFromDisk(store, io)).toEqual({ kind: 'conflict', draft });
        expect(store.getState().definition).toEqual(BASE);
    });

    it('keeps the phone copy, or drops it, as the person chose', async () => {
        const { disk, io } = memoryIO();
        const draft = { definition: renamed('Mine'), baseVersion: 2, savedAt: 1 };
        disk.set('a1', draft);
        const kept = loaded(offline(), 5);
        await resolveConflict(kept, io, draft, true);
        expect(kept.getState().definition).toEqual(renamed('Mine'));
        const dropped = loaded(offline(), 5);
        await resolveConflict(dropped, io, draft, false);
        expect(dropped.getState().definition).toEqual(BASE);
        expect(disk.has('a1')).toBe(false);
    });

    it('forgets a copy the server already holds', async () => {
        const { disk, io } = memoryIO();
        disk.set('a1', { definition: BASE, baseVersion: 3, savedAt: 1 });
        const store = loaded(offline(), 3);
        expect(await restoreFromDisk(store, io)).toEqual({ kind: 'none' });
        expect(disk.has('a1')).toBe(false);
    });
});
