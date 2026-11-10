/**
 * app_run_action, the rules without I/O (mcpRunAction.mts runs the steps): which step kinds
 * run in dryRun and which for real, the send_email rule, the rate limit, the caps and the
 * trimming of what goes back to the caller. Read next to the header of mcpRunAction.mts.
 */

import { createRequire } from 'node:module';
import type { Decision } from './sequenceWalk.mts';

export type { Decision };

const nodeRequire = createRequire(import.meta.url);

export type Obj = Record<string, unknown>;
export type Step = Obj & { kind?: string };
export type RunLimits = {
    perMinute: number; budgetMs: number; maxExecuted: number;
    freePerMinute: number; maxReads: number; testsPerCall: number; testsBudgetMs: number; testsPerApp: number;
};


const { STEP_POLICY_LISTS: lists } = nodeRequire('./componentSpecs/stepRegistry.js') as {
    STEP_POLICY_LISTS: { mcpLiveKinds: readonly string[]; mcpDryRunKinds: readonly string[]; mcpMockableKinds: readonly string[]; recordWriteKinds: readonly string[] };
};
const specs = nodeRequire('./componentSpecs/actionSpecsActionKinds.js') as { DATA_MUTATING_STEP_KINDS: string[] };
const SERVER_KINDS: readonly string[] = specs.DATA_MUTATING_STEP_KINDS;
export const CONTROL_KINDS = ['condition', 'switch', 'loop'];

// Every list below is derived from the policy rows of the step catalogue (componentSpecs/stepMeta.js,
// or a kind's own registry file); a kind without an answer is in none of them.
/** Steps that run for real when dryRun is false: `mcpRun: 'run'` (what an arriving mail may run, plus delete_record: the owner asked for this run). */
const LIVE_KINDS: readonly string[] = lists.mcpLiveKinds;
/** Steps that run even in dryRun (they read, or call the model): `mcpDryRun: 'mock' | 'run'`; writeTo is stripped there. */
const DRY_RUN_KINDS: readonly string[] = lists.mcpDryRunKinds;
/** Steps a test may give a fixed answer (`mock`): `mcpDryRun: 'mock'`. */
export const MOCKABLE_KINDS: readonly string[] = lists.mcpMockableKinds;
/** Steps that write rows of an app table (`writesRecords`). */
export const RECORD_WRITES: readonly string[] = lists.recordWriteKinds;

export const MAX_LOOP_ITERATIONS = 200;
export const MAX_REPORT_STEPS = 300;
export const MAX_RESULT_CHARS = 3000;
export const MAX_ERROR_CHARS = 300;
export const MAX_SCOPE_BYTES = 64 * 1024;
const SECRET_KEY_RE = /token|secret|password|passwd|authorization|api[_-]?key|credential|cookie/i;

export const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Report-safe value: depth, size and secret-looking keys bounded. */
export function trimValue(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
    if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} chars)` : value;
    if (depth >= 4) return Array.isArray(value) ? `[list of ${value.length}]` : '[object]';
    if (Array.isArray(value)) {
        const head = value.slice(0, 10).map((v) => trimValue(v, depth + 1));
        return value.length > 10 ? [...head, `… ${value.length - 10} more`] : head;
    }
    if (isObject(value)) {
        const out: Obj = {};
        const keys = Object.keys(value);
        for (const k of keys.slice(0, 20)) out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : trimValue(value[k], depth + 1);
        if (keys.length > 20) out['…'] = `${keys.length - 20} more keys`;
        return out;
    }
    return String(value).slice(0, 100);
}

export function trimResult(value: unknown): unknown {
    const trimmed = trimValue(value);
    const text = JSON.stringify(trimmed) ?? '';
    return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (trimmed)` : trimmed;
}

