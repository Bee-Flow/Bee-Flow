/**
 * The draft store's edit actions: every change to the definition on screen
 * goes through one of these, so every change is an undo entry and schedules
 * a save — the web's rule that "every local-edit path goes through here, so
 * undos auto-persist to the server too" (BuilderShell.applyVisualDraft).
 */

import { afterEdit, scheduleSave, type DraftContext, type GetDraft, type SetDraft } from './context';
import { issuesByStepFor, mergeIssues, NO_ISSUES } from './issues';
import type { DraftActions } from './types';
import { commitDraft, redoDraft, sameDraft, undoDraft, type HistoryState, type StepResult } from '../model/history';
import { normalizeDefinitionShape } from '../model/normalize';
import type { FlowDefinition } from '../model/types';

type EditActions = Pick<DraftActions, 'hydrate' | 'applyOp' | 'undo' | 'redo' | 'setLocked' | 'setIssues' | 'adoptAutomationId'>;

/** A history whose next commit starts its own entry, whatever the clock says. */
const unCoalesced = (history: HistoryState<FlowDefinition>) => ({ ...history, lastCommitAt: Number.NEGATIVE_INFINITY });

/**
 * A load older than what the store holds: below the last version it saw, or
 * at or below the version an AI draft replaced (that echo predates the draft).
 */
function isStaleLoad(held: number | null, loaded: number | null, ctx: DraftContext): boolean {
    if (loaded === null) return false;
    if (held !== null && loaded < held) return true;
    return ctx.hydrateAbove !== null && loaded <= ctx.hydrateAbove;
}

export function editActions(set: SetDraft, get: GetDraft, ctx: DraftContext): EditActions {
    const step = (move: (h: HistoryState<FlowDefinition>, current: FlowDefinition) => StepResult<FlowDefinition>) => {
        const s = get();
        if (s.locked || !s.definition) return false;
        const { state, apply } = move(s.history, s.definition);
        if (apply === undefined) return false;
        set(afterEdit(get, apply, state));
        scheduleSave(ctx);
        return true;
    };

    return {
        hydrate: (definition, version = null) => {
            const s = get();
            if (s.ready && (s.dirty || isStaleLoad(s.version, version, ctx))) return;
            const nextVersion = version ?? s.version;
            if (s.ready && sameDraft(definition, s.definition)) {
                if (nextVersion !== s.version) set({ version: nextVersion });
                return;
            }
            ctx.epoch += 1;
            set({
                ready: true,
                definition,
                baseline: definition,
                version: nextVersion,
                dirty: false,
                issuesByStep: issuesByStepFor(s.issues, definition),
            });
        },

        applyOp: (op) => {
            const s = get();
            if (s.locked || !s.ready || !s.definition) return null;
            const next = normalizeDefinitionShape(op(s.definition));
            if (!next || next === s.definition) return null;
            const { state, changed } = commitDraft(s.history, s.definition, next, ctx.now());
            if (!changed) return null;
            set(afterEdit(get, next, state));
            scheduleSave(ctx);
            return next;
        },

        undo: () => step(undoDraft),
        redo: () => step(redoDraft),

        setLocked: (locked) => {
            if (locked) ctx.turnEntryOpen = false;
            if (get().locked !== locked) set({ locked });
        },

        setIssues: (source, issues) => {
            const s = get();
            const issueSources = { ...s.issueSources, [source]: issues ?? NO_ISSUES };
            const merged = mergeIssues(issueSources);
            set({ issueSources, issues: merged, issuesByStep: issuesByStepFor(merged, s.definition) });
        },

        adoptAutomationId: (id) => {
            if (id && !get().automationId) set({ automationId: id });
        },
    };
}

/**
 * Swap in a whole definition as ONE undo entry. While the AI builder streams
 * (locked), every draft of the turn folds into the entry its first draft
 * opened, so one Undo takes back the whole turn.
 */
export function replaceAction(set: SetDraft, get: GetDraft, ctx: DraftContext): DraftActions['replaceDefinition'] {
    return (definition, opts = {}) => {
        const s = get();
        const persisted = opts.persisted === true;
        const joinTurn = s.locked && ctx.turnEntryOpen;
        const history = s.definition
            ? commitDraft(joinTurn ? s.history : unCoalesced(s.history), s.definition, definition, joinTurn ? s.history.lastCommitAt : ctx.now()).state
            : s.history;
        if (s.locked) ctx.turnEntryOpen = true;
        if (persisted) {
            ctx.epoch += 1;
            ctx.hydrateAbove = opts.version == null ? s.version : null;
        }
        const baseline = persisted ? definition : s.baseline;
        set({ ready: true, baseline, version: opts.version ?? s.version, ...(persisted ? { saveError: null } : {}) });
        set(afterEdit(get, definition, history));
        if (!get().dirty) ctx.scheduler?.cancel();
        else scheduleSave(ctx);
    };
}
