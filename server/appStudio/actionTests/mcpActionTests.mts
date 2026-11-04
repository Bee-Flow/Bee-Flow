/**
 * app_save_test and app_run_tests over the Studio MCP: saved, repeatable tests of one action.
 *
 * A test is { actionId, name, scope, mock, expect } (testSpec.mts), stored in its own table
 * (stores/studioApp/actionTests.mts), never in the definition. Running one is a DRY run of the
 * latest saved draft through the same walker and host app_run_action uses (mcpRunAction.runOnce),
 * with the test's mocks, then its expectations against the outcome (expectations.mts).
 *
 *   - save: whoever may edit the app (canWriteStudioApp); delete with remove: true.
 *   - run: the owner only (a run acts as the owner, like app_run_action); one draft read per
 *     call, so every test sees the same definitionVersion; the free window is taken once.
 *     A fully mocked test reaches no model and takes no run budget; an unmocked AI step pays,
 *     lazily, like an app_run_action dry run.
 *   - caps (env, 0 = unlimited): STUDIO_APP_TESTS_MAX tests per app, STUDIO_MCP_RUN_TESTS_MAX
 *     tests per call, STUDIO_MCP_RUN_TESTS_BUDGET_MS for the whole call. A test beyond a cap is
 *     reported not_run, naming the variable.
 *   - audit rows carry counts only, never a test's scope, mock or values.
 */

import { createRequire } from 'node:module';
import { defaultDeps, loadRunTarget, runOnce, takeCallBudgets } from '../mcpRunAction.mts';
import type { App, RunDeps, RunReport, RunTarget, StepReport } from '../mcpRunAction.mts';
import { isObject, limitText, runLimits, trimValue } from '../mcpRunActionPolicy.mts';
import type { Obj, RunLimits } from '../mcpRunActionPolicy.mts';
import { normaliseTestSpec, readTestName } from './testSpec.mts';
import type { CheckedTest } from './testSpec.mts';
import { evaluateTest } from './expectations.mts';
import type { ExpectationResult } from './expectations.mts';
import type { ActionTestRow, ActionTestStore } from '../../stores/studioApp/actionTests.mts';

const nodeRequire = createRequire(import.meta.url);

export type TestDeps = {
    run: RunDeps;
    store: () => ActionTestStore;
    audit: (event: string, entry: Obj, app: App, userId: string) => Promise<void>;
};

export type TestStatus = 'pass' | 'fail' | 'error' | 'not_run';
export type TestReport = {
    actionId: string; name: string; status: TestStatus; wasStatus: string | null; free: boolean; ms: number;
    failures: ExpectationResult[]; steps?: StepReport[]; stopped?: string; notes?: string[]; error?: string; _fixHint?: string;
};

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_FILTER = 50;
const MAX_REPORTED_STEPS = 50;

function limitsOf(deps: TestDeps): RunLimits {
    return { ...runLimits(), ...deps.run.limits() };
}

async function editableApp(deps: TestDeps, appId: string, userId: string): Promise<App | { error: string }> {
    let app: App | null = null;
    try { app = await deps.run.getApp(appId); } catch { app = null; }
    if (!app || !deps.run.canWrite(app, userId)) {
        return { error: `App "${appId}" not found, or this token's user cannot edit it. Call studio_list_apps for the ids you own.` };
    }
    return app;
}

function actionOf(def: unknown, actionId: string): Obj | null {
    const actions = isObject(def) && isObject(def.actions) ? def.actions : {};
    return Object.hasOwn(actions, actionId) && isObject(actions[actionId]) ? actions[actionId] as Obj : null;
}

async function removeTest(deps: TestDeps, app: App, actionId: string, rawName: unknown): Promise<Obj> {
    const named = readTestName(rawName);
    if ('error' in named) return named;
    const store = deps.store();
    const removed = await store.deleteActionTest(app.id, actionId, named.name);
    return { ok: true, removed, total: await store.countActionTests(app.id) };
}

async function capRefusal(deps: TestDeps, app: App, actionId: string, name: string): Promise<{ error: string; _fixHint: string } | null> {
    const limits = limitsOf(deps);
    if (!limits.testsPerApp) return null;
    const store = deps.store();
    if ((await store.listActionTests(app.id, { actionIds: [actionId], names: [name] })).length) return null;
    const total = await store.countActionTests(app.id);
    if (total < limits.testsPerApp) return null;
    return {
        error: `This app already has ${total} saved tests, the most it may have (${limitText(limits, 'testsPerApp')}).`,
        _fixHint: 'Remove tests you no longer need (app_save_test with remove: true), or replace one by saving under its name.',
    };
}

