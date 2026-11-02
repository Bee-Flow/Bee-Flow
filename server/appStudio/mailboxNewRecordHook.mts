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
 *     the AI budget apply exactly as they do there.
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

type Values = Record<string, unknown>;
export type NewRecord = { id: string; values: Values };
/** What one sync inserted: conversations (thread mode only) and messages. */
export type NewRecords = { thread: NewRecord[]; message: NewRecord[] };

type App = { id: string; userId: string; name?: string | null; organizationId?: string | null; definition?: unknown; publishedDefinition?: unknown };
type Step = Record<string, unknown> & { kind?: string };
type StepResult = { ok: boolean; result?: unknown; error?: string };
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

function ctxFor(app: App, def: Record<string, unknown>, actionId: string, item: unknown, run: Run): Record<string, unknown> {
    return {
        viewerId: app.userId, actionId, viewerName: null, viewerEmail: null,
        role: 'owner', orgId: app.organizationId || null,
        formValues: {}, vars: run.vars,
        variables: Array.isArray(def.variables) ? def.variables : null,
        item,
        viewer: { id: app.userId, role: 'owner', organizationId: app.organizationId || null },
    };
}

const same = (a: unknown, b: unknown): boolean => a === b || (a != null && b != null && String(a) === String(b));

async function walk(list: unknown, app: App, model: unknown, def: Record<string, unknown>, actionId: string, item: unknown, run: Run, deps: HookDeps): Promise<void> {
    for (const raw of Array.isArray(list) ? list : []) {
        if (run.failure) return;
        const step = raw as Step | null;
        if (!step || typeof step.kind !== 'string') continue;
        const ctx = ctxFor(app, def, actionId, item, run);
        if (step.kind === 'condition') {
            const value = deps.evaluate(String(step.expr ?? ''), deps.buildScope(ctx));
            await walk(value ? step.then : step.else, app, model, def, actionId, item, run, deps);
        } else if (step.kind === 'switch') {
            const value = deps.evaluate(String(step.expr ?? ''), deps.buildScope(ctx));
            const cases = Array.isArray(step.cases) ? step.cases as Array<{ value?: unknown; steps?: unknown }> : [];
            const hit = cases.find((c) => c && same(c.value, value));
            await walk(hit ? hit.steps : step.default, app, model, def, actionId, item, run, deps);
        } else {
            run.steps += 1;
            const res = await deps.executeStep(app, model, step, ctx);
            if (!res || res.ok !== true) { run.failure = res?.error || 'Step failed'; return; }
            if (typeof step.resultVar === 'string' && step.resultVar) run.vars = { ...run.vars, [step.resultVar]: res.result ?? null };
        }
    }
}

/** Run the action for one new row. Never throws. */
async function runOne(app: App, model: unknown, def: Record<string, unknown>, actionId: string, action: unknown, item: unknown, deps: HookDeps): Promise<Run> {
    const run: Run = { vars: {}, steps: 0, failure: null };
    try {
        const steps = (action as Step).kind === 'sequence' ? (action as { steps?: unknown }).steps : [action];
        await walk(steps, app, model, def, actionId, item, run, deps);
    } catch (e) {
        run.failure = (e as Error)?.message || 'Step failed';
    }
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
