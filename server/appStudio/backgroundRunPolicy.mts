/**
 * The rules of a background action (a sequence with `background: true`): which steps may
 * run in a server job, how a lockKey becomes the key the run table locks on, and the
 * operator's knobs. Pure: imports only the step-tree helpers and the limits.
 *
 * A background job runs on the server, so a step that needs the visitor's browser cannot run
 * in it. Three exceptions keep the common flows working:
 *   - a LEADING confirm (before any other step) is asked in the browser before the job starts;
 *   - toast and refresh are DEFERRED: the job records them and the browser replays them when
 *     the job has finished;
 *   - set_variable, condition, switch, loop and call_action are walker-native.
 * Every other client kind is refused (BACKGROUND_REFUSED_KINDS), and so is ai_browse (it
 * streams into the visitor's page).
 *
 * Readers: the validator (validate/actions.js), the runner (backgroundRun.mts re-checks at
 * start), app_run_action, the builder's set_action repair (repairRunOptions).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { childStepSlots } from '../shared/appDefinition/stepFlow.mjs';

const nodeRequire = createRequire(import.meta.url);
// Required, not imported: agent-hub's typecheck reaches this file (validate, builder tools) and refuses a `.mts` import path.
const { staleMs } = nodeRequire('../stores/studioAppData/runPolicy.mts') as { staleMs: (env?: Record<string, string | undefined>) => number };
const { STEP_POLICY_LISTS } = nodeRequire('./componentSpecs/stepRegistry.js') as {
    STEP_POLICY_LISTS: { backgroundRefusedKinds: readonly string[]; backgroundDeferredKinds: readonly string[] };
};
const { LIMITS } = nodeRequire('./componentSpecs/limits.js') as {
    LIMITS: { MAX_ACTION_DEPTH: number; MAX_CALL_DEPTH: number; MAX_LOCK_KEY_LEN: number; MAX_PROGRESS_TEXT_LEN: number; MAX_DEFERRED_EFFECTS: number };
};

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Kinds that cannot run in a server job: policy row `background: 'refuse'` (componentSpecs/stepMeta.js, or the kind's registry file). */
export const BACKGROUND_REFUSED_KINDS: readonly string[] = STEP_POLICY_LISTS.backgroundRefusedKinds;
/** Client kinds a job records and the browser replays at the end: `background: 'defer'`. */
export const BACKGROUND_DEFERRED_KINDS: readonly string[] = STEP_POLICY_LISTS.backgroundDeferredKinds;
/** The action-level fields of a background sequence. */
export const RUN_OPTION_FIELDS: readonly string[] = Object.freeze(['background', 'lockKey', 'progressVar']);

export type RunOptions = { background: boolean; lockKey: Obj | null; progressVar: string | null };
export type BackgroundProblem = { code: string; path: string; message: string; hint: string };

/** The run options of an action as written (absent = off). */
export function readRunOptions(action: unknown): RunOptions {
    if (!isObject(action) || action.kind !== 'sequence') return { background: false, lockKey: null, progressVar: null };
    return {
        background: action.background === true,
        lockKey: isObject(action.lockKey) ? action.lockKey : null,
        progressVar: typeof action.progressVar === 'string' && action.progressVar ? action.progressVar : null,
    };
}

export function isBackgroundAction(action: unknown): boolean {
    return readRunOptions(action).background;
}

/** How many confirm steps open the sequence (asked in the browser before the job starts). */
export function leadingConfirmCount(steps: unknown): number {
    const list = Array.isArray(steps) ? steps : [];
    let n = 0;
    while (n < list.length && isObject(list[n]) && (list[n] as Obj).kind === 'confirm') n += 1;
    return n;
}

const MAX_NESTING = LIMITS.MAX_ACTION_DEPTH + 1;

/**
 * Why `action` cannot run as a background job: a step of a refused kind, or a confirm that is
 * not leading, anywhere in its tree (branches, loop bodies, onError handlers) and in the actions
 * it calls (up to the call depth). `resolveCalled` gives a called action (own property), or null.
 */
