/**
 * Every endpoint the Automate tab talks to.
 *
 * Paths are the FULL client-visible ones. The routers read as if mounted at
 * the root, so the prefixes come from server/index.js and are the easiest
 * thing in this codebase to get wrong:
 *
 *   /api/automation   → routes/automation.js  (+ routes/automation/*)
 *   /api/ai-tasks     → routes/aiTasks.js
 *   /api/reminders    → routes/reminders.js
 *   /api/projects     → routes/projects.js
 *   /api/studio-apps  → routes/studioApps.js + routes/studioAppsRun.js
 *
 * Three of these are licence-gated at the mount point, which is why a 402/403
 * from them is a normal answer and every screen renders it as one:
 *   automations → requireModule('automation') + requireLicenseFeature('automations')
 *                 AND, inside the router, requireBetaFeature('automations')
 *   projects    → requireModule('projects') + requireCapability('projects')
 *   studio apps → requireModule('apps') + requireCapability('app_studio')
 *
 * Every payload is read through the allow-list in src/api/contract.ts: the
 * server's JSON arrives as `unknown` and leaves as the declared type, with a
 * missing or mistyped field degraded to a stated default. Blobs the phone only
 * carries (trigger payloads, step input/output, flow definitions, component
 * trees) pass through as they are.
 */

import type {
    ActiveRun,
    AiTask,
    Approval,
    ApprovalDetail,
    AiTaskList,
    AppActionResult,
    AppDefinition,
    AppFormValues,
    Automation,
    AutomationDefinition,
    AutomationRun,
    AutomationRunStep,
    Project,
    ProjectDetail,
    ProjectMembers,
    ProjectResources,
    ProjectRole,
    ProjectShare,
    ProjectThread,
    Reminder,
    RepeatInterval,
    RunTriggerResult,
    SchedulePreview,
    StudioAppMeta,
    StudioAppRuntime,
} from './types';
import { REPEAT_INTERVALS } from './types';
import { api } from '../../api/client';
import { field, nullable, pick, shapeListOf, shapeOf } from '../../api/contract';
import { translate } from '../../i18n';


export const automateKeys = {
    automations: ['automate', 'automations'] as const,
    automation: (id: string) => ['automate', 'automation', id] as const,
    approval: (id: string) => ['automate', 'approval', id] as const,
    approvals: (status: string) => ['automate', 'approvals', status] as const,
    runs: (automationId: string) => ['automate', 'runs', automationId] as const,
    recentRuns: ['automate', 'runs', 'recent'] as const,
    activeRuns: ['automate', 'runs', 'active'] as const,
    run: (runId: string) => ['automate', 'run', runId] as const,
    runSteps: (runId: string) => ['automate', 'run', runId, 'steps'] as const,
    tasks: ['automate', 'tasks'] as const,
    reminders: ['automate', 'reminders'] as const,
    projects: ['automate', 'projects'] as const,
    project: (id: string) => ['automate', 'project', id] as const,
    projectMembers: (id: string) => ['automate', 'project', id, 'members'] as const,
    projectResources: (id: string) => ['automate', 'project', id, 'resources'] as const,
    projectThreads: (id: string) => ['automate', 'project', id, 'threads'] as const,
    apps: ['automate', 'apps'] as const,
    appRuntime: (id: string) => ['automate', 'app', id, 'runtime'] as const,
};

// ── Readers ─────────────────────────────────────────────────────────
// One spec per row mapper the server has (see types.ts for the sources).
// `RunStatus` is a widened string union, so any string reads as a status;
// statusToken() in format.ts degrades the unknown ones to `idle`.

const PROJECT_ROLES: readonly ProjectRole[] = ['owner', 'editor', 'viewer'];

const readAutomation: (raw: unknown) => Automation = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    organizationId: field.strOrNull,
    projectId: field.strOrNull,
    folderId: field.strOrNull,
    kind: field.str('automation'),
    title: field.str('Untitled automation'),
    description: field.strOrNull,
    definition: field.record<AutomationDefinition>({}),
    version: field.num(0),
    isActive: field.bool(false),
    isDraft: field.bool(false),
    needsFirstRunConfirm: field.bool(false),
    triggerType: field.str('manual'),
    scheduleCron: field.strOrNull,
    scheduleTz: field.strOrNull,
    nextRunAt: field.strOrNull,
    lastRunAt: field.strOrNull,
    lastStatus: field.strOrNull,
    runningInstanceId: field.strOrNull,
    runningStartedAt: field.strOrNull,
    icon: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

