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

const nodeRequire = createRequire(import.meta.url);

/** The internal tool an agent in a Cowork run calls when a person has to decide (./reviewTool.mts). */
export const REVIEW_TOOL_NAME = 'cowork_request_review';

/** The refusal codes a stored activity may carry; anything else is stored as 'other'. */
export const REFUSAL_REASONS: ReadonlySet<string> = new Set([
    'privacy_shield', 'privacy_shield_unavailable', 'guardrail', 'not_offered',
    'needs_confirmation', 'declined', 'invalid_arguments', 'aborted', 'other',
]);

export interface ReviewRequest { reason: string; question: string | null; summary: string | null }

interface ToolTally { name: string; app: string | null; ok: number; failed: number; refused: number; reasons: Set<string> }

export interface CoworkRunContext {
    kind: 'cowork_run';
    /** Tool names a follow-up run may be offered at most (null: no ceiling, an ordinary run). */
    toolCeiling: string[] | null;
    tools: Map<string, ToolTally>;
    staticSkills: Set<string>;
    activatedSkills: Set<string>;
    offered: Set<string>;
    review: ReviewRequest | null;
    appOf: (toolName: string) => string | null;
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
}

type ToolDef = { function?: { name?: unknown } | null } | null | undefined;

function defaultAppOf(toolName: string): string | null {
    try {
        const { appIdForTool } = nodeRequire('../agentRuntime/toolPolicy/appIndex.js') as { appIdForTool: (n: string) => string | null };
        return appIdForTool(toolName);
    } catch {
        return null;
    }
}

export function createRunActivity({ toolCeiling = null, appOf = defaultAppOf }: { toolCeiling?: string[] | null; appOf?: (toolName: string) => string | null } = {}): CoworkRunContext {
    return {
        kind: 'cowork_run',
        toolCeiling: Array.isArray(toolCeiling) ? toolCeiling.filter((n) => typeof n === 'string') : null,
        tools: new Map(),
        staticSkills: new Set(),
        activatedSkills: new Set(),
        offered: new Set(),
        review: null,
        appOf,
    };
}

/** The run context of a Cowork run on a turn's message metadata, or undefined for any other turn. */
export function coworkRunOf(messageMetadata: Record<string, unknown> | null | undefined): unknown {
    return messageMetadata ? messageMetadata.coworkRun : undefined;
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
 * A follow-up run is never offered a tool its original run was not: everything outside the ceiling is taken out.
 * The review tool stays (a follow-up may ask again). No ceiling (an ordinary run): the list as given.
 */
export function applyToolCeiling<T extends ToolDef>(ctx: unknown, tools: T[]): T[] {
    if (!isRunActivity(ctx) || !ctx.toolCeiling || !Array.isArray(tools)) return tools;
    const allowed = new Set([...ctx.toolCeiling, REVIEW_TOOL_NAME]);
    return tools.filter((t) => typeof t?.function?.name === 'string' && allowed.has(t.function.name as string));
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
    return { tools, skills, toolCalls };
}
