/**
 * The draft store: ONE open automation's definition as the editor holds it,
 * with its undo history, its save pipeline and its findings.
 *
 * A vanilla zustand store rather than a hook, one instance per open automation
 * (registry.ts hands them out by id), because the build screen and the step
 * editor pushed over it edit the SAME draft: a second copy would be a second
 * truth, and two autosaves racing each other.
 *
 *   - Edits are pure model operations (`applyOp(def => applyAddNode(def, …))`)
 *     recorded in model/history.ts's undo stack: 600 ms coalescing, 50 deep.
 *   - Every edit, undo and redo schedules a save (scheduler.ts): debounced
 *     900 ms, single-flight, retried on a transient failure.
 *   - A new automation is created by its first save. A create that failed
 *     without an answer is never sent again on its own: it may have landed.
 *   - While the AI builder streams into the automation, edits are refused
 *     (`setLocked`) and its drafts arrive through `replaceDefinition`.
 */

import { createStore } from 'zustand/vanilla';

import { translate } from '@/core/i18n';

import type { DraftContext, GetDraft, SetDraft } from './context';
import { editActions, replaceAction } from './editActions';
import { emptyIssueSources, NO_ISSUES } from './issues';
import { saveActions } from './saveActions';
import type { DraftActions, DraftData, DraftOptions, DraftState, DraftStore } from './types';
import { emptyHistory } from '../model/history';
import type { FlowDefinition } from '../model/types';

function initialData(options: DraftOptions): DraftData {
    const seed: FlowDefinition | null = options.seed ?? null;
    return {
        automationId: options.automationId,
        ready: seed !== null,
        definition: seed,
        baseline: seed,
        version: null,
        dirty: false,
        status: 'idle',
        saveError: null,
        lastSavedAt: null,
        history: emptyHistory<FlowDefinition>(),
        canUndo: false,
        canRedo: false,
        issueSources: emptyIssueSources(),
        issues: NO_ISSUES,
        issuesByStep: new Map(),
        locked: false,
    };
}

export function createDraftStore(options: DraftOptions): DraftStore {
    const ctx: DraftContext = {
        deps: options.deps,
        now: options.deps.now ?? Date.now,
        title: options.title || translate('studio.new.untitled_automation', 'Untitled automation'),
        scheduler: null,
        createInFlight: null,
        createUnsure: false,
        lastApplied: null,
        epoch: 0,
        hydrateAbove: null,
        turnEntryOpen: false,
    };
    return createStore<DraftState>()((set, get) => ({
        ...initialData(options),
        ...actionsOf(set, get, ctx),
    }));
}

function actionsOf(set: SetDraft, get: GetDraft, ctx: DraftContext): DraftActions {
    return {
        ...editActions(set, get, ctx),
        replaceDefinition: replaceAction(set, get, ctx),
        ...saveActions(set, get, ctx),
    };
}
