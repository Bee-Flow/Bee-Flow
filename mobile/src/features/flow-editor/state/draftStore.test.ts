/**
 * The draft store end to end on a fake clock, with the server faked at the
 * store's two seams (save, create): edits and undo/redo, the debounced
 * single-flight autosave that always sends the newest definition, retries,
 * findings from a save's warnings and a 400's details, the lazily created
 * row, and the AI builder's locked turn.
 */

import { ApiError } from '@/core/api/client';

import { createDraftStore } from './draftStore';
import type { DraftDeps, DraftStore } from './types';
import type { FlowAutomation, SaveResult } from '../api/types';
import { CAP } from '../model/history';
import { applyAddNode, applyPatchStep } from '../model/index';
import type { FlowDefinition } from '../model/types';

const BASE: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
    steps: [{ id: 's1', type: 'set', label: 'First', position: { x: 300, y: 0 } }],
    edges: [{ from: 'trg', to: 's1' }],
};

function rowOf(id: string, definition: FlowDefinition, version: number): FlowAutomation {
    return {
        id, userId: 'u1', organizationId: null, projectId: null, folderId: null, kind: 'automation', title: 'Flow',
        description: null, definition, version, isActive: false, isDraft: true, needsFirstRunConfirm: false,
        triggerType: 'manual', scheduleCron: null, scheduleTz: null, nextRunAt: null, lastRunAt: null, lastStatus: null,
        runningInstanceId: null, runningStartedAt: null, createdAt: null, updatedAt: null,
    };
}

function fakeServer(extra: Partial<DraftDeps> = {}) {
    let version = 1;
    const sent: FlowDefinition[] = [];
    const ok = (id: string, definition: FlowDefinition, warnings: SaveResult['warnings'] = []): SaveResult => {
        version += 1;
        return { automation: rowOf(id, definition, version), warnings, answers: null };
    };
    const deps: DraftDeps = {
        save: jest.fn(async (id: string, definition: FlowDefinition) => {
            sent.push(definition);
            return ok(id, definition);
        }),
        create: jest.fn(async ({ definition }) => {
            sent.push(definition);
            return ok('auto-new', definition);
        }),
        onSaved: jest.fn(),
        onCreated: jest.fn(),
        now: () => Date.now(),
        ...extra,
    };
    return { deps, sent, ok };
}

function loaded(deps: DraftDeps, definition: FlowDefinition = BASE): DraftStore {
    const store = createDraftStore({ automationId: 'a1', deps });
    store.getState().hydrate(definition, 1);
    return store;
}

async function settle() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** Let the debounce run out and every save it started finish. */
async function autosave() {
    jest.advanceTimersByTime(900);
    await settle();
}

const rename = (label: string) => (def: FlowDefinition) => applyPatchStep(def, 's1', { label });

const invalid = (details: unknown[]) =>
    new ApiError('Invalid definition', { status: 400, body: { error: 'Invalid definition', details } });

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-24T10:00:00Z'));
});
afterEach(() => jest.useRealTimers());

describe('loading', () => {
    it('is not editable until it has a definition', () => {
        const { deps } = fakeServer();
        const store = createDraftStore({ automationId: 'a1', deps });
        expect(store.getState().ready).toBe(false);
        expect(store.getState().applyOp(rename('x'))).toBeNull();
        store.getState().hydrate(BASE, 3);
        expect(store.getState()).toMatchObject({ ready: true, dirty: false, version: 3, definition: BASE, baseline: BASE });
    });

    it('ignores an older row, and any row while there are unsaved edits', () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        const labelled = (label: string) => rename(label)(BASE) as FlowDefinition;
        store.getState().hydrate(labelled('v5'), 5);
        expect(store.getState().definition?.steps[0]?.label).toBe('v5');
        store.getState().hydrate(labelled('v4'), 4);
        expect(store.getState().definition?.steps[0]?.label).toBe('v5');
        store.getState().applyOp(rename('mine'));
        store.getState().hydrate(labelled('v9'), 9);
        expect(store.getState().definition?.steps[0]?.label).toBe('mine');
    });
});

