/**
 * What one Cowork run did, in NAMES, OUTCOMES AND COUNTS only (core/cowork/agentScheduleRun.js stores it on the
 * run's history row, `cowork_runs.activity_json`, and Cowork shows it in the opened run).
 *
 * The run context lives on the run's message metadata (`messageMetadata.coworkRun`); the runtime notes into it:
 *
 *   - every tool call that settled (core/agentRuntime/toolRound/results.js): the tool's name, its app, and whether it
 *     ran, failed, or was refused by a policy, with the refusal as a CODE ('privacy_shield', 'guardrail',
 *     'not_offered', ...). Never the arguments, never the result: those carry mail text, names and addresses;
 *   - the skills that took part: the static ones the prompt carried (core/agentRuntime/contextBuilder.js) and the
 *     dynamic ones the model activated (core/agentRuntime/chatStream/skillActivation.js), as ids, named at the end;
 *   - the tools the run was OFFERED (core/agentRuntime/toolStackAssembly.js): the ceiling of a follow-up run, which may
 *     never be offered more than the run it continues;
 *   - a review request (`cowork_request_review`, ./reviewTool.mts).
 *
 * Every note ignores a context that is not a Cowork run, so a chat turn pays nothing.
 */

import { createRequire } from 'node:module';
import { createOutsideTextMark, holdCall, type OutsideTextMark } from './outsideTextGuard.mts';
import { withinApps } from './runApps.mts';

const nodeRequire = createRequire(import.meta.url);

/** The internal tool an agent in a Cowork run calls when a person has to decide (./reviewTool.mts). */
export const REVIEW_TOOL_NAME = 'cowork_request_review';

/** The refusal codes a stored activity may carry; anything else is stored as 'other'. */
export const REFUSAL_REASONS: ReadonlySet<string> = new Set([
    'privacy_shield', 'privacy_shield_unavailable', 'guardrail', 'not_offered',
    'needs_confirmation', 'declined', 'invalid_arguments', 'aborted', 'outside_text', 'other',
]);

export interface ReviewRequest { reason: string; question: string | null; summary: string | null }

interface ToolTally { name: string; app: string | null; ok: number; failed: number; refused: number; reasons: Set<string> }

export interface CoworkRunContext {
    kind: 'cowork_run';
    /** Tool names a follow-up run may be offered at most (null: no ceiling, an ordinary run). */
    toolCeiling: string[] | null;
    /** The apps the organisation lets run while nobody watches (./runApps.mts); null: every app. */
    appCeiling: string[] | null;
    /** Which app a whole tool belongs to (./runApps.mts by default; a test hands its own). */
    toolAppOf?: ToolAppOf;
    tools: Map<string, ToolTally>;
    staticSkills: Set<string>;
    activatedSkills: Set<string>;
    offered: Set<string>;
    review: ReviewRequest | null;
    appOf: (toolName: string) => string | null;
    /** Whether the run has read text written outside the workspace (./outsideTextGuard.mts). */
    outsideText: OutsideTextMark;
}

/** A settled tool call as the tool round hands it over (core/agentRuntime/toolRoundExecutor.js ToolCallOutcome). */
export interface ToolOutcome {
    toolName?: string;
    finalToolResult?: unknown;
    blocked?: boolean;
    policyRefused?: boolean;
    confirmPending?: boolean;
    confirmDeclined?: boolean;
    policyReason?: string;
}

export interface StoredActivity {
    tools: Array<{ name: string; app: string | null; ok: number; failed: number; refused: number; reasons: string[] }>;
    skills: Array<{ id: string; name: string; how: 'static' | 'activated' }>;
    toolCalls: number;
    /** The run read text written outside the workspace; from then on it sent nothing to other people. */
    readOutsideText?: boolean;
}

type ToolDef = { function?: { name?: unknown } | null } | null | undefined;
type ToolAppOf = (tool: ToolDef) => string | null | undefined;

function defaultAppOf(toolName: string): string | null {
    try {
        const { appIdForTool } = nodeRequire('../agentRuntime/toolPolicy/appIndex.js') as { appIdForTool: (n: string) => string | null };
        return appIdForTool(toolName);
    } catch {
        return null;
    }
}

export function createRunActivity({ toolCeiling = null, appCeiling = null, toolAppOf, appOf = defaultAppOf, startsWithOutsideText = false }: {
    toolCeiling?: string[] | null;
    appCeiling?: string[] | null;
    toolAppOf?: ToolAppOf;
    appOf?: (toolName: string) => string | null;
    /** An event started the run with its data in the prompt (./eventRun.mts): it read outside text before its first step. */
    startsWithOutsideText?: boolean;
} = {}): CoworkRunContext {
    return {
        kind: 'cowork_run',
        toolCeiling: Array.isArray(toolCeiling) ? toolCeiling.filter((n) => typeof n === 'string') : null,
        appCeiling: Array.isArray(appCeiling) ? appCeiling.filter((n) => typeof n === 'string') : null,
        ...(toolAppOf ? { toolAppOf } : {}),
        tools: new Map(),
        staticSkills: new Set(),
        activatedSkills: new Set(),
        offered: new Set(),
        review: null,
        appOf,
        outsideText: { ...createOutsideTextMark(), seen: startsWithOutsideText },
    };
}

/** The run context of a Cowork run on a turn's message metadata, or undefined for any other turn. */
export function coworkRunOf(messageMetadata: Record<string, unknown> | null | undefined): unknown {
    return messageMetadata ? messageMetadata.coworkRun : undefined;
}

/**
 * The outside-text rule for one call of a Cowork run (./outsideTextGuard.mts): the sentence the model reads when the
 * call is held, else null. Not a Cowork run, or a run a new mail started (its own allow-list): never held here.
 */
