// The plan of a Cowork item as /api/cowork/:id/plan answers it (server/usecases/coworkPlan.mts).
// A plan is an automation held to Cowork's step list; these are the parts the plan card reads.

/** What a step does to the world. */
export type PlanEffect = 'reads' | 'writes' | 'sends';

/** How a person reads a step: done the same way every run, done by a model, waiting for a person, or a result. */
export type PlanStepKind = 'fixed' | 'ai' | 'ask' | 'deliver';

export interface PlanStep {
    id: string;
    type: string;
    kind: PlanStepKind;
    title: string;
    effect: PlanEffect;
    app: string | null;
    tool: string | null;
    /** An AI step whose input was written by someone outside the workspace. */
    readsOutsideText: boolean;
    /** 0 at the top level, 1 inside a loop. */
    depth: number;
}

interface PlanView {
    trigger: string | null;
    steps: PlanStep[];
    makeUp: Record<PlanStepKind, number>;
}

interface PlanGrant {
    app: string;
    effect: PlanEffect;
    tools: string[];
}

export interface PlanPermissions {
    v: 1;
    grants: PlanGrant[];
    /** Who a result or a message can reach. */
    sends: 'none' | 'owner' | 'others';
    ai: boolean;
    outsideText: boolean;
}

/** One reason a plan may not run, as a sentence. */
interface PlanFinding {
    code: string;
    stepId: string | null;
    message: string;
}

/** The plan as its automation holds it now. */
export interface PlanDraft {
    view: PlanView;
    permissions: PlanPermissions;
    findings: PlanFinding[];
    fingerprint: string;
}

interface ApprovedPlan {
    version: number;
    fingerprint: string;
    approvedAt: string | null;
    permissions: PlanPermissions;
}

export interface PlanState {
    /** The automation the plan is made from; null when the item has no plan. */
    automationId: string | null;
    /** Null when no automation is named, or it is gone. */
    draft: PlanDraft | null;
    /** The plan a run executes; null when none was approved. */
    approved: ApprovedPlan | null;
    /** What the draft may do that the approved plan may not. */
    widens: string[];
    /** The draft is exactly the approved plan. */
    upToDate: boolean;
}

/** An automation the caller owns, as the picker lists it. */
export interface PlanAutomation {
    id: string;
    title: string;
}

/** A try-out that was started: its id, and the fingerprint of the plan that is being tried. */
export interface PlanTryStart {
    tryId: string;
    fingerprint: string;
}

/** One plan step of a try-out (server/usecases/coworkPlanTry.mts). */
export interface PlanTryStep {
    id: string;
    title: string;
    kind: PlanStepKind;
    effect: PlanEffect;
    /** 'pending' until the try-out reaches the step, then how it went; 'not_reached' when it ended before the step. */
    status: string;
    /** 0 at the top level, 1 inside a loop: such a step runs once per item. */
    depth: number;
    durationMs: number | null;
    /** The step would change or send something, so the try-out held it back. */
    held: boolean;
    error: string | null;
    /** What the step read, or what a held step would have written or sent. */
    preview: string | null;
}

/** A try-out so far: nothing in it was changed or sent. */
export interface PlanTryState {
    tryId: string;
    status: string;
    done: boolean;
    summary: string | null;
    error: string | null;
    durationMs: number | null;
    steps: PlanTryStep[];
}

/** The steps of one run that followed a plan (server/usecases/coworkRunTrace.mts). */
export interface PlanRunTrace {
    runId: string;
    /** The version of the plan this run followed. */
    planVersion: number;
    /** False: the steps were not recorded or are no longer kept; the plan's steps are listed without how they went. */
    recorded: boolean;
    done: boolean;
    durationMs: number | null;
    steps: PlanTryStep[];
}
