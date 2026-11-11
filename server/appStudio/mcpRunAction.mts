/**
 * app_run_action over the Studio MCP: run one action of an app on the server to TEST it,
 * with a per-step report. Steps go through the same executor a button click uses
 * (actionExecutor.executeDataStep), as the app owner, so row access, quotas and the AI
 * budget behave as they do there. The walk itself is the shared server walker
 * (sequenceWalk.mts) with the MCP host of mcpRunHost.mts (policy per step, the executor choke
 * point, mocks, reads, report); this file is the entry: access, arguments, budgets, audit.
 *
 * Because it runs as the owner (their mailbox, connectors and AI budget), the rules are tight:
 *   - WHO: only when the caller IS the owner. An editor with write access is refused: running
 *     as the owner would hand them the owner's mailbox and budget without the owner acting.
 *     The access decision (canWriteStudioApp, then owner) is taken at call time.
 *   - dryRun (the default): nothing is written, nothing is sent. Record writes, file writers,
 *     automations and approvals are reported as "would ..." and skipped; send_email is never
 *     executed; the AI steps (ai_extract, ai_generate, kb_query, dataset_query) do run, without
 *     their writeTo, and cost the owner's AI budget like a click, unless the call gives them a
 *     fixed answer (`mock`). Client steps are skipped.
 *   - dryRun false: the steps run for real, except those that reach people or need a viewer:
 *     send_email only with mode "draft" (a draft in the mailbox, never a send), and never inside
 *     a loop; run_automation, request_approval, ai_browse and copy_document are refused.
 *   - ONE choke point: every step reaches the executor through the host's execute(), which
 *     re-checks the send_email rule on the step it is about to run. Branches, switch cases and
 *     loops all recurse into the same walker, so nesting cannot bypass it.
 *   - data bindings (record / records / aggregate) are READ on the server, like a click
 *     (runBindings.mts): a loop over a records binding iterates the rows.
 *   - caps: a per-user rate limit (a live run is charged up front; a dry run only when a step
 *     first reaches the executor, so a fully mocked dry run is free), a free hygiene window per
 *     call, a read cap, a step count, a loop-iteration cap, a time budget, a trimmed report (no
 *     big payloads, secret-looking keys redacted).
 */

import { createRequire } from 'node:module';
import {
    LIMIT_ENV, isObject, limitText, readScope, resetRunWindows, runLimits, takeFreeBudget, takeRunBudget, trimValue,
} from './mcpRunActionPolicy.mts';
import type { Obj, RunScope } from './mcpRunActionPolicy.mts';
import { newWalkState, outcomeView, walkAction } from './sequenceWalk.mts';
import { NOOP_RECORDER, startRun, withRunLog } from './runLog/recorder.mts';
import type { RunRecorder } from './runLog/recorder.mts';
import type { OutcomeView } from './sequenceWalk.mts';
import type { ReadData } from './runBindings.mts';
import { checkMock } from './actionTests/mockStep.mts';
import { ownAction } from './actionCalls.mts';
import { dryRunNote, hostFor } from './mcpRunHost.mts';
import { backgroundActionProblems, backgroundLimits, readRunOptions } from './backgroundRunPolicy.mts';
import { lockedMessage, resolveLockKey } from './backgroundRun.mts';
import { newRunId } from '../stores/studioAppData/runPolicy.mts';
import type { ActionRunStore } from '../stores/studioAppData/actionRuns.mts';
import type { App, Deps, Run, RunDeps, RunOnceOptions, RunOutcome, RunReport, RunTarget } from './mcpRunHost.mts';

export type { App, RunDeps, RunOnceOptions, RunReport, RunTarget, StepReport, StepStatus, RunOutcome } from './mcpRunHost.mts';

export { resetRunWindows, takeRunBudget, takeFreeBudget, trimValue };

const nodeRequire = createRequire(import.meta.url);