describe('edits and undo', () => {
    it('applies a pure op, marks the draft dirty, and treats "no change" as nothing', () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        expect(store.getState().applyOp((d) => d)).toBeNull();
        expect(store.getState().applyOp(rename('First'))).toBeNull();
        const next = store.getState().applyOp(rename('Second'));
        expect(next?.steps[0]?.label).toBe('Second');
        expect(store.getState()).toMatchObject({ dirty: true, status: 'pending', canUndo: true });
    });

    it('coalesces edits within 600 ms into one undo entry, and caps the history', () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        store.getState().applyOp(rename('a'));
        jest.advanceTimersByTime(100);
        store.getState().applyOp(rename('ab'));
        jest.advanceTimersByTime(700);
        store.getState().applyOp(rename('abc'));
        expect(store.getState().history.past).toHaveLength(2);
        store.getState().undo();
        expect(store.getState().definition?.steps[0]?.label).toBe('ab');
        store.getState().undo();
        expect(store.getState().definition?.steps[0]?.label).toBe('First');
        expect(store.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: true });
        store.getState().redo();
        expect(store.getState().definition?.steps[0]?.label).toBe('ab');

        for (let i = 0; i < CAP + 10; i += 1) {
            jest.advanceTimersByTime(700);
            store.getState().applyOp(rename(`n${i}`));
        }
        expect(store.getState().history.past).toHaveLength(CAP);
    });

    it('saves an undo like any other edit', async () => {
        const { deps, sent } = fakeServer();
        const store = loaded(deps);
        store.getState().applyOp(rename('x'));
        await autosave();
        store.getState().undo();
        await autosave();
        expect(sent.map((d) => d.steps[0]?.label)).toEqual(['x', 'First']);
    });

    it('adds a node through the model op', () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        store.getState().applyOp((d) => applyAddNode(d, { kind: 'step', type: 'wait' }, { sourceId: 's1' }));
        const { steps, edges } = store.getState().definition as FlowDefinition;
        expect(steps).toHaveLength(2);
        expect(edges).toContainEqual({ from: 's1', to: steps[1]?.id });
    });
});

describe('autosave', () => {
    it('sends one save 900 ms after the last edit, with the newest definition', async () => {
        const { deps, sent } = fakeServer();
        const store = loaded(deps);
        store.getState().applyOp(rename('a'));
        jest.advanceTimersByTime(500);
        store.getState().applyOp(rename('ab'));
        jest.advanceTimersByTime(899);
        expect(deps.save).not.toHaveBeenCalled();
        await autosave();
        expect(deps.save).toHaveBeenCalledTimes(1);
        expect(sent[0]?.steps[0]?.label).toBe('ab');
        expect(store.getState()).toMatchObject({ dirty: false, status: 'saved', version: 2, saveError: null });
        expect(store.getState().lastSavedAt).toBe(Date.now());
        expect(deps.onSaved).toHaveBeenCalledTimes(1);
    });

    it('never overlaps saves: an edit during a flight is sent by exactly one more save', async () => {
        const gates: (() => void)[] = [];
        const { deps, sent, ok } = fakeServer();
        deps.save = jest.fn(async (id: string, definition: FlowDefinition) => {
            sent.push(definition);
            await new Promise<void>((resolve) => gates.push(resolve));
            return ok(id, definition);
        });
        const store = loaded(deps);
        store.getState().applyOp(rename('one'));
        await autosave();
        expect(gates).toHaveLength(1);

        store.getState().applyOp(rename('two'));
        await autosave();
        store.getState().applyOp(rename('three'));
        await autosave();
        expect(deps.save).toHaveBeenCalledTimes(1);

        gates.shift()?.();
        await settle();
        // The first save landed; the store is still dirty and the follow-up is out.
        expect(sent.map((d) => d.steps[0]?.label)).toEqual(['one', 'three']);
        gates.shift()?.();
        await settle();
        expect(deps.save).toHaveBeenCalledTimes(2);
        expect(store.getState()).toMatchObject({ dirty: false, status: 'saved' });
    });

    it('keeps the edits made during a flight: the echo never replaces them', async () => {
        let release: () => void = () => undefined;
        const { deps, ok } = fakeServer();
        deps.save = jest.fn(async (id: string, definition: FlowDefinition) => {
            await new Promise<void>((resolve) => (release = resolve));
            return ok(id, definition);
        });
        const store = loaded(deps);
        store.getState().applyOp(rename('sent'));
        await autosave();
        store.getState().applyOp(rename('typed meanwhile'));
        release();
        await settle();
        expect(store.getState().definition?.steps[0]?.label).toBe('typed meanwhile');
        expect(store.getState().baseline?.steps[0]?.label).toBe('sent');
        expect(store.getState().dirty).toBe(true);
    });

    it('flush skips the wait and answers whether everything is saved', async () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        store.getState().applyOp(rename('now'));
        await expect(store.getState().flush()).resolves.toBe(true);
        expect(deps.save).toHaveBeenCalledTimes(1);
        await expect(store.getState().flush()).resolves.toBe(true);
        expect(deps.save).toHaveBeenCalledTimes(1);
    });
});

