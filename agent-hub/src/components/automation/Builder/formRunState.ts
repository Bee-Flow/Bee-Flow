import type { FormDef } from '../../forms/PublicFormRenderer.types';
import type { FormRunKind, FormRunMode } from './formRunContract';
import type { PendingApproval } from './formRunApi';
import type { FollowView } from './formRunFollower';

/**
 * The form test overlay as a state machine (FormRunOverlay):
 *
 *   form      a page is on screen: page one of the declaration, or the page a
 *             run parked on (page.stepId set)
 *   working   the run goes; the overlay reads it every second
 *   approval  the journey waits on a decision: decide here, or wait for it
 *   done | failed | stopped   it ended (success / error / cancelled)
 *   slow      still going after the follow budget, or no longer readable here
 *
 * `prompt` is a question laid over the phase without unmounting it, so typed
 * answers survive "Keep editing": 'answers' (a backdrop click on a typed
 * page) or 'parked' (closing a run that waits on a page or a decision).
 */

type OverlayPhase = 'form' | 'working' | 'approval' | 'done' | 'failed' | 'stopped' | 'slow';
type OverlayPrompt = 'answers' | 'parked' | null;

export interface OverlayState {
    phase: OverlayPhase;
    page: { form: FormDef | null; stepId: string | null };
    /** The run being followed (the journey's newest leg the overlay knows). */
    runId: string | null;
    /** Every run of this journey the overlay saw, oldest first: [0] is the head. */
    runIds: string[];
    approval: PendingApproval | null;
    ending: FormDef | null;
    /** Pages answered in this overlay, page one included. */
    answered: number;
    /** What the chip says; null until known. */
    runKind: FormRunKind | null;
    slow: 'budget' | 'unreadable' | null;
    prompt: OverlayPrompt;
}

export type OverlayAction =
    /** A run started (page one) or continued (a later page, a decision). */
    | { type: 'submitted'; runId: string; mode?: FormRunMode; answeredPage: boolean }
    | { type: 'view'; view: FollowView }
    | { type: 'prompt'; prompt: OverlayPrompt }
    /** "Check again" from the slow state. */
    | { type: 'retry' };

export function initialOverlayState({ form, attachRunId, runKind, startMode }: {
    form?: FormDef | null; attachRunId?: string | null; runKind?: FormRunKind | null; startMode: FormRunMode;
}): OverlayState {
    const attached = !form && !!attachRunId;
    return {
        phase: attached ? 'working' : 'form',
        page: { form: form || null, stepId: null },
        runId: attached ? attachRunId : null,
        runIds: attached ? [attachRunId] : [],
        approval: null,
        ending: null,
        answered: 0,
        runKind: attached ? (runKind ?? null) : (runKind ?? startMode),
        slow: null,
        prompt: null,
    };
}

const withRun = (ids: string[], id: string) => (ids.includes(id) ? ids : [...ids, id]);

function applyView(s: OverlayState, view: FollowView): OverlayState {
    if (view.kind === 'run_kind') return { ...s, runKind: view.runKind };
    const base = { ...s, runId: view.runId, runIds: withRun(s.runIds, view.runId) };
    switch (view.kind) {
        case 'form': return { ...base, phase: 'form', page: { form: view.form, stepId: view.stepId }, approval: null };
        case 'approval': return { ...base, phase: 'approval', approval: view.approval };
        case 'slow': return { ...base, phase: 'slow', slow: view.reason };
        default: return { ...base, phase: view.kind, ending: view.ending, approval: null, prompt: null };
    }
}

export function overlayReducer(s: OverlayState, a: OverlayAction): OverlayState {
    switch (a.type) {
        case 'submitted': return {
            ...s,
            phase: 'working',
            runId: a.runId,
            runIds: withRun(s.runIds, a.runId),
            runKind: a.mode ?? s.runKind,
            answered: s.answered + (a.answeredPage ? 1 : 0),
            approval: null,
            slow: null,
            prompt: null,
        };
        case 'view': return applyView(s, a.view);
        case 'prompt': return { ...s, prompt: a.prompt };
        case 'retry': return { ...s, phase: 'working', slow: null };
        default: return s;
    }
}

/** The run waits for this person (a page) or for a decision: closing asks what to do with it. */
export function isParked(s: OverlayState): boolean {
    return (s.phase === 'form' && !!s.page.stepId) || s.phase === 'approval';
}

/** Closing now should stop the shell from opening the overlay again for these runs. */
export function stillGoing(s: OverlayState): boolean {
    return s.phase === 'working' || s.phase === 'slow';
}