const readRun: (raw: unknown) => AutomationRun = shapeOf({
    id: field.str(''),
    automationId: field.str(''),
    version: field.num(0),
    userId: field.str(''),
    triggerKind: field.strOrNull,
    triggerPayload: field.raw,
    mode: field.strOrNull,
    status: field.str('queued'),
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    durationMs: field.numOrNull,
    error: field.strOrNull,
    summary: field.strOrNull,
    parentRunId: field.strOrNull,
    rootRunId: field.str(''),
    cancelRequested: field.bool(false),
    awaitingStepId: field.strOrNull,
    awaitingStepExpiresAt: field.strOrNull,
    errorClass: field.strOrNull,
    handledErrorCount: field.num(0),
    journeyRunId: field.optStr,
});

const readRunStep: (raw: unknown) => AutomationRunStep = shapeOf({
    runId: field.str(''),
    stepId: field.str(''),
    parentStepId: field.strOrNull,
    stepType: field.strOrNull,
    attempts: field.numOrNull,
    status: field.str('queued'),
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    input: field.raw,
    output: field.raw,
    error: field.strOrNull,
    errorClass: field.strOrNull,
    branchIndex: field.numOrNull,
    errorRemediation: field.optStr,
});

const readActiveRunRows: (raw: unknown) => ActiveRun[] = shapeListOf({
    runId: field.str(''),
    automationId: field.str(''),
    status: field.str('running'),
    startedAt: field.strOrNull,
    triggerKind: field.strOrNull,
});

const readRunTriggerResult: (raw: unknown) => RunTriggerResult = shapeOf({
    accepted: field.optBool,
    pending: field.optBool,
    skipped: field.optBool,
    message: field.optStr,
    run: (value: unknown) => nullable(readRun)(value) ?? undefined,
    steps: field.optList(readRunStep),
});

function readSchedulePreview(raw: unknown): SchedulePreview {
    if (pick(raw, 'valid') === true) {
        return {
            valid: true,
            cron: field.str('')(pick(raw, 'cron')),
            tz: field.str('')(pick(raw, 'tz')),
            next: field.strArray(pick(raw, 'next')),
        };
    }
    return { valid: false, error: field.optStr(pick(raw, 'error')) };
}

const readTask: (raw: unknown) => AiTask = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    title: field.str('Untitled task'),
    prompt: field.str(''),
    repeatInterval: field.oneOfOrNull<RepeatInterval>(REPEAT_INTERVALS),
    nextRunAt: field.strOrNull,
    lastRunAt: field.strOrNull,
    lastResult: field.strOrNull,
    lastStatus: field.strOrNull,
    isActive: field.bool(false),
    modelTier: field.strOrNull,
    runCount: field.numOrNull,
    timezone: field.strOrNull,
    createdAt: field.strOrNull,
    agentId: field.strOrNull,
    conversationId: field.strOrNull,
    daysOfWeek: field.strArrayOrNull,
    timeOfDay: field.strOrNull,
    agentName: field.optStr,
    agentAvatar: field.optStr,
});

const reminderSpec = {
    id: field.str(''),
    userId: field.str(''),
    title: field.str('Reminder'),
    message: field.strOrNull,
    remindAt: field.strOrNull,
    repeatInterval: field.strOrNull,
    isCompleted: field.bool(false),
    createdAt: field.strOrNull,
};
const readReminder: (raw: unknown) => Reminder = shapeOf(reminderSpec);
const readReminderRows: (raw: unknown) => Reminder[] = shapeListOf(reminderSpec);

const projectSpec = {
    id: field.str(''),
    name: field.str('Untitled project'),
    description: field.strOrNull,
    customInstructions: field.strOrNull,
    knowledgeBaseIds: field.strArray,
    color: field.strOrNull,
    icon: field.strOrNull,
    ownerId: field.str(''),
    organizationId: field.strOrNull,
    extractMemories: field.optBool,
    version: field.num(0),
    permission: field.optOneOf(PROJECT_ROLES),
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
};
const readProjectRows: (raw: unknown) => Project[] = shapeListOf(projectSpec);