export function outsideTextRefusal(ctx: unknown, toolName: string, { mailRun = false }: { mailRun?: boolean } = {}): string | null {
    if (!isRunActivity(ctx) || mailRun) return null;
    if (!ctx.outsideText) ctx.outsideText = createOutsideTextMark();
    return holdCall(ctx.outsideText, toolName);
}

export function isRunActivity(ctx: unknown): ctx is CoworkRunContext {
    return !!ctx && typeof ctx === 'object' && (ctx as { kind?: unknown }).kind === 'cowork_run';
}

function plainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** How a settled call ended: it ran, it failed, or a policy refused it (with the code of that refusal). */
export function classifyToolOutcome(o: ToolOutcome): { outcome: 'ok' | 'failed' | 'refused'; reason: string | null } {
    if (o.policyRefused) return { outcome: 'refused', reason: 'not_offered' };
    if (o.confirmPending) return { outcome: 'refused', reason: 'needs_confirmation' };
    if (o.confirmDeclined) return { outcome: 'refused', reason: 'declined' };
    if (typeof o.policyReason === 'string' && o.policyReason) {
        return { outcome: 'refused', reason: REFUSAL_REASONS.has(o.policyReason) ? o.policyReason : 'other' };
    }
    if (o.blocked) return { outcome: 'failed', reason: null };
    const r = o.finalToolResult;
    if (plainObject(r) && (r.error || r.success === false)) return { outcome: 'failed', reason: null };
    return { outcome: 'ok', reason: null };
}

/** Count one settled call. Keeps the name, the app and the outcome; nothing of the arguments or the result. */
export function noteToolOutcome(ctx: unknown, o: ToolOutcome): void {
    if (!isRunActivity(ctx) || !o || typeof o.toolName !== 'string' || !o.toolName) return;
    const name = o.toolName.slice(0, 120);
    let tally = ctx.tools.get(name);
    if (!tally) {
        let app: string | null = null;
        try { app = ctx.appOf(name); } catch { app = null; }
        tally = { name, app: typeof app === 'string' ? app.slice(0, 120) : null, ok: 0, failed: 0, refused: 0, reasons: new Set() };
        ctx.tools.set(name, tally);
    }
    const { outcome, reason } = classifyToolOutcome(o);
    tally[outcome] += 1;
    if (reason) tally.reasons.add(reason);
}

function idsOf(ids: unknown): string[] {
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && !!id) : [];
}

export function noteStaticSkills(ctx: unknown, ids: unknown): void {
    if (!isRunActivity(ctx)) return;
    for (const id of idsOf(ids)) ctx.staticSkills.add(id);
}

export function noteActivatedSkills(ctx: unknown, ids: unknown): void {
    if (!isRunActivity(ctx)) return;
    for (const id of idsOf(ids)) ctx.activatedSkills.add(id);
}

/** Remember the names of the tools this run was offered (every point where the stack is narrowed calls this). */
export function noteOfferedTools(ctx: unknown, tools: ToolDef[]): void {
    if (!isRunActivity(ctx) || !Array.isArray(tools)) return;
    for (const t of tools) {
        const name = t?.function?.name;
        if (typeof name === 'string' && name) ctx.offered.add(name);
    }
}

export function offeredToolNames(ctx: CoworkRunContext): string[] {
    return [...ctx.offered];
}

/**
 * What a Cowork run is offered. A tool of an app the organisation does not let run while nobody watches is taken out
 * (./runApps.mts). A follow-up run is never offered a tool its original run was not: everything outside the ceiling is
 * taken out, and the review tool stays (a follow-up may ask again). No ceilings (an ordinary run): the list as given.
 */
export function applyToolCeiling<T extends ToolDef>(ctx: unknown, tools: T[]): T[] {
    if (!isRunActivity(ctx) || !Array.isArray(tools)) return tools;
    const within = withinApps(tools, ctx.appCeiling, ctx.toolAppOf);
    if (!ctx.toolCeiling) return within;
    const allowed = new Set([...ctx.toolCeiling, REVIEW_TOOL_NAME]);
    return within.filter((t) => typeof t?.function?.name === 'string' && allowed.has(t.function.name as string));
}

/** Every skill id the run noted (static and activated), for the one lookup of their names. */
export function skillIdsOf(ctx: CoworkRunContext): string[] {
    return [...new Set([...ctx.staticSkills, ...ctx.activatedSkills])];
}

/**
 * What goes on the history row. `skillNames` maps an id to the name the person sees; a skill that has no name there
 * (deleted, or not visible to the item's user) is left out rather than shown as an id.
 */
export function summariseActivity(ctx: CoworkRunContext, skillNames: Map<string, string>): StoredActivity {
    const tools = [...ctx.tools.values()].map((t) => ({ name: t.name, app: t.app, ok: t.ok, failed: t.failed, refused: t.refused, reasons: [...t.reasons].sort() }));
    const skills: StoredActivity['skills'] = [];
    for (const id of ctx.staticSkills) {
        const name = skillNames.get(id);
        if (name) skills.push({ id, name: name.slice(0, 200), how: 'static' });
    }
    for (const id of ctx.activatedSkills) {
        if (ctx.staticSkills.has(id)) continue;
        const name = skillNames.get(id);
        if (name) skills.push({ id, name: name.slice(0, 200), how: 'activated' });
    }
    const toolCalls = tools.reduce((n, t) => n + t.ok + t.failed + t.refused, 0);
    return { tools, skills, toolCalls, ...(ctx.outsideText?.seen ? { readOutsideText: true } : {}) };
}