/** One walk of one action against a target read once. Never audits (the caller does). */
export async function runOnce(target: RunTarget, opts: RunOnceOptions, given: RunDeps = defaultDeps()): Promise<{ report: RunReport; view: OutcomeView; executed: number }> {
    const deps = withDefaults(given);
    const limits = { ...runLimits(), ...deps.limits() };
    const actions = isObject(target.def.actions) ? target.def.actions : {};
    const action = (Object.hasOwn(actions, opts.actionId) && isObject(actions[opts.actionId]) ? actions[opts.actionId] : {}) as Obj;
    const w = newWalkState({ vars: opts.scope.vars, form: opts.scope.form, item: opts.scope.item, params: opts.scope.params, trigger: opts.scope.trigger });
    const budgetMs = opts.budgetMs ?? limits.budgetMs;
    const run: Run = {
        target, deps, limits, opts, reports: [], reportTruncated: false,
        charged: opts.chargeUpFront, chargedHere: false, reads: 0, mocked: 0, current: '',
        deadline: budgetMs ? deps.now() + budgetMs : 0, w,
    };
    const host = opts.recorder ? withRunLog(hostFor(run), opts.recorder) : hostFor(run);
    await walkAction(w, action, host, { actionId: opts.actionId });
    const view = outcomeView(w);
    const truncated = w.truncated || run.reportTruncated;
    const report: RunReport = {
        ok: !w.failed && !(w.stopped && truncated),
        dryRun: opts.dryRun, actionId: opts.actionId, steps: run.reports,
        // The saved version the run read, read fresh from the store: compare it with app_set_action's `version`.
        ...(typeof target.app.definitionVersion === 'number' ? { definitionVersion: target.app.definitionVersion } : {}),
        vars: trimValue(w.vars),
        notes: [...w.notes, ...(opts.dryRun ? [dryRunNote(run)] : [])],
        free: !run.chargedHere && !opts.chargeUpFront,
        mocked: run.mocked,
    };
    if (w.stopped) report.stopped = w.stopped;
    if (truncated) report.truncated = true;
    return { report, view, executed: w.executed };
}

// ── Entry ───────────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** The access decision, taken now: write access (resolution failure = deny), then ownership. */
async function authorize(deps: RunDeps, appId: string, userId: string, tool: string): Promise<{ app: App } | { error: string; _fixHint?: string }> {
    let app: App | null = null;
    try { app = await deps.getApp(appId); } catch { app = null; }
    if (!app || !deps.canWrite(app, userId)) {
        return { error: `App "${appId}" not found, or this token's user cannot edit it. Call studio_list_apps for the ids you own.` };
    }
    if (app.userId !== userId) {
        return {
            error: `${tool} runs as the app owner and is only available to the owner. You can edit this app, but running an action would use the owner's mailbox, connectors and AI budget without the owner acting.`,
            _fixHint: 'Ask the owner to run it (their token), or test the pieces with app_dry_run.',
        };
    }
    return { app };
}

/** Authorise (owner only) and read the draft and its data model once. */
export async function loadRunTarget(given: RunDeps, appId: string, userId: string, tool = 'app_run_action'): Promise<RunTarget | { error: string; _fixHint?: string }> {
    const auth = await authorize(given, appId, userId, tool);
    if ('error' in auth) return auth;
    const { app } = auth;
    const def = (isObject(app.definition) ? app.definition : {}) as Obj;
    let model: unknown = null;
    try { model = (await given.getDataModel(app.id, app.userId) as { model?: unknown } | null)?.model ?? null; } catch { model = null; }
    return { app, def, model };
}

/** The free window, then (live only) the paid budget. A refusal names the variable. */
export function takeCallBudgets(deps: RunDeps, userId: string, live: boolean, tool = 'app_run_action'): { error: string } | null {
    const d = withDefaults(deps);
    const limits = { ...runLimits(), ...d.limits() };
    if (!d.takeFreeBudget(userId, d.now())) {
        return { error: `Too many ${tool} calls (limit ${limits.freePerMinute} per minute per user, ${limitText(limits, 'freePerMinute')}), mocked or not. Wait a minute and run fewer.` };
    }
    if (live && !d.takeBudget(userId, d.now())) {
        return { error: `Too many ${tool} calls (limit ${limits.perMinute} per minute per user, ${limitText(limits, 'perMinute')}). Wait a minute and run fewer.` };
    }
    return null;
}

function versionMismatch(app: App, expect: unknown): { error: string; _fixHint: string } | null {
    if (expect === undefined || expect === null) return null;
    if (app.definitionVersion === expect) return null;
    return {
        error: `The saved draft is version ${app.definitionVersion ?? '(none)'}, not ${String(expect)}: something saved the app in between (the Studio editor autosaves).`,
        _fixHint: 'Re-read with app_get_action and run again.',
    };
}

function readArgs(args: unknown): { appId: string; actionId: string; dryRun: boolean; scope: RunScope; expectVersion: unknown; mock: unknown } | { error: string } {
    const a = isObject(args) ? args : {};
    const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
    const actionId = typeof a.actionId === 'string' ? a.actionId : '';
    if (!appId) return { error: 'app_run_action needs an appId.' };
    if (!ID_RE.test(actionId)) return { error: 'app_run_action needs the actionId of an action of the app.' };
    if (a.expectVersion !== undefined && a.expectVersion !== null && !(Number.isInteger(a.expectVersion) && (a.expectVersion as number) >= 0)) {
        return { error: 'expectVersion must be the draft version as a whole number (app_get_action returns it).' };
    }
    const scope = readScope(a.scope);
    if ('error' in scope) return { error: scope.error };
    return { appId, actionId, dryRun: a.dryRun !== false, scope, expectVersion: a.expectVersion, mock: a.mock };
}

