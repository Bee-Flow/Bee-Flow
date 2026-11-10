/**
 * The mailbox connector's "new record" hook: after a sync, run one app action for each
 * NEW row, on the server, as the app owner, with { item: <the new row> } in scope.
 *
 * Until now an app could only act on a click. This is the background half: a
 * conversation or an incoming message arrives and the app files it (ai_generate to
 * summarise, update_record to set a status, create_record to log it) without anyone
 * pressing a button.
 *
 * What keeps it safe to leave unattended:
 *   - only server steps that do not reach people (mailboxHookPolicy.mts); send_email is
 *     refused, so nothing mails automatically by accident. The action is checked again
 *     right before every run, because it may have been edited after the connector was saved;
 *   - two caps, per sync and per minute per app (0 = unlimited, env vars in the policy);
 *   - a failure is logged and recorded, never thrown: the sync that found the row has
 *     already succeeded and must stay so;
 *   - every step goes through the same executor a click uses, so row access, quotas and
 *     the AI budget apply exactly as they do there;
 *   - the action is walked by the ONE server walker (sequenceWalk.mts), so a step's
 *     `retry` and `onError` handler behave as on a click.
 *
 * Runs after the sync released its claim, so a slow model call never holds the connector.
 * A row is "new" once: it is stored by then, so a run skipped by a cap or a failure is
 * not retried by the next sync (it is in the run log).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

// Required, not imported: agent-hub's typecheck follows connectorSync.js into this file, and it does
// not run with the option a '.mts' import path needs (the same reason mailboxRecordedReplies.mts
// imports nothing local).
type HookTarget = 'thread' | 'inbound_message';
type HookLimits = { perSync: number; perMinute: number };
const policy = nodeRequire('./mailboxHookPolicy.mts') as {
    hookActionProblems: (action: unknown, actionId?: string) => string[];
    hookLimits: () => HookLimits;
    readOnNewRecord: (raw: unknown) => { actionId: string; target: HookTarget } | null;
};
const { hookActionProblems, hookLimits, readOnNewRecord } = policy;
type WalkState = { vars: Record<string, unknown>; item: unknown; error?: Record<string, unknown>; executed: number; failed: { error: string } | null };
type WalkHost = Record<string, unknown>;
const walker = nodeRequire('./sequenceWalk.mts') as {
    newWalkState: (init: { item?: unknown }) => WalkState;
    walkAction: (w: WalkState, action: Record<string, unknown>, host: WalkHost, opts: { actionId: string }) => Promise<void>;
};

type RunRecorder = { id: string | null; finish: (o: { status: string; error?: string | null; errorCode?: string | null; durationMs: number }) => Promise<void> };
const runLog = nodeRequire('./runLog/recorder.mts') as {
    NOOP_RECORDER: RunRecorder;
    startRun: (meta: Record<string, unknown>, deps: Record<string, unknown>) => Promise<RunRecorder>;
    withRunLog: (host: WalkHost, recorder: RunRecorder) => WalkHost;
};

type Values = Record<string, unknown>;
export type NewRecord = { id: string; values: Values };
/** What one sync inserted: conversations (thread mode only) and messages. */
export type NewRecords = { thread: NewRecord[]; message: NewRecord[] };

type App = { id: string; userId: string; name?: string | null; organizationId?: string | null; definition?: unknown; publishedDefinition?: unknown };
type Step = Record<string, unknown> & { kind?: string };
type StepResult = { ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean };
type Connector = { id?: string; kind?: string; onNewRecord?: unknown };

export type HookRunLog = {
    appId: string; connectorId: string; actionId: string; target: HookTarget;
    recordId: string | null; status: 'ok' | 'failed' | 'refused' | 'skipped_limit'; error?: string; steps?: number;
};

export type HookDeps = {
    getApp: (appId: string) => Promise<App | null>;
    executeStep: (app: App, model: unknown, step: Step, ctx: Record<string, unknown>) => Promise<StepResult>;
    evaluate: (expr: string, scope: unknown) => unknown;
    buildScope: (ctx: Record<string, unknown>) => unknown;
    record: (entry: HookRunLog, app: App) => Promise<void>;
    log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
    limits: () => HookLimits;
    now: () => number;
    /** The wait between retries of a step with `retry` (fake in tests). */
    sleep?: (ms: number) => Promise<void>;
    /** The run log (origin mailbox_hook, no actor); absent: not logged. */
    runLog?: () => unknown;
};

export type HookReport = { ran: number; failed: number; refused: number; skippedLimit: number };

