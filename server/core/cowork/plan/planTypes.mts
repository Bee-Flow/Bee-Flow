/**
 * The vocabulary of a Cowork plan.
 *
 * A plan is an automation definition (`{ trigger, steps, edges }`, the grammar of core/automationModel) held to
 * Cowork's short step list (./coworkStepList.mts). Nothing here adds a second grammar: these types name the parts of
 * a definition the plan modules read, and what they derive from it.
 */

/** What a step does to the world, in the engine's own words (core/automationModel/sideEffectMap.js). */
export type Effect = 'reads' | 'writes' | 'sends';

/** How a person reads a step: done the same way every run, done by a model, waiting for a person, or a result. */
export type StepKind = 'fixed' | 'ai' | 'ask' | 'deliver';

/** A step of a definition, as far as the plan modules read it. */
export interface DefStep {
    id?: unknown;
    type?: unknown;
    label?: unknown;
    tool?: unknown;
    inputs?: unknown;
    tools?: unknown;
    allowTools?: unknown;
    agentId?: unknown;
    op?: unknown;
    datatableId?: unknown;
    channels?: unknown;
    body?: unknown;
    branches?: unknown;
    [key: string]: unknown;
}

export interface Definition {
    trigger?: { kind?: unknown; appEvent?: { provider?: unknown; event?: unknown } | null; [key: string]: unknown } | null;
    steps?: unknown;
    edges?: unknown;
    layers?: unknown;
    [key: string]: unknown;
}

/**
 * What the plan modules need to know about a tool name. Handed in, so the modules stay pure; ./planLookups.mts gives
 * the real ones (the tool registry, the side-effect map, the open-web list).
 */
export interface ToolLookups {
    /** The app a tool belongs to, or null for a built-in tool no app owns. */
    appOfTool(tool: string): string | null;
    /** Fail-closed: a name nobody classified writes. */
    effectOfTool(tool: string): Effect;
    /** Does this tool read an address or a query on the open web? */
    isOpenWebRead(tool: string): boolean;
    /** What a person calls this tool ("Fireflies: list transcripts"), or null when nobody named it. */
    labelOfTool?(tool: string): string | null;
}

/** One step as a person reads it. */
export interface PlanStep {
    id: string;
    /** The definition's step type behind it. */
    type: string;
    kind: StepKind;
    title: string;
    effect: Effect;
    app: string | null;
    tool: string | null;
    /** An AI step whose input was written by someone outside the workspace. */
    readsOutsideText: boolean;
    /** 0 at the top level, 1 inside a loop, and so on. */
    depth: number;
}

export interface PlanView {
    /** What starts the plan: 'schedule', 'manual', 'app_event'; null when the definition names none. */
    trigger: string | null;
    steps: PlanStep[];
    /** How many steps of each kind: the "5 fixed, 2 AI, 1 waits for you" line. */
    makeUp: Record<StepKind, number>;
}

/** What a plan may do with one app. */
export interface Grant {
    app: string;
    effect: Effect;
    /** The tool names behind it, sorted. */
    tools: string[];
}

/** Everything a plan may do, derived from the plan and nothing else. */
export interface PlanPermissions {
    v: 1;
    grants: Grant[];
    /** Who a result or a message can reach: nobody, only the owner, or other people. */
    sends: 'none' | 'owner' | 'others';
    /** Does any step call a model? */
    ai: boolean;
    /** Does any step read text written outside the workspace? */
    outsideText: boolean;
}

/** One reason a definition is not a plan Cowork runs. */
export interface PlanFinding {
    code: string;
    stepId: string | null;
    message: string;
}