export async function runAction(args: unknown, userId: string, given: RunDeps = defaultDeps()): Promise<RunOutcome> {
    const parsed = readArgs(args);
    if ('error' in parsed) return parsed;
    const { appId, actionId, dryRun, scope } = parsed;

    const target = await loadRunTarget(given, appId, userId);
    if ('error' in target) return target;
    const { app, def } = target;

    const stale = versionMismatch(app, parsed.expectVersion);
    if (stale) return stale;
    const actions = isObject(def.actions) ? def.actions : {};
    const action = Object.hasOwn(actions, actionId) ? actions[actionId] : null;
    if (!isObject(action)) {
        return { error: `The app has no action "${actionId}".`, _fixHint: `Actions: ${Object.keys(actions).slice(0, 50).join(', ') || '(none)'}.` };
    }
    const mock = checkMock(parsed.mock, action, { resolveCallee: (id) => ownAction(actions, id), rootId: actionId });
    if ('error' in mock) return mock;

    const refused = takeCallBudgets(given, userId, !dryRun);
    if (refused) return refused;

    const bg = readRunOptions(action);
    let lock: { store: ActionRunStore; id: string } | null = null;
    let lockKey: string | null = null;
    if (bg.background) {
        lockKey = await resolveLockKey({
            app, def, model: target.model, actionId, viewer: { id: userId }, role: 'owner', isOwner: true, draft: true,
            definitionVersion: app.definitionVersion ?? null,
            scope: { formValues: scope.form, vars: scope.vars, item: scope.item, ...(scope.trigger ? { trigger: scope.trigger } : {}) },
        }, action, { resolveBinding: given.resolveBinding, buildScope: given.buildScope, ...(given.readData ? { readData: given.readData } : {}) });
        if (!dryRun && lockKey) {
            const taken = await takeMcpLock(given, app, actionId, userId, lockKey);
            if ('error' in taken) return taken;
            lock = taken;
        }
    }

    const t0 = Date.now();
    // The run log: the lock row IS the run row of a live background action; otherwise a row of its own.
    const recorder = await startLoggedRun(given, app, actionId, userId, { origin: 'mcp', dryRun, existingId: lock?.id ?? null });
    let outcome: Awaited<ReturnType<typeof runOnce>>;
    try {
        outcome = await runOnce(target, { actionId, userId, dryRun, scope, mock: mock.mock, chargeUpFront: !dryRun, recorder }, given);
    } catch (e) {
        await recorder.finish({ status: 'error', error: 'The run stopped unexpectedly.', errorCode: 'internal', durationMs: Date.now() - t0 });
        if (lock) await lock.store.finishRun(lock.id, { status: 'error', error: 'The run stopped unexpectedly.', errorCode: 'internal', durationMs: Date.now() - t0 }).catch(() => false);
        throw e;
    }
    const { report, executed, view } = outcome;
    await finishLoggedRun(recorder, report, view, Date.now() - t0);
    if (lock) {
        await lock.store.finishRun(lock.id, { status: report.ok ? 'success' : 'error', error: report.ok ? null : (report.stopped ?? null), durationMs: Date.now() - t0, stepCount: executed }).catch(() => false);
    }
    noteRunId(report, recorder);
    if (bg.background) {
        report.background = { lockKey, progressVar: bg.progressVar };
        report.notes.push('Clicked, this runs as a background job (the page shows its progress and can be closed); here it ran inline within the time budget.');
        for (const p of backgroundActionProblems(action, actionId, { resolveCalled: (id) => ownAction(actions, id) }).slice(0, 5)) report.notes.push(`${p.path}: ${p.message}`);
    }
    await given.audit({
        actionId, dryRun, executed, steps: report.steps.length, failed: !report.ok, mocked: report.mocked, free: report.free,
    }, app, userId);
    return report;
}

/** The run log of one MCP walk (origin mcp or test); the NOOP recorder when the deps carry no run log. */
export async function startLoggedRun(given: RunDeps, app: App, actionId: string, userId: string, o: { origin: 'mcp' | 'test'; dryRun: boolean; existingId?: string | null }): Promise<RunRecorder> {
    if (!given.runLog) return NOOP_RECORDER;
    return startRun({
        appId: app.id, ownerUserId: app.userId, actionId, origin: o.origin, viewerUserId: userId, draft: true,
        definitionVersion: app.definitionVersion ?? null, dryRun: o.dryRun, client: 'mcp', existingId: o.existingId ?? null,
    }, { store: given.runLog, log: given.log });
}

