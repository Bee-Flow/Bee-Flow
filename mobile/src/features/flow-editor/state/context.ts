/**
 * What the draft store's actions share besides the state itself: the
 * injected calls, the clock, the save scheduler, the in-flight create, and
 * two bits of bookkeeping no screen renders (so they are not state).
 */

import type { StoreApi } from 'zustand/vanilla';

import { issuesByStepFor, mergeIssues, NO_ISSUES } from './issues';
import type { SaveScheduler } from './scheduler';
import type { DraftData, DraftDeps, DraftState } from './types';
import type { SaveResult } from '../api/types';
import { canRedo, canUndo, sameDraft, type HistoryState } from '../model/history';
import type { FlowDefinition } from '../model/types';

export type SetDraft = StoreApi<DraftState>['setState'];
export type GetDraft = StoreApi<DraftState>['getState'];

export interface DraftContext {
    deps: DraftDeps;
    now: () => number;
    /** The new row's title, when the automation is created lazily. */
    title: string;
    scheduler: SaveScheduler | null;
    /** The one create in flight, shared by everyone who needs the row. */
    createInFlight: Promise<{ result: SaveResult; sent: FlowDefinition }> | null;
    /**
     * A create failed with no answer (offline, a timeout, a 5xx): it may have
     * landed, and another POST would be a second automation. While set, the
     * autosave does not create; only an explicit retry (or ensureCreated, which
     * a person's action calls) sends the create again.
     */
    createUnsure: boolean;
    /** The result whose success was already booked (a shared create is awaited twice). */
    lastApplied: SaveResult | null;
    /**
     * Bumped whenever the baseline is replaced from outside a save (a load, an
     * AI draft, a restore), so a save that started before cannot set its older
     * definition as the baseline when it lands.
     */
    epoch: number;
    /**
     * A persisted replacement with no version (an AI draft) is newer than every
     * row the store has seen: loads at or below this version are stale echoes.
     */
    hydrateAbove: number | null;
    /** While locked: the current AI turn already has its undo entry. */
    turnEntryOpen: boolean;
}

export function scheduleSave(ctx: DraftContext): void {
    ctx.scheduler?.schedule();
}

export function historyFields(history: HistoryState<FlowDefinition>): Pick<DraftData, 'history' | 'canUndo' | 'canRedo'> {
    return { history, canUndo: canUndo(history), canRedo: canRedo(history) };
}

/** The state after the definition on screen changed (an edit, an undo, a replacement). */
export function afterEdit(
    get: GetDraft,
    definition: FlowDefinition,
    history: HistoryState<FlowDefinition>,
): Partial<DraftData> {
    const s = get();
    const dirty = !sameDraft(definition, s.baseline);
    const status = s.status === 'saving' ? 'saving' : dirty ? 'pending' : 'saved';
    // The last Go live's findings describe the flow as it was then: once it
    // changes they would keep saying "N problems" about steps already fixed,
    // until the next attempt. The next save re-validates at the draft stage;
    // Go live checks the strict one again.
    const activate = s.issueSources.activate;
    const stale = definition !== s.definition && (activate.errors.length > 0 || activate.warnings.length > 0);
    const issueSources = stale ? { ...s.issueSources, activate: NO_ISSUES } : s.issueSources;
    const issues = stale ? mergeIssues(issueSources) : s.issues;
    return {
        definition,
        ...historyFields(history),
        dirty,
        status,
        // Back to what the server holds: a failed save of something else is moot.
        ...(dirty ? {} : { saveError: null }),
        ...(stale ? { issueSources, issues } : {}),
        issuesByStep: issuesByStepFor(issues, definition),
    };
}
