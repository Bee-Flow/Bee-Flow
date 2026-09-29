/**
 * Shapes for everything under the Automate tab, taken from the server's own
 * row mappers rather than guessed:
 *
 *   server/stores/automationStore/rowMappers.js  — rowToAutomation / rowToRun /
 *                                                  rowToRunStep (the exact
 *                                                  camelCase keys below)
 *   server/stores/aiTaskStore.js      rowToTask()
 *   server/stores/reminderStore.js    getReminders()
 *   server/stores/projectStore.js     listUserProjects() / getProject()
 *   server/stores/studioAppStore.js   mapAppMetaRow() / mapAppRow()
 *
 * Note the mixed conventions across the product: automations, tasks, reminders
 * and projects answer camelCase, while chat answers snake_case. That is the
 * server's doing, not a transcription error — see server/routes/projects.js
 * next to server/routes/ai/directChat.
 */

/**
 * A run's lifecycle state.
 *
 * Deliberately a widened string union: the runner has grown states over time
 * (`awaiting_form` and `paused_breakpoint` are recent) and a phone that
 * crashes on a state it has not heard of is worse than one that renders it
 * neutrally. `statusToken()` in format.ts degrades unknown values to `idle`,
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
 * the desktop canvas and is deliberately not modelled here.
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

// ── AI tasks (routines) ─────────────────────────────────────────────

/** The intervals routes/aiTasks.js accepts. `null` is a one-off. */
export const REPEAT_INTERVALS = [
    'hourly',
    'daily',
    'weekdays',
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'yearly',
] as const;
export type RepeatInterval = (typeof REPEAT_INTERVALS)[number];

export interface AiTask {
    id: string;
    userId: string;
    title: string;
    prompt: string;
    repeatInterval: RepeatInterval | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastResult: string | null;
    lastStatus: string | null;
    isActive: boolean;
    modelTier: string | null;
    runCount: number | null;
    timezone: string | null;
    createdAt: string | null;
    agentId: string | null;
    conversationId: string | null;
    daysOfWeek: string[] | null;
    timeOfDay: string | null;
    /** Joined in by routes/aiTasks.js for agent-scoped routines only. */
    agentName?: string;
    agentAvatar?: string;
}

export interface AiTaskList {
    tasks: AiTask[];
    /** Admin-configurable cap; the create button has to respect it. */
    maxTasks: number;
}

export interface Reminder {
    id: string;
    userId: string;
    title: string;
    message: string | null;
    remindAt: string | null;
    repeatInterval: string | null;
    isCompleted: boolean;
    createdAt: string | null;
}