const readShare: (raw: unknown) => ProjectShare = shapeOf({
    id: field.str(''),
    projectId: field.str(''),
    sharedWithType: field.str('user'),
    sharedWithId: field.str(''),
    permission: field.oneOf(PROJECT_ROLES, 'viewer'),
    createdAt: field.strOrNull,
});

const readProjectDetail: (raw: unknown) => ProjectDetail = shapeOf({
    ...projectSpec,
    shares: field.list(readShare),
    role: field.oneOf(PROJECT_ROLES, 'viewer'),
});

const readProjectMembers: (raw: unknown) => ProjectMembers = shapeOf({
    ownerId: field.str(''),
    members: field.list(readShare),
});

const readThreadRows: (raw: unknown) => ProjectThread[] = shapeListOf({
    id: field.str(''),
    type: field.str('direct'),
    ownerId: field.str(''),
    projectId: field.str(''),
    title: field.strOrNull,
    updatedAt: field.strOrNull,
    createdAt: field.strOrNull,
});

const readStudioApp: (raw: unknown) => StudioAppMeta = shapeOf({
    id: field.str(''),
    userId: field.str(''),
    organizationId: field.strOrNull,
    projectId: field.strOrNull,
    name: field.str('Untitled app'),
    description: field.str(''),
    icon: field.strOrNull,
    accentColor: field.strOrNull,
    definitionVersion: field.num(0),
    publishedVersion: field.numOrNull,
    isPublished: field.bool(false),
    publishedAt: field.strOrNull,
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
});

const readProjectResources: (raw: unknown) => ProjectResources = shapeOf({
    role: field.oneOf(PROJECT_ROLES, 'viewer'),
    notebooks: field.arrayOrNull,
    automations: field.listOrNull(readAutomation),
    apps: field.listOrNull(readStudioApp),
    webpages: field.arrayOrNull,
    approvals: field.arrayOrNull,
});

const readAppRuntime: (raw: unknown) => StudioAppRuntime = shapeOf({
    id: field.str(''),
    name: field.str('Untitled app'),
    icon: field.strOrNull,
    accentColor: field.strOrNull,
    definition: field.record<AppDefinition>({}),
    viewer: field.record<StudioAppRuntime['viewer']>({}),
    appVersion: field.numOrNull,
    draft: field.optBool,
});

const readAppActionResult: (raw: unknown) => AppActionResult = shapeOf({
    runId: field.strOrNull,
    status: field.optStr,
    output: field.raw,
    error: field.strOrNull,
    message: field.optStr,
    approvalId: field.optStr,
});

const readApproval: (raw: unknown) => Approval = shapeOf({
    id: field.str(''),
    automationId: field.strOrNull,
    automationTitle: field.str(''),
    projectTitle: field.str(''),
    runId: field.strOrNull,
    stepId: field.strOrNull,
    source: field.str('run'),
    status: field.str('pending'),
    prompt: field.str(''),
    detailsMd: field.strOrNull,
    context: field.recordOrNull,
    decidedByName: field.strOrNull,
    decisionReason: field.strOrNull,
    decidedAt: field.strOrNull,
    expiresAt: field.strOrNull,
    createdAt: field.str(''),
});

const readApprovalDetail: (raw: unknown) => ApprovalDetail = shapeOf({
    approval: readApproval,
    canDecide: field.bool(false),
    canWithdraw: field.bool(false),
});

/** Rows without an id have no screen to open and no key to render under. */
function withId<T extends { id: string }>(rows: T[]): T[] {
    return rows.filter((row) => row.id !== '');
}

// ── Automations ─────────────────────────────────────────────────────

export async function listAutomations(signal?: AbortSignal): Promise<Automation[]> {
    const res = await api.get<unknown>('/api/automation', { signal });
    // `kind: 'block'` rows are reusable Steps, not routines — they have no
    // trigger of their own and cannot be run, so they never belong in a list
    // whose whole purpose is "start this".
    return withId(field.list(readAutomation)(pick(res, 'automations'))).filter(
        (a) => a.kind !== 'block',
    );
}

