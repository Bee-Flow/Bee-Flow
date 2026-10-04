/**
 * One store per open automation: shared between the screens that hold it, found
 * again under a new automation's id once it has one, flushed when the last
 * screen lets go and disposed after the grace period — and `ensureDraftSaved`,
 * which every "read the stored definition" action goes through.
 */

import { ApiError } from '@/core/api/client';

import { createDraftStore } from './draftStore';
import { ensureDraftSaved, UnsavedDraftError } from './ensureSaved';
import {
    aliasDraftStore,
    draftStoreFor,
    flushDraft,
    newDraftKey,
    peekDraftStore,
    releaseDraftStore,
    resetDraftRegistry,
    retainDraftStore,
} from './registry';
import type { DraftDeps } from './types';
import type { SaveResult } from '../api/types';
import { applyPatchStep } from '../model/index';
import type { FlowDefinition } from '../model/types';

const DEF: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set' }], edges: [] };

function deps(save: DraftDeps['save'] = async () => ({ automation: null, warnings: [], answers: null })): DraftDeps {
    return {
        save: jest.fn(save),
        create: jest.fn(async (): Promise<SaveResult> => ({
            automation: { id: 'made' } as SaveResult['automation'],
            warnings: [],
            answers: null,
        })),
    };
}

function openStore(key: string, d = deps(), automationId: string | null = key) {
    const store = draftStoreFor(key, () => createDraftStore({ automationId, seed: automationId ? null : DEF, deps: d }));
    if (automationId) store.getState().hydrate(DEF, 1);
    return store;
}

const edit = (label: string) => (d: FlowDefinition) => applyPatchStep(d, 's1', { label });

async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    resetDraftRegistry();
    jest.useRealTimers();
});

it('answers the same store for the same key, and a fresh key per new automation', () => {
    const a = openStore('a1');
    expect(draftStoreFor('a1', () => {
        throw new Error('must not create a second store');
    })).toBe(a);
    expect(newDraftKey()).not.toBe(newDraftKey());
});

it('finds a new automation’s store under its id once aliased', () => {
    const key = newDraftKey();
    const store = openStore(key, deps(), null);
    aliasDraftStore(key, 'made');
    expect(peekDraftStore('made')).toBe(store);
});

it('flushes when the last screen lets go and disposes after the grace period', async () => {
    const d = deps();
    const store = openStore('a1', d);
    retainDraftStore('a1');
    retainDraftStore('a1');
    store.getState().applyOp(edit('x'));
    releaseDraftStore('a1', 1000);
    await settle();
    expect(d.save).not.toHaveBeenCalled();
    releaseDraftStore('a1', 1000);
    await settle();
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(peekDraftStore('a1')).toBe(store);
    jest.advanceTimersByTime(1000);
    await settle();
    expect(peekDraftStore('a1')).toBeUndefined();
});

it('keeps a store whose edits did not reach the server, and keeps trying', async () => {
    let offline = true;
    const d = deps(async () => {
        if (offline) throw new TypeError('Network request failed');
        return { automation: null, warnings: [], answers: null };
    });
    d.retryDelaysMs = [];
    const store = createDraftStore({ automationId: 'a1', deps: d });
    draftStoreFor('a1', () => store);
    store.getState().hydrate(DEF, 1);
    retainDraftStore('a1');
    store.getState().applyOp(edit('offline edit'));
    releaseDraftStore('a1', 1000);
    await settle();
    jest.advanceTimersByTime(1000);
    await settle();
    expect(peekDraftStore('a1')).toBe(store);
    expect(store.getState().dirty).toBe(true);

    offline = false;
    jest.advanceTimersByTime(2000);
    await settle();
    expect(store.getState().dirty).toBe(false);
    expect(peekDraftStore('a1')).toBeUndefined();
});

it('keeps a refused store for the next screen without sending it again', async () => {
    const d = deps(async () => {
        throw new ApiError('Invalid definition', { status: 400, body: { error: 'Invalid definition', details: [] } });
    });
    const store = openStore('a1', d);
    retainDraftStore('a1');
    store.getState().applyOp(edit('refused'));
    releaseDraftStore('a1', 1000);
    await settle();
    jest.advanceTimersByTime(1000);
    await settle();
    const sent = (d.save as jest.Mock).mock.calls.length;
    jest.advanceTimersByTime(600_000);
    await settle();
    expect((d.save as jest.Mock).mock.calls.length).toBe(sent);
    expect(peekDraftStore('a1')).toBe(store);
});

it('keeps the store when a screen takes it back within the grace period', async () => {
    const store = openStore('a1');
    retainDraftStore('a1');
    releaseDraftStore('a1', 1000);
    retainDraftStore('a1');
    jest.advanceTimersByTime(5000);
    await settle();
    expect(peekDraftStore('a1')).toBe(store);
});

it('flushDraft is true with no editor open, and saves an open one', async () => {
    await expect(flushDraft('nobody')).resolves.toBe(true);
    const d = deps();
    openStore('a1', d).getState().applyOp(edit('x'));
    await expect(flushDraft('a1')).resolves.toBe(true);
    expect(d.save).toHaveBeenCalledTimes(1);
});

describe('ensureDraftSaved', () => {
    it('answers the key itself when no editor is open for it', async () => {
        await expect(ensureDraftSaved('a9')).resolves.toBe('a9');
    });

    it('creates a new automation and answers its id', async () => {
        const key = newDraftKey();
        const d = deps();
        openStore(key, d, null);
        await expect(ensureDraftSaved(key)).resolves.toBe('made');
        expect(d.create).toHaveBeenCalledTimes(1);
    });

    it('refuses when the latest edits cannot be saved', async () => {
        const store = openStore(
            'a1',
            deps(async () => {
                throw new ApiError('Invalid definition', { status: 400, body: { details: ['nope'] } });
            }),
        );
        store.getState().applyOp(edit('x'));
        const failure = ensureDraftSaved('a1');
        await expect(failure).rejects.toBeInstanceOf(UnsavedDraftError);
        await expect(failure).rejects.toMatchObject({ saveError: { kind: 'permanent', status: 400 } });
    });
});