/** app_save_test: insert or replace one test (or remove it). Editors may save. */
export async function saveTest(args: unknown, userId: string, deps: TestDeps = defaultTestDeps()): Promise<Obj> {
    const a = isObject(args) ? args : {};
    const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
    const actionId = typeof a.actionId === 'string' ? a.actionId : '';
    if (!appId) return { error: 'app_save_test needs an appId.' };
    if (!ID_RE.test(actionId)) return { error: 'app_save_test needs the actionId of an action of the app.' };
    const app = await editableApp(deps, appId, userId);
    if ('error' in app) return app;
    if (a.remove === true) return removeTest(deps, app, actionId, a.name);

    const checked = normaliseTestSpec(a, actionOf(app.definition, actionId), actionId);
    if ('error' in checked) return checked;
    const capped = await capRefusal(deps, app, actionId, checked.name);
    if (capped) return capped;
    const store = deps.store();
    const { test, created } = await store.upsertActionTest(app.id, { actionId, name: checked.name, spec: checked.spec, userId });
    await deps.audit('studio_app_mcp_save_test', {
        actionId, created, expectCount: checked.spec.expect.length, mockCount: checked.mockPaths.length,
    }, app, userId);
    return {
        ok: true, saved: created ? 'created' : 'updated',
        test: { id: test.id, actionId, name: test.name, expectCount: checked.spec.expect.length, mockPaths: checked.mockPaths },
        total: await store.countActionTests(app.id),
        hints: checked.hints,
    };
}

// ── Running ─────────────────────────────────────────────────────────────────

function readFilter(raw: unknown, name: string): string[] | { error: string } | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) return { error: `${name} must be a list of strings.` };
    if (raw.length > MAX_FILTER) return { error: `${name} has ${raw.length} entries; at most ${MAX_FILTER}.` };
    return raw as string[];
}

function notRun(t: ActionTestRow, reason: string): TestReport {
    return { actionId: t.actionId, name: t.name, status: 'not_run', wasStatus: t.lastStatus, free: true, ms: 0, failures: [], error: reason };
}

/** The run did not get to the test's question: a rate or read limit, or a time budget. */
function blockedBy(report: RunReport): string | null {
    const hit = report.steps.find((s) => !s.mocked && (s.code === 'rate_limited' || s.code === 'read_limit'));
    if (hit) return hit.error ?? hit.code ?? 'limit';
    if (report.truncated && report.stopped) return `the run stopped early: ${report.stopped}`;
    return null;
}

type RunCtx = { target: RunTarget; userId: string; deps: TestDeps; limits: RunLimits; startedAt: number };

async function runOneTest(c: RunCtx, t: ActionTestRow): Promise<TestReport> {
    const now = c.deps.run.now();
    const action = actionOf(c.target.def, t.actionId);
    const checked = normaliseTestSpec({ name: t.name, ...t.spec }, action, t.actionId);
    if ('error' in checked) {
        return { ...notRun(t, `The saved test no longer fits the action: ${checked.error}`), status: 'error', ...(checked._fixHint ? { _fixHint: checked._fixHint } : {}) };
    }
    const spent = now - c.startedAt;
    const remaining = c.limits.testsBudgetMs ? Math.max(1, c.limits.testsBudgetMs - spent) : 0;
    const budgetMs = [c.limits.budgetMs, remaining].filter((n) => n > 0).reduce((m, n) => Math.min(m, n), Number.POSITIVE_INFINITY);
    const { spec } = checked as CheckedTest;
    const { report, view } = await runOnce(c.target, {
        actionId: t.actionId, userId: c.userId, dryRun: true, scope: spec.scope, mock: spec.mock, chargeUpFront: false,
        budgetMs: Number.isFinite(budgetMs) ? budgetMs : 0, tool: 'app_run_tests',
    }, c.deps.run);
    const { pass, results } = evaluateTest(view, spec.expect, trimValue);
    const blocked = pass ? null : blockedBy(report);
    const status: TestStatus = blocked ? 'error' : (pass ? 'pass' : 'fail');
    return {
        actionId: t.actionId, name: t.name, status, wasStatus: t.lastStatus, free: report.free,
        ms: Math.max(0, c.deps.run.now() - now),
        failures: results.filter((r) => !r.pass),
        ...(status !== 'pass' ? { steps: report.steps.slice(0, MAX_REPORTED_STEPS) } : {}),
        ...(report.stopped ? { stopped: report.stopped } : {}),
        ...(report.notes.length ? { notes: report.notes } : {}),
        ...(blocked ? { error: blocked } : {}),
    };
}