export async function getAutomation(
    id: string,
    signal?: AbortSignal,
): Promise<{ automation: Automation; summary: string } | null> {
    const res = await api.get<unknown>(`/api/automation/${encodeURIComponent(id)}`, { signal });
    const automation = nullable(readAutomation)(pick(res, 'automation'));
    if (!automation) return null;
    return { automation, summary: field.str('')(pick(res, 'summary')) };
}

/**
 * Rename, re-describe, or re-time a routine.
 *
 * A schedule change sends the patched DEFINITION, not the `scheduleCron`
 * column. Both work — PUT copies an explicit column straight through — but
 * only the definition keeps the two in step: routes/automation/crud.js derives
 * the columns from the definition on every save, so writing the column alone
 * leaves `definition.trigger.schedule.cron` stale, and the next save from the
 * desktop builder would quietly undo the phone's edit.
 */
export async function updateAutomation(
    id: string,
    patch: {
        title?: string;
        description?: string;
        definition?: AutomationDefinition;
    },
): Promise<Automation | null> {
    const res = await api.put<unknown>(`/api/automation/${encodeURIComponent(id)}`, patch);
    return nullable(readAutomation)(pick(res, 'automation'));
}

/** Patch a schedule trigger's cron onto a definition without mutating it. */
export function withSchedule(
    definition: AutomationDefinition,
    cron: string,
    tz: string,
): AutomationDefinition {
    return {
        ...definition,
        trigger: {
            ...(definition.trigger ?? {}),
            kind: 'schedule',
            schedule: { cron, tz },
        },
    };
}

/** The licence codes a gate sends (requireCapability, server/automation/licensedSteps.js). */
const PLAN_CODES = new Set(['feature_locked', 'feature_disabled']);

/**
 * A plan refusal, made readable.
 *
 * Going live with a step the organisation's plan does not include (a new
 * Privacy Shield step, an approval: server/automation/licensedSteps.js), or
 * test-running one, answers 403 with the sentence in `error` and the licence
 * code (`feature_locked` / `feature_disabled`) in `code`, one record per step
 * in `details`; the client already shows that sentence. A licence gate that
 * writes no sentence (the `automations` gate on the whole /api/automation
 * mount) sends the code itself in `error`, and the screen said
 * "feature_locked". This puts a sentence in its place, on the same error
 * object (status, body and class stay, so `details` still lists the steps).
 * `withDetails` folds the step sentences in too, for a screen that shows only
 * the message.
 */
export function readablePlanRefusal(e: unknown, { withDetails = false }: { withDetails?: boolean } = {}): unknown {
    if (!e || typeof e !== 'object') return e;
    const err = e as { status?: number; body?: unknown; message?: string };
    if (err.status !== 403 || !err.body || typeof err.body !== 'object') return e;
    const body = err.body as { error?: unknown; details?: unknown };
    // A sentence in `error` is already the message; only the bare machine word needs one.
    if (typeof body.error !== 'string' || !PLAN_CODES.has(body.error)) return e;
    const lead = translate('mobile.automate.plan_refused', 'This automation uses a feature your organisation\'s plan does not include.');
    const steps = withDetails && Array.isArray(body.details)
        ? body.details
            .map((d) => (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string'
                ? (d as { message: string }).message : ''))
            .filter(Boolean)
        : [];
    try {
        err.message = [lead, ...steps].join(' ');
    } catch {
        /* a frozen error keeps the message it came with */
    }
    return e;
}

/**
 * Arm or disarm a routine.
 *
 * Activation is not a flag flip: the server re-validates the whole flow at
 * `stage: 'strict'`, checks every tool against the caller's permitted apps,
 * and re-arms `next_run_at` — so a 400 here is a real "this cannot go live"
 * with `details`, and the caller must show them rather than a generic failure.
 * A 403 for a step the plan does not include carries `details` too, and a
 * bare licence code is made readable (readablePlanRefusal).
 */
export async function setAutomationActive(id: string, active: boolean): Promise<Automation | null> {
    const path = `/api/automation/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`;
    try {
        const res = await api.post<unknown>(path);
        return nullable(readAutomation)(pick(res, 'automation'));
    } catch (e) {
        throw readablePlanRefusal(e);
    }
}