function defaultDeps(): HookDeps {
    return {
        getApp: (appId) => nodeRequire('../stores/studioAppStore').getStudioApp(appId),
        executeStep: (app, model, step, ctx) => nodeRequire('./actionExecutor').executeDataStep(app, model, step, ctx),
        evaluate: (expr, scope) => nodeRequire('../shared/expr/index.mjs').tryEvaluate(expr, scope)?.value,
        buildScope: (ctx) => nodeRequire('./actionExecutor/shared').buildServerScope(ctx),
        record: recordRun,
        log: nodeRequire('../telemetry/log'),
        limits: () => hookLimits(),
        now: () => Date.now(),
        runLog: () => (nodeRequire('../stores/studioAppData/runLogStore.mts') as { runLogStore: () => unknown }).runLogStore(),
    };
}

// ── The per-app minute window ──────────────────────────────────────────────

const WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

/** How many more runs this app may start within the minute; Infinity when unlimited. */
function minuteRoom(appId: string, perMinute: number, now: number): number {
    if (perMinute === 0) return Infinity;
    const recent = (windows.get(appId) || []).filter((t) => now - t < WINDOW_MS);
    windows.set(appId, recent);
    return Math.max(0, perMinute - recent.length);
}

function spendMinute(appId: string, now: number): void {
    const list = windows.get(appId) || [];
    list.push(now);
    windows.set(appId, list);
}

/** Test seam: forget every app's window. */
export function resetHookWindows(): void { windows.clear(); }

// ── One action run ─────────────────────────────────────────────────────────

type Run = { vars: Record<string, unknown>; steps: number; failure: string | null };

function ctxFor(app: App, def: Record<string, unknown>, actionId: string, w: WalkState): Record<string, unknown> {
    return {
        viewerId: app.userId, actionId, viewerName: null, viewerEmail: null,
        role: 'owner', orgId: app.organizationId || null,
        formValues: {}, vars: w.vars,
        variables: Array.isArray(def.variables) ? def.variables : null,
        item: w.item,
        ...(w.error ? { error: w.error } : {}),
        viewer: { id: app.userId, role: 'owner', organizationId: app.organizationId || null },
    };
}

/**
 * The hook as a host of the shared walker. Every step the policy lets through runs
 * (hookActionProblems refused the rest before the run), through the executor.
 */
function hostFor(app: App, model: unknown, def: Record<string, unknown>, actionId: string, deps: HookDeps): WalkHost {
    const ctx = (w: WalkState): Record<string, unknown> => ctxFor(app, def, actionId, w);
    return {
        decide: async (step: Step) => ({ run: true, step }),
        execute: (step: Step, _f: unknown, w: WalkState) => deps.executeStep(app, model, step, ctx(w)),
        // set_variable, loop and call_action are refused by the policy, so nothing here reads data.
        // What is left is the message of a raise_error and the value of a return: a static value
        // or a formula (evaluated like a condition's). Any other binding is refused.
        resolve: async (binding: unknown, _c: unknown, scope: unknown) => {
            const b = binding !== null && typeof binding === 'object' ? binding as Record<string, unknown> : null;
            if (b && b.kind === 'static') return b.value;
            if (b && b.kind === 'formula' && typeof b.expr === 'string') return deps.evaluate(b.expr, scope);
            throw new Error('This step cannot run on an arriving mail');
        },
        evaluate: (expr: string, scope: unknown) => deps.evaluate(expr, scope),
        buildScope: (c: Record<string, unknown>) => deps.buildScope(c),
        ctxFor: (w: WalkState) => ctx(w),
        sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })),
        now: () => deps.now(),
    };
}

/** Run the action for one new row. Never throws. */
async function runOne(app: App, model: unknown, def: Record<string, unknown>, actionId: string, action: unknown, item: unknown, deps: HookDeps): Promise<Run> {
    const w = walker.newWalkState({ item });
    const t0 = deps.now();
    const recorder = deps.runLog
        ? await runLog.startRun({
            appId: app.id, ownerUserId: app.userId, actionId, origin: 'mailbox_hook', viewerUserId: null,
            draft: !app.publishedDefinition, definitionVersion: null, client: 'mailbox',
        }, { store: deps.runLog, log: deps.log })
        : runLog.NOOP_RECORDER;
    let run: Run;
    try {
        await walker.walkAction(w, action as Record<string, unknown>, runLog.withRunLog(hostFor(app, model, def, actionId, deps), recorder), { actionId });
        run = { vars: w.vars, steps: w.executed, failure: w.failed ? w.failed.error : null };
    } catch (e) {
        run = { vars: w.vars, steps: w.executed, failure: (e as Error)?.message || 'The action could not run' };
    }
    await recorder.finish({ status: run.failure ? 'error' : 'success', error: run.failure, durationMs: Math.max(0, deps.now() - t0) });
    return run;
}

