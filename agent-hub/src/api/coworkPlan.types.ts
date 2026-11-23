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