describe('failures', () => {
    it('retries a transient failure with backoff and recovers', async () => {
        const { deps, ok } = fakeServer();
        let calls = 0;
        deps.save = jest.fn(async (id: string, definition: FlowDefinition) => {
            calls += 1;
            if (calls < 3) throw new ApiError('Bad gateway', { status: 502 });
            return ok(id, definition);
        });
        deps.retryDelaysMs = [1000, 3000];
        const store = loaded(deps);
        store.getState().applyOp(rename('x'));
        await autosave();
        expect(store.getState().saveError).toMatchObject({ kind: 'transient', status: 502, willRetry: true });
        expect(store.getState().status).toBe('error');
        jest.advanceTimersByTime(1000);
        await settle();
        expect(deps.save).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(3000);
        await settle();
        expect(deps.save).toHaveBeenCalledTimes(3);
        expect(store.getState()).toMatchObject({ dirty: false, saveError: null, status: 'saved' });
    });

    it('a network failure (no answer at all) is transient; retries run out and say so', async () => {
        const { deps } = fakeServer({ retryDelaysMs: [1000] });
        deps.save = jest.fn(async () => {
            throw new TypeError('Network request failed');
        });
        const store = loaded(deps);
        store.getState().applyOp(rename('x'));
        await autosave();
        jest.advanceTimersByTime(1000);
        await settle();
        expect(deps.save).toHaveBeenCalledTimes(2);
        expect(store.getState().saveError).toMatchObject({ kind: 'transient', status: null, willRetry: false });
        expect(store.getState().dirty).toBe(true);
    });

    it('turns a 400 into errors on the steps it names, without retrying; the next edit tries again', async () => {
        const { deps, ok } = fakeServer();
        let refuse = true;
        deps.save = jest.fn(async (id: string, definition: FlowDefinition) => {
            if (refuse) throw invalid([{ code: 'set.bad', severity: 'error', path: 'steps[s1].fields', message: 'Bad field' }, 'A bare sentence']);
            return ok(id, definition);
        });
        const store = loaded(deps);
        store.getState().applyOp(rename('x'));
        await autosave();
        jest.advanceTimersByTime(60_000);
        await settle();
        expect(deps.save).toHaveBeenCalledTimes(1);
        const state = store.getState();
        expect(state.saveError).toMatchObject({ kind: 'permanent', status: 400 });
        expect(state.issues.errors.map((e) => e.message)).toEqual(['Bad field', 'A bare sentence']);
        expect(state.issuesByStep.get('s1')?.errors).toHaveLength(1);

        refuse = false;
        store.getState().applyOp(rename('fixed'));
        await autosave();
        expect(store.getState()).toMatchObject({ saveError: null, status: 'saved' });
        expect(store.getState().issues.errors).toEqual([]);
    });

    it('an undo back to what the server holds clears the failed save', async () => {
        const { deps } = fakeServer({ retryDelaysMs: [] });
        deps.save = jest.fn(async () => {
            throw invalid(['nope']);
        });
        const store = loaded(deps);
        store.getState().applyOp(rename('x'));
        await autosave();
        expect(store.getState().saveError?.kind).toBe('permanent');
        store.getState().undo();
        expect(store.getState()).toMatchObject({ dirty: false, saveError: null, status: 'saved' });
        await autosave();
        expect(deps.save).toHaveBeenCalledTimes(1);
    });

    it('reads a save’s warnings as findings and maps them to steps', async () => {
        const { deps, ok } = fakeServer();
        deps.save = jest.fn(async (id: string, definition: FlowDefinition) =>
            ok(id, definition, [{ severity: 'warning', code: 'input.missing', path: 'steps[s1].inputs.to', message: 'Fill this in', blockedAt: 'activate' }]),
        );
        const store = loaded(deps);
        store.getState().applyOp(rename('x'));
        await autosave();
        expect(store.getState().issues.warnings).toHaveLength(1);
        expect(store.getState().issuesByStep.get('s1')?.warnings[0]?.blockedAt).toBe('activate');
    });
});