/**
 * Start a run now.
 *
 * Three answers, all of them normal (routes/automation/runs.js):
 *   200 { accepted, run, steps }     — it finished inside the 60s sync wait
 *   202 { accepted, pending: true }  — still going; watch the stream instead
 *   200 { accepted, skipped: true }  — a Gmail/Nextcloud trigger with no
 *                                      recent message to test against, which
 *                                      is information, not a failure
 * The client timeout is raised past the server's own 60s cap so the sync path
 * is never cut off by us first.
 */
export async function runAutomation(
    id: string,
    triggerPayload?: unknown,
): Promise<RunTriggerResult | null> {
    try {
        return nullable(readRunTriggerResult)(
            await api.post<unknown>(
                `/api/automation/${encodeURIComponent(id)}/run`,
                triggerPayload === undefined ? {} : { triggerPayload },
                { timeoutMs: 70_000, retry: false },
            ),
        );
    } catch (e) {
        // A routine that was never live runs its draft, and a draft with a
        // step the plan does not include is refused; the server's sentence
        // names the steps. A bare licence code gets one (readablePlanRefusal),
        // with the steps folded in: the run screen shows only the message.
        throw readablePlanRefusal(e, { withDetails: true });
    }
}

/** Re-fire a run with its original trigger payload; same 200/202 shapes. */
export async function retryRun(automationId: string, runId: string): Promise<RunTriggerResult | null> {
    return nullable(readRunTriggerResult)(
        await api.post<unknown>(
            `/api/automation/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}/retry`,
            {},
            { timeoutMs: 70_000, retry: false },
        ),
    );
}

/**
 * Ask a run to stop. Answers 202 — the runner honours it at the next
 * between-steps check, so cancel latency is one step, and the caller has to
 * keep watching rather than assume it stopped.
 */
export async function cancelRun(runId: string): Promise<AutomationRun | null> {
    const res = await api.post<unknown>(
        `/api/automation/runs/${encodeURIComponent(runId)}/cancel`,
        {},
        { retry: false },
    );
    return nullable(readRun)(pick(res, 'run'));
}

/**
 * The approvals waiting on this person.
 *
 * `mobile/` had `getApproval` and `decideApproval` but no way to LIST them, so
 * `app/approvals/[id].tsx` could only ever be opened by tapping an unread
 * notification — and once that notification was gone, a decided approval had no
 * door at all, and a pending one had none either.
 *
 * `scope=mine` deliberately: the org scope needs an org-admin role and 403s
 * otherwise, and "what is waiting on ME" is the phone question.
 */
export async function listApprovals(
    status: 'pending' | 'all' = 'pending',
    signal?: AbortSignal,
): Promise<Approval[]> {
    const res = await api.get<unknown>('/api/automation/approvals', {
        query: { scope: 'mine', ...(status === 'pending' ? { status: 'pending' } : {}) },
        signal,
    });
    return withId(field.list(readApproval)(pick(res, 'approvals')));
}

/**
 * One approval by id.
 *
 * Keyed by APPROVAL id, not run id, because that is what a notification link
 * carries (`/app/studio/approvals/:id` — server/automation/approvalHooks.js)
 * and because an App Studio approval has no run at all. The run-keyed
 * `decideRunStep` below cannot serve a notification for either reason.
 *
 * A missing approval and one belonging to somebody else both answer 404 by
 * design: an approval id must not be an oracle for what exists in another
 * organisation.
 */
export async function getApproval(id: string, signal?: AbortSignal): Promise<ApprovalDetail | null> {
    return nullable(readApprovalDetail)(
        await api.get<unknown>(`/api/automation/approvals/${encodeURIComponent(id)}`, { signal }),
    );
}

/**
 * Decide an approval by its own id.
 *
 * Distinct from `decideRunStep`: this route resolves panel seats, stage chains
 * and quorum server-side, so it is the only correct way to decide anything
 * that is not a plain single-assignee run pause.
 */