// ── The hook ───────────────────────────────────────────────────────────────

/** The rows the hook acts on for this target. */
function candidates(target: HookTarget, news: NewRecords): NewRecord[] {
    return target === 'thread' ? news.thread : news.message.filter((r) => r.values.direction === 'inbound');
}

/**
 * Run the connector's hook for the rows one sync inserted. Resolves to null when there is
 * nothing to do (no hook, no new row, no app), and never rejects.
 */
export async function runNewRecordHook(
    appRef: { id: string }, model: unknown, connector: Connector, news: NewRecords, deps: HookDeps = defaultDeps(),
): Promise<HookReport | null> {
    try {
        const hook = connector?.kind === 'mailbox' ? readOnNewRecord(connector.onNewRecord) : null;
        if (!hook) return null;
        const rows = candidates(hook.target, news);
        if (!rows.length) return null;
        const app = await deps.getApp(appRef.id);
        if (!app) return null;
        return await runRows(app, model, connector, hook, rows, deps);
    } catch (e) {
        deps.log.error(`[MailboxHook] ${appRef.id}: ${(e as Error)?.message}`);
        return null;
    }
}

async function runRows(app: App, model: unknown, connector: Connector, hook: { actionId: string; target: HookTarget }, rows: NewRecord[], deps: HookDeps): Promise<HookReport> {
    const report: HookReport = { ran: 0, failed: 0, refused: 0, skippedLimit: 0 };
    const base = { appId: app.id, connectorId: String(connector.id), actionId: hook.actionId, target: hook.target };
    // The live copy when there is one, else the draft: the same pick a viewer's click makes for the owner.
    const def = (app.publishedDefinition || app.definition || {}) as Record<string, unknown>;
    const actions = (def.actions && typeof def.actions === 'object' ? def.actions : {}) as Record<string, unknown>;
    const action = Object.hasOwn(actions, hook.actionId) ? actions[hook.actionId] : null;

    const problems = hookActionProblems(action, hook.actionId);
    if (problems.length) {
        deps.log.warn(`[MailboxHook] ${app.id}/${base.connectorId} refused: ${problems[0]}`);
        report.refused = rows.length;
        await deps.record({ ...base, recordId: null, status: 'refused', error: problems[0] }, app);
        return report;
    }

    const limits = deps.limits();
    let allowed = limits.perSync === 0 ? rows.length : Math.min(rows.length, limits.perSync);
    for (const row of rows) {
        const now = deps.now();
        if (allowed <= 0 || minuteRoom(app.id, limits.perMinute, now) <= 0) {
            report.skippedLimit += 1;
            await deps.record({ ...base, recordId: row.id, status: 'skipped_limit' }, app);
            continue;
        }
        allowed -= 1;
        spendMinute(app.id, now);
        const run = await runOne(app, model, def, hook.actionId, action, { id: row.id, ...row.values }, deps);
        if (run.failure) {
            report.failed += 1;
            deps.log.warn(`[MailboxHook] ${app.id}/${base.connectorId} ${hook.actionId} failed for ${row.id}: ${run.failure}`);
            await deps.record({ ...base, recordId: row.id, status: 'failed', error: run.failure.slice(0, 200), steps: run.steps }, app);
        } else {
            report.ran += 1;
            await deps.record({ ...base, recordId: row.id, status: 'ok', steps: run.steps }, app);
        }
    }
    if (report.skippedLimit) deps.log.warn(`[MailboxHook] ${app.id}/${base.connectorId}: ${report.skippedLimit} new row(s) not processed, over the limit`);
    return report;
}

// ── The run log ────────────────────────────────────────────────────────────

/**
 * One line per run in the access audit (which app, action and row, and the outcome; never
 * the mail). The steps themselves leave their own usage rows, as they do on a click. Best effort.
 */
async function recordRun(entry: HookRunLog, app: App): Promise<void> {
    try {
        await nodeRequire('../stores/userStore').logAccessAudit(
            `studio_app_mailbox_hook_${entry.status}`, 'studio_app', app.id, 'system', null,
            { appName: app.name || null, ownerId: app.userId, connectorId: entry.connectorId, actionId: entry.actionId, target: entry.target, recordId: entry.recordId, steps: entry.steps ?? null, error: entry.error ?? null },
            app.organizationId || null,
        );
    } catch (e) {
        nodeRequire('../telemetry/log').warn(`[MailboxHook] could not record a run: ${(e as Error)?.message}`);
    }
}