// ── Projects ────────────────────────────────────────────────────────

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface Project {
    id: string;
    name: string;
    description: string | null;
    customInstructions: string | null;
    knowledgeBaseIds: string[];
    color: string | null;
    icon: string | null;
    ownerId: string;
    organizationId: string | null;
    extractMemories?: boolean;
    version: number;
    /** Only on the LIST response; the detail response calls it `role`. */
    permission?: ProjectRole;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface ProjectShare {
    id: string;
    projectId: string;
    sharedWithType: 'user' | 'group' | (string & {});
    sharedWithId: string;
    permission: ProjectRole;
    createdAt: string | null;
}

export interface ProjectDetail extends Project {
    shares: ProjectShare[];
    role: ProjectRole;
}

export interface ProjectMembers {
    ownerId: string;
    members: ProjectShare[];
}

export interface ProjectThread {
    id: string;
    /** 'direct' opens in the chat screen; 'agent' has no mobile screen yet. */
    type: 'direct' | 'agent' | (string & {});
    ownerId: string;
    projectId: string;
    title: string | null;
    updatedAt: string | null;
    createdAt: string | null;
}

/**
 * GET /api/projects/:id/resources. Each section is `null` when its store was
 * unavailable — deliberately distinct from `[]` ("none filed"), so the screen
 * can say "could not load" instead of lying that a project is empty.
 * Section names come from server/projects/membership.js.
 */
export interface ProjectResources {
    role: ProjectRole;
    notebooks: unknown[] | null;
    automations: Automation[] | null;
    apps: StudioAppMeta[] | null;
    webpages: unknown[] | null;
    approvals: unknown[] | null;
}

// ── Studio apps ─────────────────────────────────────────────────────

export interface StudioAppMeta {
    id: string;
    userId: string;
    organizationId: string | null;
    projectId: string | null;
    name: string;
    description: string;
    icon: string | null;
    accentColor: string | null;
    definitionVersion: number;
    publishedVersion: number | null;
    isPublished: boolean;
    publishedAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * One node of an app definition. The full schema is a 40-type component tree
 * (server/appStudio/componentSpecs.js); this declares the shape every node
 * shares plus the props the mobile renderer actually reads. Everything else
 * stays `unknown` rather than being half-modelled.
 */
export interface AppNode {
    id: string;
    type: string;
    props?: Record<string, unknown>;
    style?: Record<string, unknown>;
    children?: AppNode[];
    /** Action ids — the keys of `definition.actions`. */
    onSubmit?: string | null;
    onClick?: string | null;
    visible?: boolean;
    /**
     * Role keys allowed to see this node. Absent or empty means everyone —
     * mirroring roleAllows() in server/routes/studioAppRunGate.js.
     */
    visibleToRoles?: string[] | null;
    /** Formula gates. The phone does not evaluate these; see appDefinition.ts. */
    visibleWhen?: unknown;
    enabledWhen?: unknown;
}

export interface AppSection {
    id: string;
    style?: Record<string, unknown>;
    children?: AppNode[];
}

export interface AppScreen {
    id: string;
    name?: string;
    icon?: string | null;
    showInNav?: boolean;
    sections?: AppSection[];
}

export interface AppAction {
    /** Only `run_automation` is runnable from the phone — see api.ts. */
    kind: string;
    automationId?: string | null;
    inputMapping?: Record<string, unknown>;
    steps?: unknown[];
    message?: string;
    url?: string;
    screenId?: string;
}

export interface AppDefinition {
    schemaVersion?: number;
    meta?: { name?: string; description?: string; icon?: string };
    theme?: Record<string, unknown>;
    homeScreenId?: string;
    screens?: AppScreen[];
    actions?: Record<string, AppAction>;
}

/** GET /api/studio-apps/:id/runtime. */
export interface StudioAppRuntime {
    id: string;
    name: string;
    icon: string | null;
    accentColor: string | null;
    definition: AppDefinition;
    viewer: { id?: string; name?: string; email?: string; isOwner?: boolean; roleKey?: string | null };
    appVersion: number | null;
    draft?: boolean;
}

/** POST /api/studio-apps/:id/actions/:actionId/run, and its poll response. */
export interface AppActionResult {
    runId?: string | null;
    status?: RunStatus | 'pending' | 'skipped';
    output?: unknown;
    error?: string | null;
    message?: string;
    approvalId?: string;
}

/** A form's collected values. The server only forwards primitives. */
export type AppFormValues = Record<string, string | number | boolean | null>;

/**
 * One decision waiting on a person.
 *
 * A paused automation (`source: 'run'`, where approving resumes the run) or an
 * App Studio request (`source: 'app'`, where the decision IS the outcome and
 * there is no run behind it). The distinction matters on a phone: the first
 * has somewhere to go afterwards and the second does not.
 *
 * Shape from server/stores/automationStore/approvals.js `rowToApproval`,
 * narrowed to what a phone actually renders — the panel/stage machinery is
 * summarised by the server into `canDecide`, so the client never has to
 * reimplement quorum rules it could get wrong.
 */
export interface Approval {
    id: string;
    automationId: string | null;
    automationTitle: string;
    projectTitle: string;
    runId: string | null;
    stepId: string | null;
    source: 'run' | 'app' | string;
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | string;
    prompt: string;
    detailsMd: string | null;
    context: Record<string, unknown> | null;
    decidedByName: string | null;
    decisionReason: string | null;
    decidedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
}

export interface ApprovalDetail {
    approval: Approval;
    /**
     * Whether this viewer can act RIGHT NOW — not merely whether they hold a
     * seat. The server resolves stages, quorum and votes-already-cast into
     * this one boolean precisely so a client cannot get it wrong.
     */
    canDecide: boolean;
    canWithdraw: boolean;
}
