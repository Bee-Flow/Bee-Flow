/**
 * App Studio builder: the in-product run and test tools (app_run_action, app_save_test,
 * app_run_tests, app_list_runs, app_get_run in builderTools/tools/). They are the Studio MCP
 * tools of the same name, reused as they are (mcpRunAction.mts, actionTests/mcpActionTests.mts,
 * mcpRunLog.mts), with three differences:
 *
 *   - DRY RUN ONLY. app_run_action refuses any dryRun but true before it reads anything, and
 *     always hands the MCP entry dryRun: true. A dry run writes no row and sends no mail (the MCP
 *     host's decideStep and its one executor choke point); app_run_tests is a dry run already.
 *     A live run stays an MCP call by the owner.
 *   - The app is the builder's own draft (draftWrap.appId), never an id from the model, and a run
 *     is pinned to the draft version the builder holds (expectVersion), so it tests what the
 *     builder just built.
 *   - Answers are sized for the builder (resultFit.mts) and worded for it; audit rows are named
 *     studio_app_builder_*.
 *
 * Access is the MCP rule, taken at call time: running (app_run_action, app_run_tests) is for the
 * app owner only, since a run uses the owner's mailbox, connectors and AI budget; saving a test
 * and reading the run log need edit access. Runs are logged in the app's run log like an MCP
 * test run.
 */

import { createRequire } from 'node:module';
import { defaultDeps, runAction } from '../mcpRunAction.mts';
import type { App, RunDeps } from '../mcpRunAction.mts';
import { defaultTestDeps, runTests, saveTest } from '../actionTests/mcpActionTests.mts';
import type { TestDeps } from '../actionTests/mcpActionTests.mts';
import { getRun, listRuns } from '../mcpRunLog.mts';
import type { RunLogDeps } from '../mcpRunLog.mts';
import { fitToolResult } from './resultFit.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Draft = { userId?: unknown; appId?: unknown; version?: unknown };

export type BuilderRunDeps = { run: RunDeps; tests: TestDeps; runLog?: RunLogDeps };

type Need = 'owner' | 'editor';

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

async function builderAudit(event: string, entry: Obj, app: App, userId: string): Promise<void> {
    try {
        await nodeRequire('../../stores/userStore').logAccessAudit(
            event, 'studio_app', app.id, userId, null, { appName: app.name || null, ...entry }, app.organizationId || null,
        );
    } catch (e) {
        nodeRequire('../../telemetry/log').warn(`[studio-builder] could not record ${event}: ${(e as Error)?.message}`);
    }
}

/** The MCP deps with the builder's audit names. */
export function builderRunDeps(): BuilderRunDeps {
    const run: RunDeps = { ...defaultDeps(), audit: (entry, app, userId) => builderAudit(`studio_app_builder_run_action_${entry.dryRun ? 'dry' : 'live'}`, entry, app, userId) };
    const tests: TestDeps = { ...defaultTestDeps(), run, audit: (event, entry, app, userId) => builderAudit(event.replace('studio_app_mcp_', 'studio_app_builder_'), entry, app, userId) };
    return { run, tests };
}

/** The draft's app and caller, or the refusal. */
function draftTarget(draftWrap: unknown): { appId: string; userId: string } | Obj {
    const d = (isObject(draftWrap) ? draftWrap : {}) as Draft;
    const userId = typeof d.userId === 'string' ? d.userId : '';
    const appId = typeof d.appId === 'string' ? d.appId : '';
    if (!appId || !userId) {
        return { error: 'The app is not saved yet, so there is nothing to run.', _fixHint: 'Build the action first (app_set_action saves the app), then call this tool again.' };
    }
    return { appId, userId };
}

