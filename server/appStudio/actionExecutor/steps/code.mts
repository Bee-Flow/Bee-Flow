/**
 * The executor of the `code` step (componentSpecs/steps/code.js): the author's JavaScript in the
 * code sandbox of automations (automation/codeSandbox.js runCode, isolated-vm), with one bridge
 * only, ctx.log.
 *
 *   1. The inputs are resolved BEFORE the sandbox starts, by the server walk's binding resolution
 *      (runBindings.resolveRunBinding) under the row access of whoever runs the action (the
 *      step's viewer and role), so the code never reads anything that person could not read and
 *      has no identity of its own.
 *   2. The source is checked the way an automation code step is (codeStepGuard.prepareCodeRun:
 *      a syntax error or a blocking finding stops it, declared JSDoc parameters get their
 *      defaults and types), and code that reaches for ctx.http, ctx.integrations or ctx.db is
 *      refused here: an app's code step has no network, integrations or database.
 *   3. runCode with NO outward bridges (ctx.http and ctx.integrations answer an error, there is
 *      no ctx.db, ctx.secrets throws), the concurrency slot keyed by the organisation, and the
 *      sandbox's own clamp on every limit.
 *
 * The return value is the step's result (the walkers put it in vars.<resultVar>). It has no side
 * effect, so a dry run runs it for real. ctx.log lines come back as step notes on the owner's
 * own runs only (app_run_action, the owner's clicks, the mailbox hook).
 *
 * Never throws: every failure is `{ ok: false, error, code, retryable }`.
 */

import { createRequire } from 'node:module';

import { BindingRefusal, resolveRunBinding } from '../../runBindings.mts';
import type { ReadData } from '../../runBindings.mts';
import { MAX_INPUT_NAME, bridgeRefusal, isInputName } from '../../codeStepRules.mts';
import type { CodeAnalysisLike } from '../../codeStepRules.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type Limits = { cpuMs?: number; wallMs?: number };
type RunResult = { result: unknown; logs: string[] };

export type Sandbox = {
    isAvailable: () => boolean;
    runCode: (opts: { code: string; inputs: Obj; limits: Limits; bridges: Obj; mode: 'live'; concurrencyKey: string | null }) => Promise<RunResult>;
};

type Guard = { refusal: string | null; inputs: Obj; analysis: CodeAnalysisLike };

export type CodeStepDeps = {
    sandbox?: () => Sandbox;
    /** The read seam of record / records / aggregate inputs (default stepDataSource.resolveDataBinding). */
    readData?: ReadData;
    env?: Record<string, string | undefined>;
};

export type StepFailure = { ok: false; error: string; code: string; retryable: boolean };
export type StepSuccess = { ok: true; result: unknown; notes?: string[] };

/** Rows one records input reads at most (what promptContext reads for an AI step). */
export const MAX_INPUT_ROWS = 200;
/** STUDIO_APP_CODE_INPUT_KB: the resolved inputs as JSON, at most (0 = no limit). */
export const DEFAULT_INPUT_KB = 1024;
/** The sandbox's CPU ceiling (codeSandbox.js MAX_LIMITS.cpuMs). */
const MAX_CPU_MS = 10_000;
const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 300;
const MAX_ERROR_CHARS = 1000;
const MAX_INPUTS = 20;

const UNAVAILABLE = 'This server has no code sandbox (isolated-vm is not installed), so a code step cannot run here.';

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const fail = (error: string, code: string, retryable = false): StepFailure => ({ ok: false, error, code, retryable });

function defaultSandbox(): Sandbox {
    return nodeRequire('../../../automation/codeSandbox.js') as Sandbox;
}

/** STUDIO_APP_CODE_INPUT_KB as bytes: unset or not a number is the default, 0 is no limit. */
export function inputByteCap(env: Record<string, string | undefined> = process.env): number {
    const raw = env.STUDIO_APP_CODE_INPUT_KB;
    const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    const kb = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_INPUT_KB;
    return kb === 0 ? Infinity : kb * 1024;
}

/** The step's timeoutMs as the sandbox's limits: wall clock, and the CPU inside it. Absent: the sandbox defaults. */
export function limitsOf(step: Obj): Limits {
    const t = step.timeoutMs;
    if (typeof t !== 'number' || !Number.isFinite(t)) return {};
    return { wallMs: t, cpuMs: Math.min(t, MAX_CPU_MS) };
}

type Resolved = { inputs: Obj; notes: string[] } | StepFailure;