describe('findings from several sources', () => {
    it('merges the sources, drops duplicates, and replaces each source wholesale', () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        const issue = { severity: 'error' as const, code: 'x', path: 'steps[s1]', message: 'Broken' };
        store.getState().setIssues('activate', { errors: [issue], warnings: [] });
        store.getState().setIssues('builder', { errors: [issue, { ...issue, message: 'Other' }], warnings: [] });
        expect(store.getState().issues.errors.map((e) => e.message)).toEqual(['Broken', 'Other']);
        store.getState().setIssues('builder', null);
        expect(store.getState().issues.errors.map((e) => e.message)).toEqual(['Broken']);
        expect(store.getState().issuesByStep.get('s1')?.errors).toHaveLength(1);
    });

    it('drops the last Go live’s findings once the flow changes, and keeps the others', () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        const blocked = { severity: 'error' as const, code: 'x', path: 'steps[s1]', message: 'Blocks going live' };
        const built = { severity: 'warning' as const, code: 'y', path: 'steps[s1]', message: 'From the AI' };
        store.getState().setIssues('activate', { errors: [blocked], warnings: [] });
        store.getState().setIssues('builder', { errors: [], warnings: [built] });
        store.getState().applyOp(rename('fixed'));
        expect(store.getState().issues.errors).toHaveLength(0);
        expect(store.getState().issues.warnings.map((w) => w.message)).toEqual(['From the AI']);
        expect(store.getState().issuesByStep.get('s1')?.errors ?? []).toHaveLength(0);
    });
});

describe('a new automation', () => {
    const seed: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [], edges: [] };

    it('starts from its seed, sends nothing until the first edit, then creates the row once', async () => {
        const { deps } = fakeServer();
        const store = createDraftStore({ automationId: null, seed, title: 'My flow', deps });
        expect(store.getState()).toMatchObject({ ready: true, dirty: false, automationId: null });
        await store.getState().flush();
        expect(deps.create).not.toHaveBeenCalled();

        store.getState().applyOp((d) => applyAddNode(d, { kind: 'step', type: 'set' }, { sourceId: 'trg' }));
        await autosave();
        expect(deps.create).toHaveBeenCalledTimes(1);
        expect((deps.create as jest.Mock).mock.calls[0][0].title).toBe('My flow');
        expect(deps.onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'auto-new' }));
        expect(store.getState()).toMatchObject({ automationId: 'auto-new', dirty: false, status: 'saved' });

        store.getState().applyOp((d) => applyPatchStep(d, d.steps[0]?.id as string, { label: 'Then' }));
        await autosave();
        expect(deps.create).toHaveBeenCalledTimes(1);
        expect(deps.save).toHaveBeenCalledWith('auto-new', expect.anything());
    });

    it('shares one create between the autosave and anyone asking for the id', async () => {
        let release: () => void = () => undefined;
        const { deps, ok } = fakeServer();
        deps.create = jest.fn(async ({ definition }) => {
            await new Promise<void>((resolve) => (release = resolve));
            return ok('auto-new', definition);
        });
        const store = createDraftStore({ automationId: null, seed, deps });
        store.getState().applyOp((d) => applyAddNode(d, { kind: 'step', type: 'set' }));
        await autosave();
        const asked = store.getState().ensureCreated();
        release();
        await expect(asked).resolves.toBe('auto-new');
        expect(deps.create).toHaveBeenCalledTimes(1);
        expect(deps.onSaved).toHaveBeenCalledTimes(1);
    });

    it('creates the row on demand, with nothing edited', async () => {
        const { deps } = fakeServer();
        const store = createDraftStore({ automationId: null, seed, deps });
        await expect(store.getState().ensureCreated()).resolves.toBe('auto-new');
        await expect(store.getState().ensureCreated()).resolves.toBe('auto-new');
        expect(deps.create).toHaveBeenCalledTimes(1);
    });

    it('never sends a create again on its own after one failed without an answer', async () => {
        const { deps, ok } = fakeServer();
        let fail = true;
        deps.create = jest.fn(async ({ definition }) => {
            if (fail) throw new ApiError('Bad gateway', { status: 502 });
            return ok('auto-new', definition);
        });
        const store = createDraftStore({ automationId: null, seed, deps });
        store.getState().applyOp((d) => applyAddNode(d, { kind: 'step', type: 'set' }));
        await autosave();
        expect(deps.create).toHaveBeenCalledTimes(1);
        expect(store.getState()).toMatchObject({ status: 'error', saveError: { kind: 'transient', willRetry: false } });

        // No backoff, and a later edit does not create either: the first may have landed.
        jest.advanceTimersByTime(20_000);
        await settle();
        store.getState().applyOp((d) => applyPatchStep(d, d.steps[0]?.id as string, { label: 'Then' }));
        await autosave();
        expect(deps.create).toHaveBeenCalledTimes(1);
        expect(store.getState()).toMatchObject({ status: 'error', dirty: true });

        // The person says "try again".
        fail = false;
        await expect(store.getState().retry()).resolves.toBe(true);
        expect(deps.create).toHaveBeenCalledTimes(2);
        expect(store.getState()).toMatchObject({ automationId: 'auto-new', status: 'saved', saveError: null });
    });

    it('sends a create the server refused again with the next edit', async () => {
        const { deps, ok } = fakeServer();
        let fail = true;
        deps.create = jest.fn(async ({ definition }) => {
            if (fail) throw invalid([]);
            return ok('auto-new', definition);
        });
        const store = createDraftStore({ automationId: null, seed, deps });
        store.getState().applyOp((d) => applyAddNode(d, { kind: 'step', type: 'set' }));
        await autosave();
        fail = false;
        store.getState().applyOp((d) => applyPatchStep(d, d.steps[0]?.id as string, { label: 'Then' }));
        await autosave();
        expect(deps.create).toHaveBeenCalledTimes(2);
        expect(store.getState().automationId).toBe('auto-new');
    });

    it('adopts an id the AI builder created', async () => {
        const { deps } = fakeServer();
        const store = createDraftStore({ automationId: null, seed, deps });
        store.getState().adoptAutomationId('from-ai');
        store.getState().applyOp((d) => applyAddNode(d, { kind: 'step', type: 'set' }));
        await autosave();
        expect(deps.create).not.toHaveBeenCalled();
        expect(deps.save).toHaveBeenCalledWith('from-ai', expect.anything());
    });
});