export async function decideApproval(
    id: string,
    decision: 'approve' | 'reject',
    reason?: string,
): Promise<void> {
    await api.post(
        `/api/automation/approvals/${encodeURIComponent(id)}/decide`,
        { decision, ...(reason ? { reason } : {}) },
        { retry: false },
    );
}

/** Approve or reject the step an `awaiting_approval` run is paused on. */
export async function decideRunStep(
    runId: string,
    decision: 'approve' | 'reject',
    reason?: string,
): Promise<void> {
    await api.post(
        `/api/automation/runs/${encodeURIComponent(runId)}/approve-step`,
        { decision, ...(reason ? { reason } : {}) },
        { retry: false },
    );
}

export async function listRuns(
    automationId: string,
    opts: { limit?: number; status?: string } = {},
    signal?: AbortSignal,
): Promise<AutomationRun[]> {
    const res = await api.get<unknown>(
        `/api/automation/${encodeURIComponent(automationId)}/runs`,
        { signal, query: { limit: opts.limit ?? 30, status: opts.status } },
    );
    return withId(field.list(readRun)(pick(res, 'runs')));
}

/** Cross-automation activity — what the tab's "Recent activity" is built on. */
export async function listRecentRuns(limit = 25, signal?: AbortSignal): Promise<AutomationRun[]> {
    const res = await api.get<unknown>('/api/automation/_runs/recent', {
        signal,
        query: { limit },
    });
    return withId(field.list(readRun)(pick(res, 'runs')));
}

export async function listActiveRuns(signal?: AbortSignal): Promise<ActiveRun[]> {
    const res = await api.get<unknown>('/api/automation/_runs/active', { signal });
    return readActiveRunRows(pick(res, 'active')).filter((r) => r.runId !== '');
}

/**
 * One run. The row you asked for reports the outcome of the LAST leg of its
 * journey — a routine that paused on a form or an approval continues in a
 * child run, and the server folds that back onto this response
 * (`journeyRunId`), so the phone never shows a "success" that was really a
 * hand-off.
 */
export async function getRun(runId: string, signal?: AbortSignal): Promise<AutomationRun | null> {
    const res = await api.get<unknown>(`/api/automation/runs/${encodeURIComponent(runId)}`, {
        signal,
    });
    return nullable(readRun)(pick(res, 'run'));
}

/**
 * The whole journey's steps, plus the flow definition AS IT WAS at run time —
 * so a five-month-old failure still lists the steps that actually existed then
 * rather than today's flow with holes in it.
 */
export async function getRunSteps(
    runId: string,
    signal?: AbortSignal,
): Promise<{ steps: AutomationRunStep[]; definition: AutomationDefinition | null; version: number | null }> {
    const res = await api.get<unknown>(`/api/automation/runs/${encodeURIComponent(runId)}/steps`, {
        signal,
    });
    return {
        steps: field.list(readRunStep)(pick(res, 'steps')),
        definition: field.recordOrNull<AutomationDefinition>(pick(res, 'definition')),
        version: field.numOrNull(pick(res, 'version')),
    };
}

/**
 * Next firing times for a cron, computed by the same code the runner uses —
 * so the preview under the picker is bit-exact with what will happen, not an
 * approximation done on the phone.
 */
export async function previewSchedule(cron: string, tz: string, count = 3): Promise<SchedulePreview | null> {
    return nullable(readSchedulePreview)(
        await api.post<unknown>(
            '/api/automation/_schedule/preview',
            { cron, tz, count },
            { retry: false },
        ),
    );
}

// ── AI tasks ────────────────────────────────────────────────────────

export async function listTasks(signal?: AbortSignal): Promise<AiTaskList> {
    const res = await api.get<unknown>('/api/ai-tasks', { signal });
    return {
        tasks: withId(field.list(readTask)(pick(res, 'tasks'))),
        maxTasks: field.num(10)(pick(res, 'maxTasks')),
    };
}

export interface CreateTaskInput {
    title: string;
    prompt: string;
    /** REQUIRED by the server — a task with no first run time is a 400. */
    nextRunAt: string;
    repeatInterval?: RepeatInterval | null;
    modelTier?: string;
    timezone?: string;
    /** Also fire it immediately instead of waiting for the 60s scheduler tick. */
    startNow?: boolean;
}

