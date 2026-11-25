/**
 * The apps a Cowork run may use while nobody watches: the organisation's `unattendedApps`
 * (core/entitlements/coworkPolicy.mts), for the runs that are no plan. A prompt run (core/aiTaskRunner.js) filters the
 * tools it loads; an agent run (./agentScheduleRun.js) carries the list on its run context, and ./runActivity.mts
 * filters every tool list the agent is offered, including the ones a skill brings mid-turn. A plan run checks its own
 * plan before it starts (./planRun.mts).
 *
 * executeCowork (./coworkRunner.js) reads the policy once per run and puts the list on the task as `unattendedApps`,
 * so no runner reads it again. null is every app.
 *
 * A tool that belongs to no app (web search, a reminder, the review tool) stays. An MCP server or a custom integration
 * is an app of its own (`mcp:<id>`, `custom:<id>`) and needs its own line on the list. When this process cannot tell
 * which app a tool belongs to, a list closes everything but the tools that are always safe: the policy never stops
 * counting because the registry had a bad moment.
 */

import { createRequire } from 'node:module';
import { canonicalIntegrationId } from '../integrations/integrationIdAliases.mts';

const nodeRequire = createRequire(import.meta.url);

type Tool = { function?: { name?: unknown } | null } | null | undefined;

interface AppIndex { appIdForToolDef: (tool: unknown) => string | null; isAttributionAvailable: () => boolean }
const appIndex = (): AppIndex => nodeRequire('../agentRuntime/toolPolicy/appIndex.js') as AppIndex;

/** Tools that touch no app and are kept even when nothing can be attributed. */
const ALWAYS_SAFE: ReadonlySet<string> = new Set(['cowork_request_review']);

/** The app a tool belongs to, or null; undefined when this process cannot tell. */
function defaultAppOf(tool: Tool): string | null | undefined {
    try {
        const index = appIndex();
        if (!index.isAttributionAvailable()) return undefined;
        return index.appIdForToolDef(tool);
    } catch {
        return undefined;
    }
}

const nameOf = (tool: Tool): string => (typeof tool?.function?.name === 'string' ? tool.function.name : '');

/**
 * The tools of `tools` a run may use under `apps` (null: all of them). A tool of no app stays, a tool of an app on the
 * list stays, anything else goes.
 */
export function withinApps<T extends Tool>(tools: T[], apps: readonly string[] | null | undefined, appOf: (tool: Tool) => string | null | undefined = defaultAppOf): T[] {
    if (!Array.isArray(apps) || !Array.isArray(tools)) return tools;
    const allowed = new Set(apps.map(canonicalIntegrationId));
    return tools.filter((tool) => {
        if (ALWAYS_SAFE.has(nameOf(tool))) return true;
        const app = appOf(tool);
        if (app === undefined) return false;
        return app === null || allowed.has(canonicalIntegrationId(app));
    });
}

/** The apps whose tools `withinApps` took out, for the run's log. */
export function appsLeftOut(tools: Tool[], apps: readonly string[] | null | undefined, appOf: (tool: Tool) => string | null | undefined = defaultAppOf): string[] {
    if (!Array.isArray(apps) || !Array.isArray(tools)) return [];
    const kept = new Set(withinApps(tools, apps, appOf));
    return [...new Set(tools.filter((t) => !kept.has(t)).map((t) => appOf(t) ?? 'unknown'))].sort();
}

/** The list a run carries (executeCowork put it there), or null. */
export function appsOfRun(task: { unattendedApps?: unknown } | null | undefined): string[] | null {
    const apps = task?.unattendedApps;
    return Array.isArray(apps) ? apps.filter((a): a is string => typeof a === 'string') : null;
}

/** A prompt run's tools under its list (core/aiTaskRunner.js). */
export function withinRunApps<T extends Tool>(task: { unattendedApps?: unknown } | null | undefined, tools: T[]): T[] {
    return withinApps(tools, appsOfRun(task));
}