export function backgroundActionProblems(action: unknown, id: string, opts: { resolveCalled?: (actionId: string) => Obj | null } = {}): BackgroundProblem[] {
    const out: BackgroundProblem[] = [];
    if (!isObject(action) || action.kind !== 'sequence') return out;
    const top = Array.isArray(action.steps) ? action.steps : [];
    const leading = leadingConfirmCount(top);
    const seen = new Set<string>([id]);
    const visit = (list: unknown, base: string, depth: number, callDepth: number, inRoot: boolean): void => {
        if (!Array.isArray(list) || depth > MAX_NESTING || out.length >= 20) return;
        list.forEach((step, i) => {
            if (!isObject(step)) return;
            const path = `${base}[${i}]`;
            const kind = String(step.kind ?? '');
            if (BACKGROUND_REFUSED_KINDS.includes(kind)) {
                out.push({
                    code: 'action.background_step_unsupported', path,
                    message: `Action "${id}" runs in the background, but ${path} is a ${kind} step, which needs the visitor's page.`,
                    hint: 'Put it in a second action on the same control (it runs right after the click), or bind the next screen to actions.<id>.result. toast and refresh are fine: they show when the job ends.',
                });
            } else if (kind === 'confirm' && !(inRoot && depth === 1 && i < leading)) {
                out.push({
                    code: 'action.background_confirm_position', path,
                    message: `Action "${id}" runs in the background; a confirm is only possible as its first step(s), before the job starts (${path} is not).`,
                    hint: 'Move the confirm to the start of the sequence.',
                });
            }
            if (kind === 'call_action' && typeof step.actionId === 'string' && callDepth < LIMITS.MAX_CALL_DEPTH && !seen.has(step.actionId)) {
                const callee = opts.resolveCalled ? opts.resolveCalled(step.actionId) : null;
                if (callee) {
                    seen.add(step.actionId);
                    const list2 = callee.kind === 'sequence' ? callee.steps : [callee];
                    visit(list2, `${path}.call.steps`, 1, callDepth + 1, false);
                }
            }
            for (const slot of childStepSlots(step)) visit(slot.steps, `${path}${slot.suffix}`, depth + 1, callDepth, inRoot);
        });
    };
    visit(top, 'steps', 1, 0, true);
    return out;
}

/** A resolved lockKey as the key the run table locks on: trimmed text, '' = no lock, long keys hashed. */
export function normaliseLockKey(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length <= LIMITS.MAX_LOCK_KEY_LEN) return text;
    return `h:${createHash('sha256').update(text).digest('hex')}`;
}

/** The progress text of a progressVar value: one line, at most MAX_PROGRESS_TEXT_LEN characters. */
export function progressText(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.MAX_PROGRESS_TEXT_LEN);
}

export const MAX_DEFERRED_EFFECTS = LIMITS.MAX_DEFERRED_EFFECTS;

// ── Operator knobs (env, read per call; 0 = unlimited) ──────────────────────

export const BACKGROUND_ENV = Object.freeze({
    maxRunMs: { env: 'STUDIO_APP_BACKGROUND_MAX_RUN_MS', fallback: 1_800_000 },
    maxSteps: { env: 'STUDIO_APP_BACKGROUND_MAX_STEPS', fallback: 5000 },
    perUser: { env: 'STUDIO_APP_BACKGROUND_PER_USER', fallback: 3 },
    perApp: { env: 'STUDIO_APP_BACKGROUND_PER_APP', fallback: 20 },
    staleMs: { env: 'STUDIO_APP_BACKGROUND_STALE_MS', fallback: 90_000 },
    resultMaxBytes: { env: 'STUDIO_APP_BACKGROUND_RESULT_MAX_BYTES', fallback: 262_144 },
});

export type BackgroundLimits = { -readonly [K in keyof typeof BACKGROUND_ENV]: number };

function intFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function backgroundLimits(env: Record<string, string | undefined> = process.env): BackgroundLimits {
    const out = {} as BackgroundLimits;
    for (const [key, { env: name, fallback }] of Object.entries(BACKGROUND_ENV)) out[key as keyof BackgroundLimits] = intFromEnv(env, name, fallback);
    // One heartbeat window with the sweep job (stores/studioAppData/runPolicy.mts); 0 keeps the default.
    out.staleMs = staleMs(env);
    return out;
}

/** `name=value` of a knob, for messages. */
export function limitLabel(limits: BackgroundLimits, key: keyof BackgroundLimits): string {
    return `${BACKGROUND_ENV[key].env}=${limits[key]}`;
}

// ── Builder repair (app_set_action) ─────────────────────────────────────────

/**
 * The unambiguous repairs of the run options before the validator: "true"/"false" read as a
 * boolean, a string lockKey read as a formula, and a bare server action that carries them
 * wrapped into a one-step sequence. Returns the (maybe new) action; notes are appended.
 */
export function repairRunOptions(action: Obj, notes: string[]): Obj {
    if (!RUN_OPTION_FIELDS.some((f) => action[f] !== undefined)) return action;
    let out = action;
    if (out.kind !== 'sequence' && typeof out.kind === 'string') {
        const opts: Obj = {};
        const step: Obj = { ...out };
        for (const f of RUN_OPTION_FIELDS) if (step[f] !== undefined) { opts[f] = step[f]; delete step[f]; }
        out = { kind: 'sequence', steps: [step], ...opts };
        notes.push(`action: a ${String(step.kind)} with ${Object.keys(opts).join('/')} read as a one-step sequence — these options belong to a sequence.`);
    }
    if (out.background === 'true' || out.background === 'false') {
        out.background = out.background === 'true';
        notes.push(`action.background: the string read as ${String(out.background)}.`);
    }
    if (typeof out.lockKey === 'string') {
        const expr = out.lockKey.trim();
        out.lockKey = { kind: 'formula', expr };
        notes.push(`action.lockKey "${expr.slice(0, 80)}" read as {kind:"formula", expr} — a lockKey is a binding.`);
    }
    return out;
}