export async function createTask(input: CreateTaskInput): Promise<AiTask | null> {
    return nullable(readTask)(await api.post<unknown>('/api/ai-tasks', input, { retry: false }));
}

export async function updateTask(
    id: string,
    patch: Partial<Pick<AiTask, 'title' | 'prompt' | 'nextRunAt' | 'isActive'>> & {
        repeatInterval?: RepeatInterval | null;
    },
): Promise<void> {
    await api.put(`/api/ai-tasks/${encodeURIComponent(id)}`, patch, { retry: false });
}

export async function toggleTask(id: string): Promise<boolean | null> {
    const res = await api.post<unknown>(
        `/api/ai-tasks/${encodeURIComponent(id)}/toggle`,
        {},
        { retry: false },
    );
    const isActive = pick(res, 'isActive');
    return typeof isActive === 'boolean' ? isActive : null;
}

/**
 * Fire a task now. Answers immediately and runs in the background — the result
 * lands in notifications, NOT in this response, so the confirmation has to say
 * where to look.
 */
export async function runTaskNow(id: string): Promise<void> {
    await api.post(`/api/ai-tasks/${encodeURIComponent(id)}/run-now`, {}, { retry: false });
}

export async function deleteTask(id: string): Promise<void> {
    await api.delete(`/api/ai-tasks/${encodeURIComponent(id)}`);
}

// ── Reminders ───────────────────────────────────────────────────────

/** Answers a BARE array, unlike every other list endpoint on this tab. */
export async function listReminders(
    includeCompleted = false,
    signal?: AbortSignal,
): Promise<Reminder[]> {
    return withId(
        readReminderRows(
            await api.get<unknown>('/api/reminders', {
                signal,
                query: includeCompleted ? { completed: 'true' } : undefined,
            }),
        ),
    );
}

export async function createReminder(input: {
    title: string;
    message?: string;
    remindAt: string;
    repeatInterval?: string | null;
}): Promise<Reminder | null> {
    return nullable(readReminder)(await api.post<unknown>('/api/reminders', input, { retry: false }));
}

export async function completeReminder(id: string): Promise<void> {
    await api.post(`/api/reminders/${encodeURIComponent(id)}/complete`, {}, { retry: false });
}

/**
 * Snooze.
 *
 * There is no snooze endpoint — the server models a reminder as a title and a
 * time, so snoozing IS moving the time. Naming it honestly here keeps the
 * screens from inventing a concept the backend does not have.
 */
export async function snoozeReminder(id: string, remindAt: string): Promise<void> {
    await api.put(`/api/reminders/${encodeURIComponent(id)}`, { remindAt }, { retry: false });
}

export async function deleteReminder(id: string): Promise<void> {
    await api.delete(`/api/reminders/${encodeURIComponent(id)}`);
}

// ── Projects ────────────────────────────────────────────────────────

/** Bare array, ordered by `updated_at DESC` server-side. */
export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
    return withId(readProjectRows(await api.get<unknown>('/api/projects', { signal })));
}

export async function getProject(id: string, signal?: AbortSignal): Promise<ProjectDetail | null> {
    return nullable(readProjectDetail)(
        await api.get<unknown>(`/api/projects/${encodeURIComponent(id)}`, { signal }),
    );
}

export async function getProjectMembers(
    id: string,
    signal?: AbortSignal,
): Promise<ProjectMembers | null> {
    return nullable(readProjectMembers)(
        await api.get<unknown>(`/api/projects/${encodeURIComponent(id)}/members`, { signal }),
    );
}

/**
 * Everything filed into a project. Each section comes back `null` when its
 * store was unavailable, which the server distinguishes from `[]` on purpose —
 * see routes/projects.js `load()`.
 */
export async function getProjectResources(
    id: string,
    signal?: AbortSignal,
): Promise<ProjectResources | null> {
    return nullable(readProjectResources)(
        await api.get<unknown>(`/api/projects/${encodeURIComponent(id)}/resources`, { signal }),
    );
}

/** Conversations shared INTO the project (`shared_scope = 'project'`). */
export async function listProjectThreads(
    id: string,
    signal?: AbortSignal,
): Promise<ProjectThread[]> {
    const res = await api.get<unknown>(`/api/projects/${encodeURIComponent(id)}/threads`, {
        signal,
        query: { limit: 50 },
    });
    return withId(readThreadRows(pick(res, 'threads')));
}