export function short(v: unknown, max = 200): string | null {
    if (v === null || v === undefined) return null;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * What to do with one step. Pure. This is the whole policy:
 * the send_email guarantee lives here AND is re-checked by runGuarded right before execution.
 */
export function decideStep(step: Step, dryRun: boolean, inLoop: boolean, wouldSend?: Obj, wouldWrite?: Obj): Decision {
    const kind = String(step.kind);
    if (!SERVER_KINDS.includes(kind)) return { run: false, status: 'skipped', reason: 'client step (runs in the browser; skipped here)' };
    if (kind === 'send_email') {
        if (dryRun) return { run: false, status: 'skipped', reason: 'dryRun: send_email is never executed', result: { wouldSend: wouldSend ?? {} } };
        if (inLoop) return { run: false, status: 'refused', reason: 'send_email inside a loop is never run by app_run_action' };
        if (step.mode !== 'draft') return { run: false, status: 'refused', reason: 'send_email runs here only with mode "draft" (a draft in the mailbox); this step would send' };
        return { run: true, step: { ...step, mode: 'draft' } };
    }
    if (dryRun) {
        if (DRY_RUN_KINDS.includes(kind)) {
            if (step.writeTo === undefined) return { run: true, step };
            const { writeTo: _dropped, ...rest } = step;
            return { run: true, step: rest, note: 'dryRun: writeTo not applied, no rows written' };
        }
        if (kind === 'transaction') {
            const children = Array.isArray(step.steps) ? step.steps : [];
            const would = children.slice(0, 50).map((c) => ({ kind: isObject(c) ? short(c.kind, 40) : null, tableId: isObject(c) ? short(c.tableId) : null }));
            return { run: false, status: 'skipped', reason: `dryRun: would write ${children.length} record step(s) in one transaction; nothing is executed`, result: { wouldWrite: would } };
        }
        const verb = RECORD_WRITES.includes(kind) ? 'would write' : 'would run';
        return { run: false, status: 'skipped', reason: `dryRun: ${verb} (${kind}); nothing is executed`, result: RECORD_WRITES.includes(kind) ? { wouldWrite: { kind, tableId: short(step.tableId), ...(wouldWrite ?? {}) } } : undefined };
    }
    if (!LIVE_KINDS.includes(kind)) {
        return { run: false, status: 'refused', reason: `${kind} is not run by app_run_action (it reaches people or needs a viewer session); test it with a button click` };
    }
    return { run: true, step };
}

// ── Rate limit ──────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();
const freeWindows = new Map<string, number[]>();

function takeFrom(store: Map<string, number[]>, userId: string, now: number, perMinute: number): boolean {
    if (perMinute === 0) return true;
    const recent = (store.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= perMinute) { store.set(userId, recent); return false; }
    recent.push(now);
    store.set(userId, recent);
    return true;
}

/**
 * One PAID run for this user, or false when the per-minute budget is spent (perMinute 0 =
 * unlimited). A live run takes it up front; a dry run only when a step first reaches the
 * executor (an AI step that is not mocked), so a fully mocked test is free.
 */
export function takeRunBudget(userId: string, now: number, perMinute: number): boolean {
    return takeFrom(windows, userId, now, perMinute);
}

/**
 * The hygiene window every app_run_action / app_run_tests call takes once, mocked or not:
 * a free run still reads the database (STUDIO_MCP_RUN_ACTION_FREE_PER_MINUTE, 0 = unlimited).
 */
export function takeFreeBudget(userId: string, now: number, perMinute: number): boolean {
    return takeFrom(freeWindows, userId, now, perMinute);
}

/** Test seam. */
export function resetRunWindows(): void { windows.clear(); freeWindows.clear(); }

function intFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** The env variable behind each runtime cap, for messages that name it. */
export const LIMIT_ENV: Readonly<Record<keyof RunLimits, string>> = Object.freeze({
    perMinute: 'STUDIO_MCP_RUN_ACTION_PER_MINUTE',
    budgetMs: 'STUDIO_MCP_RUN_ACTION_BUDGET_MS',
    maxExecuted: 'STUDIO_MCP_RUN_ACTION_MAX_STEPS',
    freePerMinute: 'STUDIO_MCP_RUN_ACTION_FREE_PER_MINUTE',
    maxReads: 'STUDIO_MCP_RUN_ACTION_MAX_READS',
    testsPerCall: 'STUDIO_MCP_RUN_TESTS_MAX',
    testsBudgetMs: 'STUDIO_MCP_RUN_TESTS_BUDGET_MS',
    testsPerApp: 'STUDIO_APP_TESTS_MAX',
});

const LIMIT_DEFAULTS: Readonly<RunLimits> = Object.freeze({
    perMinute: 10, budgetMs: 120_000, maxExecuted: 500,
    freePerMinute: 120, maxReads: 500, testsPerCall: 100, testsBudgetMs: 300_000, testsPerApp: 500,
});

/**
 * Caps, read on every call (0 = unlimited): STUDIO_MCP_RUN_ACTION_PER_MINUTE 10, _BUDGET_MS 120000,
 * _MAX_STEPS 500, _FREE_PER_MINUTE 120, _MAX_READS 500; STUDIO_MCP_RUN_TESTS_MAX 100,
 * STUDIO_MCP_RUN_TESTS_BUDGET_MS 300000; STUDIO_APP_TESTS_MAX 500.
 */
export function runLimits(): RunLimits {
    const out = { ...LIMIT_DEFAULTS };
    for (const key of Object.keys(LIMIT_ENV) as Array<keyof RunLimits>) out[key] = intFromEnv(LIMIT_ENV[key], LIMIT_DEFAULTS[key]);
    return out;
}

/** "limit 10 (STUDIO_MCP_RUN_ACTION_PER_MINUTE=10)": the words every limit message uses. */
export function limitText(limits: RunLimits, key: keyof RunLimits): string {
    return `${LIMIT_ENV[key]}=${limits[key]}`;
}

// ── Scope ───────────────────────────────────────────────────────────────────

/** `params` tests a called action on its own (what call_action would pass as params.<name>). */
export type RunScope = { vars: Obj; form: Obj; item: unknown; params?: Obj };

/** What a click would have in scope: { vars?, form?, item? }, at most MAX_SCOPE_BYTES. */
export function readScope(raw: unknown): RunScope | { error: string } {
    if (raw === undefined || raw === null) return { vars: {}, form: {}, item: undefined };
    if (!isObject(raw)) return { error: 'scope must be an object { vars?, form?, item?, params? }.' };
    const bag = (v: unknown, name: string): Obj | string => {
        if (v === undefined || v === null) return {};
        if (!isObject(v)) return `scope.${name} must be an object.`;
        return v;
    };
    const vars = bag(raw.vars, 'vars');
    const form = bag(raw.form, 'form');
    const params = bag(raw.params, 'params');
    if (typeof vars === 'string') return { error: vars };
    if (typeof form === 'string') return { error: form };
    if (typeof params === 'string') return { error: params };
    if (JSON.stringify(raw).length > MAX_SCOPE_BYTES) return { error: `scope is larger than ${MAX_SCOPE_BYTES / 1024} KB.` };
    // params only when given: a saved test without it keeps its stored shape.
    return { vars: { ...vars }, form: { ...form }, item: raw.item, ...(raw.params !== undefined && raw.params !== null ? { params: { ...params } } : {}) };
}