/** Every input binding resolved to a plain value, under the row access of whoever runs the action. */
export async function resolveInputs(app: App, model: unknown, step: Obj, ctx: Obj, deps: CodeStepDeps = {}): Promise<Resolved> {
    const raw = isObject(step.inputs) ? step.inputs : {};
    const entries = Object.entries(raw);
    if (entries.length > MAX_INPUTS) return fail(`A code step takes at most ${MAX_INPUTS} inputs; this one has ${entries.length}.`, 'bad_input');
    const shared = nodeRequire('../shared.js') as { buildServerScope: (c: Obj) => unknown; writeViewer: (c: Obj) => unknown };
    const scope = shared.buildServerScope(ctx);
    const reader = { viewer: shared.writeViewer(ctx), role: typeof ctx.role === 'string' ? ctx.role : null };
    const inputs: Obj = {};
    const notes: string[] = [];
    for (const [name, binding] of entries) {
        if (!isInputName(name)) return fail(`Input name ${JSON.stringify(name.slice(0, MAX_INPUT_NAME))} cannot be read as inputs.<name>: use letters, digits and _ (not starting with a digit).`, 'bad_input');
        try {
            const value = await resolveRunBinding(binding, {
                app, model, ctx, scope, maxRows: MAX_INPUT_ROWS, reader, readData: deps.readData,
                where: `inputs.${name}`, onNote: (text) => { if (notes.length < MAX_NOTES) notes.push(text); },
            });
            inputs[name] = value === undefined ? null : value;
        } catch (e) {
            if (e instanceof BindingRefusal) return fail(e.message, e.code || 'forbidden');
            throw e;
        }
    }
    return { inputs, notes };
}

function inputSize(inputs: Obj): number {
    try { return Buffer.byteLength(JSON.stringify(inputs) || '', 'utf8'); } catch { return Infinity; }
}

/** The sandbox's thrown error as the step's failure: its own sentence, a code, and whether trying again can help. */
export function sandboxFailure(e: unknown): StepFailure {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith('Code steps are busy')) return fail(message, 'code_busy', true);
    if (message.startsWith('Code step disabled')) return fail(UNAVAILABLE, 'code_unavailable');
    if (message.includes('exceeded CPU limit') || message.includes('exceeded wall-clock limit')) return fail(message, 'code_timeout');
    return fail(message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message, 'code_failed');
}

/** The owner's own run (app_run_action, the owner's click, the mailbox hook): the only one that sees ctx.log. */
function ownersRun(app: App, ctx: Obj): boolean {
    return ctx.role === 'owner' && ctx.viewerId === app.userId;
}

function notesOf(bindingNotes: string[], logs: unknown, withLogs: boolean): string[] {
    const lines = withLogs && Array.isArray(logs) ? logs.map((l) => `log: ${String(l)}`) : [];
    return [...bindingNotes, ...lines].slice(0, MAX_NOTES).map((n) => (n.length > MAX_NOTE_CHARS ? `${n.slice(0, MAX_NOTE_CHARS)}…` : n));
}

/** Checked, resolved and run. See the header for the order and why. */
export async function runCodeStep(app: App, model: unknown, step: Obj, ctx: Obj, deps: CodeStepDeps = {}): Promise<StepSuccess | StepFailure> {
    const sandbox = (deps.sandbox ?? defaultSandbox)();
    if (!sandbox.isAvailable()) return fail(UNAVAILABLE, 'code_unavailable');
    if (typeof step.code !== 'string' || !step.code.trim()) return fail('The code step has no code.', 'bad_input');
    const resolved = await resolveInputs(app, model, step, ctx, deps);
    if ('ok' in resolved) return resolved;
    const cap = inputByteCap(deps.env);
    if (inputSize(resolved.inputs) > cap) return fail(`The inputs of this code step are larger than ${Math.round(cap / 1024)} KB. Read fewer rows (a filter or a limit on the binding) or only the columns the code needs.`, 'code_input_too_large');
    const { prepareCodeRun } = nodeRequire('../../../core/automationRunner/codeStepGuard.js') as { prepareCodeRun: (s: Obj, i: Obj) => Guard };
    const guard = prepareCodeRun({ code: step.code }, resolved.inputs);
    if (guard.refusal) return fail(guard.refusal, 'code_refused');
    const bridges = bridgeRefusal(guard.analysis);
    if (bridges) return fail(bridges, 'code_refused');
    let out: RunResult;
    try {
        out = await sandbox.runCode({
            code: step.code, inputs: guard.inputs, limits: limitsOf(step), bridges: {}, mode: 'live',
            concurrencyKey: (typeof ctx.orgId === 'string' && ctx.orgId) || app.organizationId || `user:${app.userId}`,
        });
    } catch (e) {
        return sandboxFailure(e);
    }
    const notes = notesOf(resolved.notes, out.logs, ownersRun(app, ctx));
    return { ok: true, result: out.result === undefined ? null : out.result, ...(notes.length ? { notes } : {}) };
}

/** The registry's executor entry (dispatch.js fileStepHandler). */
export async function runStep(app: App, model: unknown, step: Obj, ctx: Obj): Promise<StepSuccess | StepFailure> {
    return runCodeStep(app, model, step, ctx);
}
