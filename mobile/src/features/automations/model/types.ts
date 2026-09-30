/**
 * Automation shapes, taken from the server's own row mappers rather than
 * guessed: server/stores/automationStore/rowMappers.js — rowToAutomation /
 * rowToRun / rowToRunStep (the exact camelCase keys below).
 *
 * The other entities of the Automate tab have their own features now: tasks
 * and reminders (features/tasks), projects, Studio apps and approvals. Note
 * the mixed conventions across the product: these answer camelCase, while
 * chat answers snake_case. That is the server's doing, not a transcription
 * error — see server/routes/projects.js next to server/routes/ai/directChat.
 */

/**
 * A run's lifecycle state.
 *
 * Deliberately a widened string union: the runner has grown states over time
 * (`awaiting_form` and `paused_breakpoint` are recent) and a phone that
 * crashes on a state it has not heard of is worse than one that renders it
 * neutrally. `statusToken()` in status.ts degrades unknown values to `idle`,
 * exactly as agent-hub/src/components/shared/statusTokens.ts does.
 */
export type RunStatus =
    | 'queued'
    | 'running'
    | 'success'
    | 'error'
    | 'failed'
    | 'cancelled'
    | 'skipped'
    // A step whose output came from a pin rather than from this run. runDag
    // records it as its own status, not as a skip.
    | 'pinned'
    | 'awaiting_approval'
    | 'awaiting_confirm'
    | 'awaiting_form'
    | 'paused'
    | 'paused_breakpoint'
    | (string & {});

/** `definition.trigger` — see server/automation/summarise.js describeTrigger(). */
export interface AutomationTrigger {
    id?: string;
    kind?: 'manual' | 'schedule' | 'webhook' | 'form' | 'agent_call' | 'app_event' | (string & {});
    schedule?: { cron?: string | null; tz?: string | null } | null;
    appEvent?: { provider?: string; event?: string; filter?: unknown } | null;
    toolName?: string | null;
}

/**
 * One node of the flow. Only the fields a phone reads are declared — the full
 * step schema (bindings, branches, retry policy, pinned outputs) belongs to
 * the flow editor (features/flow-editor/model/types.ts) and is deliberately
 * not modelled here.
 */
export interface AutomationStepDef {
    id: string;
    type?: string;
    label?: string | null;
    tool?: string | null;
    /** `loop` and `condition` carry nested bodies; used only to count nodes. */
    body?: AutomationStepDef[];
    /** A `call_layer` step names its flowlet in the definition's `layers`. */
    layerKey?: string | null;
}

export interface AutomationDefinition {
    trigger?: AutomationTrigger | null;
    /** Extra triggers on a multi-trigger routine (crud.multiTrigger.test.js). */
    triggers?: AutomationTrigger[];
    steps?: AutomationStepDef[];
    edges?: unknown[];
    /** Inline flowlets, by the key a `call_layer` step's `layerKey` names. */
    layers?: Record<string, AutomationDefinition>;
    [key: string]: unknown;
}

export interface Automation {
    id: string;
    userId: string;
    organizationId?: string | null;
    projectId: string | null;
    folderId: string | null;
    /** 'automation' | 'layer' | 'block' — a Step (block) is a reusable fragment. */
    kind: string;
    title: string;
    description: string | null;
    definition: AutomationDefinition;
    version: number;
    isActive: boolean;
    isDraft: boolean;
    needsFirstRunConfirm: boolean;
    triggerType: string;
    scheduleCron: string | null;
    scheduleTz: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastStatus: RunStatus | null;
    /** Non-null while a pod holds the lock — the row is executing right now. */
    runningInstanceId: string | null;
    runningStartedAt: string | null;
    icon?: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    // Handoff 5, the live split (rowMappers.js liveFields): once a routine has
    // gone live, a save changes only its working copy and runs keep executing
    // the live version until POST /:id/publish. A server from before the
    // split sends none of these, so each stays absent (undefined) there;
    // `liveVersion: null` is a server WITH the split and a routine never live.
    /** The version runs execute; null while never live. */
    liveVersion?: number | null;
    /** When that version went live. */
    liveAt?: string | null;
    /** True while there is no live version. */
    neverLive?: boolean;
    /**
     * Structural versions saved since the live one (0 while never live).
     * Absent from a save's answer too: the server leaves it out rather than
     * guess, and GET /:id/counts has it.
     */
    pendingChanges?: number;
}

export interface AutomationRun {
    id: string;
    automationId: string;
    version: number;
    userId: string;
    triggerKind: string | null;
    triggerPayload: unknown;
    /** 'live' | 'dry_run'. A dry run keeps its status word AND this flag. */
    mode: string | null;
    status: RunStatus;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
    summary: string | null;
    parentRunId: string | null;
    /** The journey this leg belongs to; equals `id` for a run that never paused. */
    rootRunId: string;
    cancelRequested: boolean;
    awaitingStepId: string | null;
    awaitingStepExpiresAt: string | null;
    errorClass: string | null;
    /** Failures absorbed by an on_error branch. The run still says 'success'. */
    handledErrorCount: number;
    /**
     * Present only on GET /runs/:id, when the journey continued into a later
     * leg — the row you opened reports THAT leg's outcome (webhooksAndRunOps.js).
     */
    journeyRunId?: string;
}