function capReason(c: RunCtx, index: number): string | null {
    const { limits } = c;
    if (limits.testsPerCall && index >= limits.testsPerCall) return `not run: more tests than one call runs (${limitText(limits, 'testsPerCall')}); narrow with actionIds or names.`;
    if (limits.testsBudgetMs && c.deps.run.now() - c.startedAt >= limits.testsBudgetMs) return `not run: the time budget of this call is used up (${limitText(limits, 'testsBudgetMs')}).`;
    return null;
}

function summarise(tests: TestReport[]): Record<string, number> {
    const n = (s: TestStatus): number => tests.filter((t) => t.status === s).length;
    return { total: tests.length, pass: n('pass'), fail: n('fail'), error: n('error'), notRun: n('not_run') };
}

/** app_run_tests: every matching saved test, dry run against the latest draft. Owner only. */
export async function runTests(args: unknown, userId: string, deps: TestDeps = defaultTestDeps()): Promise<Obj> {
    const a = isObject(args) ? args : {};
    const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
    if (!appId) return { error: 'app_run_tests needs an appId.' };
    const actionIds = readFilter(a.actionIds, 'actionIds');
    const names = readFilter(a.names, 'names');
    if (actionIds && 'error' in actionIds) return actionIds;
    if (names && 'error' in names) return names;

    const target = await loadRunTarget(deps.run, appId, userId, 'app_run_tests');
    if ('error' in target) return target;
    const refused = takeCallBudgets(deps.run, userId, false, 'app_run_tests');
    if (refused) return refused;

    const store = deps.store();
    const list = await store.listActionTests(target.app.id, { ...(actionIds ? { actionIds } : {}), ...(names ? { names } : {}) });
    const c: RunCtx = { target, userId, deps, limits: limitsOf(deps), startedAt: deps.run.now() };
    const tests: TestReport[] = [];
    for (let i = 0; i < list.length; i += 1) {
        const reason = capReason(c, i);
        tests.push(reason ? notRun(list[i], reason) : await runOneTest(c, list[i]));
    }
    const ran = tests.map((t, i) => ({ id: list[i].id, status: t.status })).filter((s) => s.status !== 'not_run');
    await store.recordTestStatuses(target.app.id, ran);
    const summary = summarise(tests);
    await deps.audit('studio_app_mcp_run_tests', { ...summary, free: tests.filter((t) => t.status !== 'not_run' && t.free).length }, target.app, userId);
    return {
        ok: summary.fail === 0 && summary.error === 0 && summary.notRun === 0,
        ...(typeof target.app.definitionVersion === 'number' ? { definitionVersion: target.app.definitionVersion } : {}),
        summary,
        tests,
        ...(list.length ? {} : { note: 'No saved tests match. Save one with app_save_test.' }),
    };
}

let storeSingleton: ActionTestStore | null = null;

function defaultStore(): ActionTestStore {
    if (!storeSingleton) {
        const { makeActionTestStore } = nodeRequire('../../stores/studioApp/actionTests.mts') as typeof import('../../stores/studioApp/actionTests.mts');
        storeSingleton = makeActionTestStore(
            { query: (sql, params) => nodeRequire('../../db').run(sql, params) },
            { ready: () => nodeRequire('../../stores/studioAppStore').ready },
        );
    }
    return storeSingleton;
}

export function defaultTestDeps(): TestDeps {
    return {
        run: defaultDeps(),
        store: defaultStore,
        audit: async (event, entry, app, userId) => {
            try {
                await nodeRequire('../../stores/userStore').logAccessAudit(
                    event, 'studio_app', app.id, userId, null, { appName: app.name || null, ...entry }, app.organizationId || null,
                );
            } catch (e) {
                nodeRequire('../../telemetry/log').warn(`[studio-mcp] could not record ${event}: ${(e as Error)?.message}`);
            }
        },
    };
}
