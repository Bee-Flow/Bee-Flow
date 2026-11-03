/**
 * app_run_action, the rules without I/O (mcpRunAction.mts runs the steps): which step kinds
 * run in dryRun and which for real, the send_email rule, the rate limit, the caps and the
 * trimming of what goes back to the caller. Read next to the header of mcpRunAction.mts.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type Obj = Record<string, unknown>;
export type Step = Obj & { kind?: string };
export type RunLimits = { perMinute: number; budgetMs: number; maxExecuted: number };


const policy = nodeRequire('./mailboxHookPolicy.mts') as { HOOK_STEP_KINDS: readonly string[] };
const specs = nodeRequire('./componentSpecs/actionSpecsActionKinds.js') as { DATA_MUTATING_STEP_KINDS: string[] };
const SERVER_KINDS: readonly string[] = specs.DATA_MUTATING_STEP_KINDS;
export const CONTROL_KINDS = ['condition', 'switch', 'loop'];

/** Steps that run for real when dryRun is false (plus delete_record: the owner asked for this run). */
const LIVE_KINDS: readonly string[] = [...policy.HOOK_STEP_KINDS, 'delete_record'];
/** Steps that run even in dryRun (they read, or call the model); writeTo is stripped there. */
const DRY_RUN_KINDS: readonly string[] = ['ai_extract', 'ai_generate', 'kb_query', 'dataset_query'];
const RECORD_WRITES: readonly string[] = ['create_record', 'update_record', 'delete_record'];

export const MAX_LOOP_ITERATIONS = 200;
export const MAX_REPORT_STEPS = 300;
export const MAX_RESULT_CHARS = 3000;
export const MAX_ERROR_CHARS = 300;
export const MAX_SCOPE_BYTES = 64 * 1024;
const SECRET_KEY_RE = /token|secret|password|passwd|authorization|api[_-]?key|credential|cookie/i;

export const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export type Decision =
    | { run: true; step: Step; note?: string }
    | { run: false; status: 'skipped' | 'refused'; reason: string; result?: unknown };

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
export function decideStep(step: Step, dryRun: boolean, inLoop: boolean, wouldSend?: Obj): Decision {
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
        const verb = RECORD_WRITES.includes(kind) ? 'would write' : 'would run';
        return { run: false, status: 'skipped', reason: `dryRun: ${verb} (${kind}); nothing is executed`, result: RECORD_WRITES.includes(kind) ? { wouldWrite: { kind, tableId: short(step.tableId) } } : undefined };
    }
    if (!LIVE_KINDS.includes(kind)) {
        return { run: false, status: 'refused', reason: `${kind} is not run by app_run_action (it reaches people or needs a viewer session); test it with a button click` };
    }
    return { run: true, step };
}

// ── Rate limit ──────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const windows = new Map<string, number[]>();

/** One run for this user, or false when the per-minute budget is spent (perMinute 0 = unlimited). */
export function takeRunBudget(userId: string, now: number, perMinute: number): boolean {
    if (perMinute === 0) return true;
    const recent = (windows.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= perMinute) { windows.set(userId, recent); return false; }
    recent.push(now);
    windows.set(userId, recent);
    return true;
}

/** Test seam. */
export function resetRunWindows(): void { windows.clear(); }

function intFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Caps, read on every call (0 = unlimited): STUDIO_MCP_RUN_ACTION_PER_MINUTE 10, _BUDGET_MS 120000, _MAX_STEPS 500. */
export function runLimits(): RunLimits {
    return {
        perMinute: intFromEnv('STUDIO_MCP_RUN_ACTION_PER_MINUTE', 10),
        budgetMs: intFromEnv('STUDIO_MCP_RUN_ACTION_BUDGET_MS', 120_000),
        maxExecuted: intFromEnv('STUDIO_MCP_RUN_ACTION_MAX_STEPS', 500),
    };
}