export interface AutomationRunStep {
    runId: string;
    stepId: string;
    parentStepId: string | null;
    stepType: string | null;
    attempts: number | null;
    status: RunStatus;
    startedAt: string | null;
    finishedAt: string | null;
    input: unknown;
    output: unknown;
    error: string | null;
    errorClass: string | null;
    branchIndex: number | null;
    /** Derived server-side for legacy Nextcloud rows only. */
    errorRemediation?: string;
}

/** GET /api/automation/_runs/active. */
export interface ActiveRun {
    runId: string;
    automationId: string;
    status: RunStatus;
    startedAt: string | null;
    triggerKind: string | null;
}

/**
 * A frame from GET /api/automation/_runs/stream. The route writes bare
 * `data:` lines with no `event:` field, so every frame arrives as `message`
 * and the discriminator is this `type` (server/core/runEventBus.js).
 */
export interface RunEvent {
    type:
        | 'run.started'
        | 'run.finished'
        | 'run.failed'
        | 'step.started'
        | 'step.finished'
        | 'step.heartbeat'
        | (string & {});
    at?: string;
    runId?: string;
    automationId?: string;
    stepId?: string;
    stepType?: string;
    status?: RunStatus;
    triggerKind?: string;
    durationMs?: number;
    errorClass?: string;
    error?: string;
    userId?: string;
}

/** POST /api/automation/:id/run — three different 200/202 bodies. */
export interface RunTriggerResult {
    accepted?: boolean;
    /** 202: the run outlived the 60s sync wait and is still going. */
    pending?: boolean;
    /** 200: a Gmail/Nextcloud trigger with nothing to test against. */
    skipped?: boolean;
    message?: string;
    run?: AutomationRun;
    steps?: AutomationRunStep[];
}

/** POST /api/automation/_schedule/preview. */
export type SchedulePreview =
    | { valid: true; cron: string; tz: string; next: string[] }
    | { valid: false; error?: string };

// ── Lifecycle: create, delete, "used by" ────────────────────────────

/**
 * One finding of the server's flow validator (server/automation/validate):
 * `{code, severity, path, message, hint}`, plus `blockedAt: 'activate'` on a
 * completeness check that a DRAFT save reports as a warning. A few checks
 * outside the validator (approval assignees, the import envelope) omit the
 * code and the severity, or send a bare sentence; the reader fills in what
 * the call site knows.
 */
export type AutomationIssue = {
    code?: string;
    severity: 'error' | 'warning';
    path?: string;
    message: string;
    hint?: string;
    blockedAt?: string;
};

/** POST /api/automation — CreateAutomationBody in routes/automation/crud.js (strict). */
export type CreateAutomationBody = {
    title: string;
    description?: string | null;
    definition: Record<string, unknown>;
    triggerType?: string;
    scheduleCron?: string | null;
    scheduleTz?: string;
    createdFromChatId?: string | null;
};

/** What a create (or an import) answers: the row, and non-blocking findings. */
export interface CreateAutomationResult {
    automation: Automation | null;
    warnings: AutomationIssue[];
}

/**
 * PUT /api/automation/:id — UpdateAutomationBody in routes/automation/crud.js
 * (strict: any other key is a 400). `folderId: null` moves a routine back to
 * the top level.
 */
export interface AutomationPatch {
    title?: string;
    description?: string | null;
    /** Any definition shape: this feature's loose one, or the flow editor's strict one. */
    definition?: Record<string, unknown>;
    isDraft?: boolean;
    triggerType?: string;
    scheduleCron?: string | null;
    scheduleTz?: string | null;
    folderId?: string | null;
}

/**
 * PUT and activate: the row, the findings that did not block and what a
 * form's answers table did (automation/formAnswers — carried, not read here).
 */
export interface AutomationSaveResult extends CreateAutomationResult {
    answers: Record<string, unknown> | null;
}

/** GET /api/automation/:id/counts, the part the phone reads. A figure the server did not send is null, never 0. */
export interface AutomationCounts {
    pendingChanges: number | null;
}

/**
 * One app button that starts this routine (automationUsageStore.mapRow plus
 * the route's `canOpen`). `canOpen` is the server's answer to "may this viewer
 * open the app's editor" — never derived here.
 */
export interface AutomationUsageRow {
    automationId: string;
    consumerKind: string;
    consumerId: string;
    consumerTitle: string | null;
    refId: string | null;
    actionId: string | null;
    screenId: string | null;
    nodeId: string | null;
    label: string | null;
    wired: boolean;
    updatedAt: string | null;
    canOpen: boolean;
}

/**
 * GET /api/automation/:id/usage. `complete: false` means the index has not
 * seen every app yet, so an empty list may NOT be read as "used nowhere".
 */
export interface AutomationUsage {
    usage: AutomationUsageRow[];
    complete: boolean;
}
