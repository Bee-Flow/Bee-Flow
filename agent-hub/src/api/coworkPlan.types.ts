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
    description?: string | null;
    scriptNumber?: number;
    inputNames?: string[];
    effect: PlanEffect;
    app: string | null;
    tool: string | null;
    /** An AI step whose input was written by someone outside the workspace. */
    readsOutsideText: boolean;
    /** 0 at the top level, 1 inside a loop. */
    depth: number;
    /** It only reshapes or guards data between the steps that do the work; absent from an older server. */
    helper?: boolean;
}

interface PlanView {
    trigger: string | null;
    steps: PlanStep[];
    /** The ids of `steps` in the order they run (server core/cowork/plan/planOrder.mts); absent from an older server. */
    runOrder?: string[];
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
export interface PlanParameter { stepId: string; field: 'query' | 'folder' | 'path' | 'subject' | 'to'; value: string }
export interface PlanDraft {
    parameters?: PlanParameter[];
    view: PlanView;
    permissions: PlanPermissions;
    findings: PlanFinding[];
    fingerprint: string;
    /**
     * Who each step that sends reaches, by step id: 'owner', the addresses the plan fixes (joined by a comma), or '*'
     * when it picks them from data (server core/cowork/planTrust.mts sendsToOf); absent from an older server.
     */
    recipients?: Record<string, string>;
}

/** What the last test of a plan produced (server usecases/coworkPlanTryResult.mts): what its owner would have received. */
interface PlanTriedResult {
    effects?: Array<Pick<PlanTryStep, 'id' | 'title' | 'effect' | 'preview'>>;
    stepId: string;
    title: string | null;
    text: string;
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
    /** The steps that are new, gone or changed against the approved plan (server core/cowork/plan/planChanges.mts); absent from an older server. */
    stepChanges?: PlanStepChange[];
    /** The last try-out of the plan (server usecases/coworkPlan.mts PlanTried); null or absent when none is known. */
    tried?: PlanTried | null;
    /** Not approved, it cannot run because of its wiring, and Cowork can fix that by itself (POST …/plan/fix-wiring). */
    wiringFixable?: boolean;
    /** Only from GET …/plan, while a tested plan waits for its approval: what that test produced; else null or absent. */
    triedResult?: PlanTriedResult | null;
}

/** One change Cowork made to the wiring, in the plan's titles. */
export interface PlanWiringNote {
    kind: 'waits' | 'reads';
    step: string;
    other: string;
}

/** What a try-out read and did, in counts (server core/cowork/plan/planTryFacts.mts). */
export interface PlanTrySummary {
    reads: Array<{ title: string; items: number | null }>;
    ai: number;
    held: number;
}

/** The last try-out of a plan, as the card shows it. */
export interface PlanTried {
    status: 'running' | 'passed' | 'failed' | 'untried';
    /** It tried exactly the plan on screen. */
    current: boolean;
    /** Cowork made the plan: a passing try-out of it comes before Approve. */
    required: boolean;
    /** Approve waits for a try-out that passes. */
    blocksApproval: boolean;
    summary: PlanTrySummary | null;
    /** Why it did not pass, in sentences. */
    problems: string[];
    rounds: number;
    /** What Cowork fixed in the wiring of exactly this plan before it tried it; absent from an older server. */
    wiringFixed?: PlanWiringNote[];
}

/** What Cowork's own fix of the wiring did (server usecases/coworkPlanWiringRepair.mts fixDraftWiring). */
export interface PlanWiringFix {
    outcome: 'fixed' | 'tried';
    changes: Array<{ kind: 'waits' | 'reads'; stepId: string; otherId: string }>;
    /** How its try-out stands: 'running' while it goes on by itself. */
    tried: PlanTried['status'] | null;
    notTried: string | null;
    state: PlanState;
}

/** One step of the draft against the approved plan. */
export interface PlanStepChange {
    id: string;
    title: string;
    kind: PlanStepKind;
    change: 'added' | 'changed' | 'removed';
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
    type?: string;
    app?: string;
    description?: string | null;
    scriptNumber?: number;
    inputNames?: string[];
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

/** What the planner says while it drafts a plan (server/usecases/coworkPlanner.mts). */
export type PlanMakeProgress =
    | { phase: 'thinking'; round: number }
    | { phase: 'drafted'; round: number; steps: Array<Pick<PlanStep, 'id' | 'title' | 'kind'>> }
    | { phase: 'saving' }
    | { phase: 'trying'; round: number }
    | { phase: 'repairing'; round: number };

/** How making a plan ended: the plan as its owner now sees it with what the planner said about it, or a sentence. */
export interface PlanMakeOutcome {
    state: PlanState | null;
    summary: string;
    error: string | null;
}