// ── Studio apps ─────────────────────────────────────────────────────

/**
 * Apps the caller may open. Meta only — the component tree arrives from
 * /runtime, which is also where the audience gate is enforced.
 */
export async function listStudioApps(signal?: AbortSignal): Promise<StudioAppMeta[]> {
    const res = await api.get<unknown>('/api/studio-apps', { signal });
    return withId(field.list(readStudioApp)(pick(res, 'apps')));
}

/**
 * The run view. A non-owner always gets the frozen published copy; an
 * unpublished app answers 404 for them, which is a visibility answer and not
 * an error to apologise for.
 */
export async function getAppRuntime(
    id: string,
    signal?: AbortSignal,
): Promise<StudioAppRuntime | null> {
    return nullable(readAppRuntime)(
        await api.get<unknown>(`/api/studio-apps/${encodeURIComponent(id)}/runtime`, { signal }),
    );
}

/**
 * Submit a form to one of the app's actions.
 *
 * Only `kind: 'run_automation'` actions are reachable here — the bridge 404s
 * anything else (routes/studioAppsRun.js), and the phone checks the kind up
 * front so a button that cannot work is disabled rather than failing on tap.
 *
 * Inputs are resolved SERVER-SIDE from the action's own `inputMapping`; the
 * form values below only flow through `field` mappings, and only as
 * primitives. Answers 200 with the final output, 202 `{ runId, status:
 * 'pending' }` past the 60s wait, or `{ status: 'skipped' }` when the routine
 * was already running.
 */
export async function runAppAction(
    appId: string,
    actionId: string,
    formValues: AppFormValues,
): Promise<AppActionResult | null> {
    return nullable(readAppActionResult)(
        await api.post<unknown>(
            `/api/studio-apps/${encodeURIComponent(appId)}/actions/${encodeURIComponent(actionId)}/run`,
            { formValues },
            { timeoutMs: 70_000, retry: false },
        ),
    );
}

/** Poll a 202'd app action. Same body as the synchronous answer. */
export async function getAppActionRun(
    appId: string,
    runId: string,
    signal?: AbortSignal,
): Promise<AppActionResult | null> {
    return nullable(readAppActionResult)(
        await api.get<unknown>(
            `/api/studio-apps/${encodeURIComponent(appId)}/actions/runs/${encodeURIComponent(runId)}`,
            { signal },
        ),
    );
}

// ── Directory (best-effort name resolution) ─────────────────────────

export interface DirectoryPerson {
    id: string;
    username?: string;
    displayName?: string;
    email?: string;
}

export interface DirectoryGroup {
    id: string;
    name?: string;
}

const readPeople: (raw: unknown) => DirectoryPerson[] = shapeListOf({
    id: field.str(''),
    username: field.optStr,
    displayName: field.optStr,
    email: field.optStr,
});

const readGroups: (raw: unknown) => DirectoryGroup[] = shapeListOf({
    id: field.str(''),
    name: field.optStr,
});

/**
 * Names for the ids a project's member list is made of.
 *
 * `project_shares` stores only `shared_with_id`, so a member row is a UUID
 * until something resolves it. The only resolvers are `/auth/users` and
 * `/auth/groups`, and BOTH refuse anyone without manage_users, admin_security
 * or org_admin — which is most people on a phone.
 *
 * So this is deliberately best-effort and never throws: an admin sees names, a
 * team member sees "Person" and a shortened id, and neither sees an error for
 * a permission they were never meant to have. agent-hub does exactly the same
 * ("non-admin users may not have access — fall back to ID input").
 */
export async function listDirectory(
    signal?: AbortSignal,
): Promise<{ users: DirectoryPerson[]; groups: DirectoryGroup[] }> {
    const [users, groups] = await Promise.all([
        api.get<unknown>('/auth/users', { signal, retry: false }).catch(() => null),
        api.get<unknown>('/auth/groups', { signal, retry: false }).catch(() => null),
    ]);
    return { users: withId(readPeople(users)), groups: withId(readGroups(groups)) };
}