/** Close the logged run from the walk's outcome (the first failing step is the run's error). */
export async function finishLoggedRun(recorder: RunRecorder, report: RunReport, view: OutcomeView, durationMs: number): Promise<void> {
    const failed = view.failed;
    await recorder.finish({
        status: report.ok ? 'success' : 'error',
        error: failed ? `${failed.path}: ${failed.error}` : (report.ok ? null : report.stopped ?? null),
        errorCode: failed?.code ?? (report.truncated ? 'run_limit' : null), durationMs, truncated: report.truncated === true,
        endedBy: report.truncated ? 'limit' : null,
    });
}

/** The report names its run row, so the caller can read it back with app_get_run. */
export function noteRunId(report: RunReport, recorder: RunRecorder): void {
    if (!recorder.id) return;
    report.runId = recorder.id;
    report.notes.push(`Logged as run ${recorder.id}: app_get_run shows it.`);
}

/** A live MCP run of a background action takes its lock like a click (one run row, origin mcp). */
async function takeMcpLock(given: RunDeps, app: App, actionId: string, userId: string, lockKey: string): Promise<{ store: ActionRunStore; id: string } | { error: string; _fixHint: string }> {
    const store = given.actionRuns ? given.actionRuns() : (nodeRequire('../stores/studioAppData/actionRuns.mts') as { actionRunStore: () => ActionRunStore }).actionRunStore();
    const id = newRunId();
    const got = await store.insertRunningRun({
        id, appId: app.id, ownerUserId: app.userId, viewerUserId: userId, actionId, origin: 'mcp', draft: true,
        definitionVersion: app.definitionVersion ?? null, dryRun: false, lockKey, instanceId: `${process.pid}`, staleMs: backgroundLimits().staleMs,
    });
    if (got.ok) return { store, id };
    return { error: lockedMessage(got.holder, Date.now()), _fixHint: 'A background run with the same lockKey is going. Wait for it, run with dryRun (takes no lock), or pass a scope that resolves another lockKey.' };
}

/** Fill the optional deps (a test passes only what it controls). */
function withDefaults(deps: RunDeps): Deps {
    return {
        ...deps,
        readData: deps.readData ?? ((app, model, binding, opts) => (nodeRequire('./stepDataSource.js') as { resolveDataBinding: ReadData }).resolveDataBinding(app, model, binding, opts)),
        takeFreeBudget: deps.takeFreeBudget ?? ((uid, now) => takeFreeBudget(uid, now, { ...runLimits(), ...deps.limits() }.freePerMinute)),
        promptOf: deps.promptOf ?? ((step, ctx) => (nodeRequire('./actionExecutor/aiSteps.js') as { interpolatePrompt: (t: unknown, c: Obj) => string }).interpolatePrompt(step.prompt, ctx)),
    };
}

export function defaultDeps(): RunDeps {
    return {
        getApp: (appId) => nodeRequire('../stores/studioAppStore').getStudioApp(appId),
        canWrite: (app, userId) => nodeRequire('../stores/studioAppStore').canWriteStudioApp(app, userId),
        getDataModel: (appId, ownerId) => nodeRequire('../stores/studioAppDataStore').getDataModel(appId, ownerId),
        executeStep: (app, model, step, ctx) => nodeRequire('./actionExecutor').executeDataStep(app, model, step, ctx),
        evaluate: (expr, scope) => nodeRequire('../shared/expr/index.mjs').tryEvaluate(expr, scope)?.value,
        buildScope: (ctx) => nodeRequire('./actionExecutor/shared').buildServerScope(ctx),
        resolveBinding: (binding, ctx, scope) => nodeRequire('./actionExecutor/shared').resolveBinding(binding, ctx, scope),
        previewWrite: (app, model, step, ctx) => nodeRequire('./actionExecutor/bulkRecords.mts').previewMatching(app, model, step, ctx),
        takeBudget: (userId, now) => takeRunBudget(userId, now, runLimits().perMinute),
        audit: async (entry, app, userId) => {
            try {
                await nodeRequire('../stores/userStore').logAccessAudit(
                    `studio_app_mcp_run_action_${entry.dryRun ? 'dry' : 'live'}`, 'studio_app', app.id, userId, null,
                    { appName: app.name || null, ...entry }, app.organizationId || null,
                );
            } catch (e) {
                nodeRequire('../telemetry/log').warn(`[studio-mcp] could not record a run: ${(e as Error)?.message}`);
            }
        },
        log: nodeRequire('../telemetry/log'),
        now: () => Date.now(),
        limits: () => runLimits(),
        runLog: () => (nodeRequire('../stores/studioAppData/runLogStore.mts') as { runLogStore: () => import('../stores/studioAppData/runLogStore.mts').RunLogStore }).runLogStore(),
    };
}

export { LIMIT_ENV };