describe('the AI builder turn', () => {
    it('refuses local edits while locked and folds the turn’s drafts into one undo entry', async () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        store.getState().setLocked(true);
        expect(store.getState().applyOp(rename('mine'))).toBeNull();
        expect(store.getState().undo()).toBe(false);

        const draft1 = applyAddNode(BASE, { kind: 'step', type: 'wait' }) as FlowDefinition;
        jest.advanceTimersByTime(5000);
        store.getState().replaceDefinition(draft1, { persisted: true });
        jest.advanceTimersByTime(5000);
        const draft2 = applyAddNode(draft1, { kind: 'step', type: 'set' }) as FlowDefinition;
        store.getState().replaceDefinition(draft2, { persisted: true });
        store.getState().setLocked(false);

        expect(store.getState()).toMatchObject({ definition: draft2, baseline: draft2, dirty: false });
        await autosave();
        expect(deps.save).not.toHaveBeenCalled();

        expect(store.getState().history.past).toHaveLength(1);
        store.getState().undo();
        expect(store.getState().definition).toEqual(BASE);
        expect(store.getState().dirty).toBe(true);
        await autosave();
        expect(deps.save).toHaveBeenCalledTimes(1);
    });

    it('an echo of the row from before an AI draft cannot take the draft back', () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        const aiDraft = applyAddNode(BASE, { kind: 'step', type: 'wait' }) as FlowDefinition;
        store.getState().replaceDefinition(aiDraft, { persisted: true });
        store.getState().hydrate(BASE, 1);
        expect(store.getState().definition).toBe(aiDraft);
        const reread = { ...aiDraft, vars: {} };
        store.getState().hydrate(reread, 2);
        expect(store.getState()).toMatchObject({ definition: reread, version: 2 });
    });

    it('a replacement that is not persisted (nothing on the server yet) is saved', async () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        store.getState().replaceDefinition({ ...BASE, steps: [] });
        await autosave();
        expect(deps.save).toHaveBeenCalledTimes(1);
    });
});

describe('dispose', () => {
    it('stops the pending save', async () => {
        const { deps } = fakeServer();
        const store = loaded(deps);
        store.getState().applyOp(rename('x'));
        store.getState().dispose();
        await autosave();
        expect(deps.save).not.toHaveBeenCalled();
    });
});
