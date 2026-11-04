/**
 * app_list_runs / app_get_run over the Studio MCP: the run log of an app (who ran which action,
 * when, how long, how it ended, per step the duration, error and AI usage). Read-only.
 *
 * The answer leaves Bee Flow, so people are never named: an actor is a kind (owner, user,
 * visitor, system), `isYou`, and a per-app reference (runLog/readRuns.mts toMcpRun). The rows
 * themselves hold no customer values (the recorder keeps no result, scope or prompt).
 * Owner only, with the same "not found" answer as app_run_action's access check.
 */

import { createRequire } from 'node:module';
import { listPage, readRunQuery, toMcpRun, toMcpStep } from './runLog/readRuns.mts';
import type { RunLogStore } from '../stores/studioAppData/runLogStore.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string };

export type RunLogDeps = {
    getApp: (appId: string) => Promise<App | null>;
    canWrite: (app: App, userId: string) => boolean;
    store: () => RunLogStore;
    policy: { idleMs: number; staleMs: number; retentionDays: number };
};

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const STATUSES = ['running', 'success', 'error', 'interrupted', 'cancelled', 'refused'];
const ORIGINS = ['click', 'public', 'mcp', 'test', 'background', 'mailbox_hook'];

function defaultDeps(): RunLogDeps {
    const policy = nodeRequire('../stores/studioAppData/runPolicy.mts') as typeof import('../stores/studioAppData/runPolicy.mts');
    return {
        getApp: (appId) => nodeRequire('../stores/studioAppStore').getStudioApp(appId),
        canWrite: (app, userId) => nodeRequire('../stores/studioAppStore').canWriteStudioApp(app, userId),
        store: () => (nodeRequire('../stores/studioAppData/runLogStore.mts') as { runLogStore: () => RunLogStore }).runLogStore(),
        policy: { idleMs: policy.idleCloseMs(), staleMs: policy.staleStepMs(), retentionDays: policy.retentionDays() },
    };
}

async function authorize(deps: RunLogDeps, appId: string, userId: string): Promise<App | { error: string }> {
    let app: App | null = null;
    try { app = await deps.getApp(appId); } catch { app = null; }
    if (!app || !deps.canWrite(app, userId)) {
        return { error: `App "${appId}" not found, or this token's user cannot edit it. Call studio_list_apps for the ids you own.` };
    }
    return app;
}

function readListArgs(a: Obj): { error: string } | Obj {
    if (a.actionId !== undefined && !(typeof a.actionId === 'string' && ID_RE.test(a.actionId))) return { error: 'actionId is the id of an action of the app.' };
    if (a.status !== undefined && !STATUSES.includes(String(a.status))) return { error: `status is one of ${STATUSES.join(', ')}.` };
    const origins = a.origin === undefined ? [] : (Array.isArray(a.origin) ? a.origin : String(a.origin).split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (origins.some((o) => !ORIGINS.includes(o))) return { error: `origin is one or more of ${ORIGINS.join(', ')}.` };
    if (a.user !== undefined && !['me', 'others', 'visitors', 'system'].includes(String(a.user))) return { error: 'user is me, others, visitors or system.' };
    if (a.since !== undefined && (typeof a.since !== 'string' || Number.isNaN(Date.parse(a.since)))) return { error: 'since is a date and time (ISO 8601).' };
    if (a.limit !== undefined && !(Number.isInteger(a.limit) && (a.limit as number) >= 1 && (a.limit as number) <= 50)) return { error: 'limit is a whole number from 1 to 50.' };
    return { ...a, origin: origins };
}

export async function listRuns(args: unknown, userId: string, deps: RunLogDeps = defaultDeps()): Promise<Obj> {
    const a = isObject(args) ? args : {};
    const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
    if (!appId) return { error: 'app_list_runs needs an appId.' };
    const app = await authorize(deps, appId, userId);
    if ('error' in app) return app;
    const parsed = readListArgs(a);
    if ('error' in parsed) return parsed;
    const filter = readRunQuery(parsed as Parameters<typeof readRunQuery>[0], {
        appId: app.id, callerId: userId, idleMs: deps.policy.idleMs, staleMs: deps.policy.staleMs, maxLimit: 50, defaultLimit: 20,
    });
    if ('error' in filter) return { error: filter.error, _fixHint: 'Leave cursor out for the first page; pass the nextCursor of the previous answer for the next.' };
    const { rows, nextCursor } = await listPage(deps.store(), filter);
    return {
        runs: rows.map((r) => toMcpRun(r, app.id, app.userId, userId)),
        nextCursor,
        retentionDays: deps.policy.retentionDays,
        ...(rows.length ? {} : { note: 'No runs match. Runs are logged from clicks, public pages, app_run_action, app_run_tests, background jobs and mailbox hooks.' }),
    };
}

export async function getRun(args: unknown, userId: string, deps: RunLogDeps = defaultDeps()): Promise<Obj> {
    const a = isObject(args) ? args : {};
    const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
    if (!appId) return { error: 'app_get_run needs an appId.' };
    const app = await authorize(deps, appId, userId);
    if ('error' in app) return app;
    const runId = typeof a.runId === 'string' ? a.runId : '';
    const notFound = { error: `The app has no run "${runId.slice(0, 80)}".`, _fixHint: 'app_list_runs lists the runs (newest first); runs older than the retention are gone.' };
    if (!/^sar_[a-f0-9]{32}$/.test(runId)) return notFound;
    const store = deps.store();
    const run = await store.getLoggedRun(app.id, runId, { idleMs: deps.policy.idleMs, staleMs: deps.policy.staleMs });
    if (!run) return notFound;
    const steps = await store.getSteps(run.id);
    return { run: toMcpRun(run, app.id, app.userId, userId), steps: steps.map(toMcpStep) };
}