/** The access rule of the MCP tool, worded for the builder. Read at call time. */
async function refusal(deps: RunDeps, appId: string, userId: string, need: Need, tool: string): Promise<Obj | null> {
    let app: App | null = null;
    try { app = await deps.getApp(appId); } catch { app = null; }
    if (!app || !deps.canWrite(app, userId)) return { error: 'This app could not be read for you any more.', _fixHint: 'Reload the App Studio page; you may have lost edit access.' };
    if (need === 'owner' && app.userId !== userId) {
        return {
            error: `${tool} runs the app as its owner, so only the owner can use it: a run uses the owner's mailbox, connectors and AI budget.`,
            _fixHint: 'Check the pieces with app_dry_run instead, or ask the owner to run the test.',
        };
    }
    return null;
}

/** The MCP arguments: the model's, with the draft's app and nothing it may not choose. */
function mcpArgs(args: unknown, appId: string, keys: readonly string[]): Obj {
    const a = isObject(args) ? args : {};
    const out: Obj = { appId };
    for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
    return out;
}

/** dryRun may be left out or be true; anything else is refused before anything is read. */
export function liveRunRefusal(args: unknown): Obj | null {
    const a = isObject(args) ? args : {};
    if (!Object.hasOwn(a, 'dryRun') || a.dryRun === true || a.dryRun === undefined) return null;
    return {
        error: 'In the builder app_run_action only does a dry run: nothing is written and nothing is sent.',
        _fixHint: 'Leave dryRun out. A real run is started by the app owner from the app itself.',
    };
}

export async function builderRunAction(draftWrap: unknown, args: unknown, deps: BuilderRunDeps = builderRunDeps()): Promise<Obj> {
    const live = liveRunRefusal(args);
    if (live) return live;
    const target = draftTarget(draftWrap);
    if ('error' in target) return target;
    const denied = await refusal(deps.run, String(target.appId), String(target.userId), 'owner', 'app_run_action');
    if (denied) return denied;
    const version = (draftWrap as Draft).version;
    const call = { ...mcpArgs(args, String(target.appId), ['actionId', 'scope', 'mock']), dryRun: true, ...(Number.isInteger(version) ? { expectVersion: version } : {}) };
    return fitToolResult(await runAction(call, String(target.userId), deps.run) as Obj);
}

export async function builderSaveTest(draftWrap: unknown, args: unknown, deps: BuilderRunDeps = builderRunDeps()): Promise<Obj> {
    const target = draftTarget(draftWrap);
    if ('error' in target) return target;
    const denied = await refusal(deps.run, String(target.appId), String(target.userId), 'editor', 'app_save_test');
    if (denied) return denied;
    return fitToolResult(await saveTest(mcpArgs(args, String(target.appId), ['actionId', 'name', 'scope', 'mock', 'expect', 'remove']), String(target.userId), deps.tests));
}

export async function builderRunTests(draftWrap: unknown, args: unknown, deps: BuilderRunDeps = builderRunDeps()): Promise<Obj> {
    const target = draftTarget(draftWrap);
    if ('error' in target) return target;
    const denied = await refusal(deps.run, String(target.appId), String(target.userId), 'owner', 'app_run_tests');
    if (denied) return denied;
    return fitToolResult(await runTests(mcpArgs(args, String(target.appId), ['actionIds', 'names']), String(target.userId), deps.tests));
}

export async function builderListRuns(draftWrap: unknown, args: unknown, deps: BuilderRunDeps = builderRunDeps()): Promise<Obj> {
    const target = draftTarget(draftWrap);
    if ('error' in target) return target;
    const denied = await refusal(deps.run, String(target.appId), String(target.userId), 'editor', 'app_list_runs');
    if (denied) return denied;
    return fitToolResult(await listRuns(mcpArgs(args, String(target.appId), ['actionId', 'status', 'origin', 'user', 'since', 'limit', 'cursor']), String(target.userId), deps.runLog));
}

export async function builderGetRun(draftWrap: unknown, args: unknown, deps: BuilderRunDeps = builderRunDeps()): Promise<Obj> {
    const target = draftTarget(draftWrap);
    if ('error' in target) return target;
    const denied = await refusal(deps.run, String(target.appId), String(target.userId), 'editor', 'app_get_run');
    if (denied) return denied;
    return fitToolResult(await getRun(mcpArgs(args, String(target.appId), ['runId']), String(target.userId), deps.runLog));
}
