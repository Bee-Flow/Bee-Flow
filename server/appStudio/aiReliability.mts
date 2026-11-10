/**
 * App Studio AI steps (ai_generate / ai_extract): the answer-reliability fields `temperature`,
 * `checks` and `repairRounds` (schema v3, all optional) as one specification: how canonicalize
 * keeps them, what the validator says about them and how the runner reads them.
 *
 * The check shapes and their rules ARE the automation ai_step's
 * (core/automationModel/aiStepReliability*.js): one vocabulary, one problem finder. The one
 * difference is where a `ref` / `sameCountAs` reads: an app step has no automation run, so those
 * paths start at the step's own scope roots (APP_CHECK_ROOTS) instead of trigger./steps./loop..
 *
 *   temperature   0..2; absent = the model tier's own setting (nothing is written out)
 *   checks        [{ kind, field, ... }] at most MAX_CHECKS; absent = no checks, the step is unchanged
 *   repairRounds  0..LIMITS.MAX_AI_REPAIR_ROUNDS; absent = DEFAULT_REPAIR_ROUNDS (only read with checks)
 *
 * Pure: no I/O.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Push = (code: string, path: string, message: string) => void;
type Problem = { code: string; path: string; severity: 'error' | 'warning'; message: string; hint: string };
type Finding = { code: string; severity: 'error' | 'warning'; path: string; message: string; hint: string };
type PathOptions = { roots: readonly string[]; hint: string };

/** The scope roots a check's `ref` / `sameCountAs` may read (buildServerScope roots that hold run data). */
export const APP_CHECK_ROOTS: readonly string[] = Object.freeze(['form', 'vars', 'item', 'params', 'value']);
/** Repair rounds when the step has checks and says nothing: the automation ai_step's one round. */
export const DEFAULT_REPAIR_ROUNDS = 1;

const PATH_HINT = 'A path reads this step\'s own data: form.<input>, vars.<name>, item.<field>, params.<name> or value. No {{ }}.';
export const APP_CHECK_PATHS: PathOptions = Object.freeze({ roots: APP_CHECK_ROOTS, hint: PATH_HINT });

const reliabilitySpec = () => nodeRequire('../core/automationModel/aiStepReliabilitySpec.js') as {
    AI_STEP_TEMPERATURE_MIN: number; AI_STEP_TEMPERATURE_MAX: number; MAX_CHECKS: number;
};
const limits = () => (nodeRequire('./componentSpecs/limits.js') as { LIMITS: { MAX_AI_REPAIR_ROUNDS: number } }).LIMITS;

const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// ── Canonicalize ──────────────────────────────────────────────────────────────

/**
 * `checks` as stored: a list is kept as written (a cleanup pass, not a gate: the validator names
 * what is wrong with an entry). Anything that is not a list is dropped with a note.
 */
export function cleanAiChecks(v: unknown, path: string, push: Push): unknown[] | undefined {
    if (Array.isArray(v)) return structuredClone(v);
    push('step.field_invalid', path, 'checks must be a list of { kind, field, ... } — dropped.');
    return undefined;
}

// ── Validate ──────────────────────────────────────────────────────────────────

/** Validator code of a reliability problem: `ai_step.check_invalid` → `action.ai_check_invalid`. */
function appCode(code: string): string {
    return code.startsWith('ai_step.') ? `action.ai_${code.slice('ai_step.'.length)}` : code;
}

/**
 * Every problem of a `checks` list, as validator findings at `path` (the field's own path).
 * The rules are the automation's (checkEntryProblems), with the app's path roots.
 * `draft`: a human save (validate's dataRefsAsWarnings), where a half-filled check must not
 * block the save; its problems are warnings then (the runner skips an unreadable check), and
 * errors at publish.
 */
export function aiChecksFindings(field: string, value: unknown, path: string, { draft = false }: { draft?: boolean } = {}): Finding[] {
    const { MAX_CHECKS } = reliabilitySpec();
    if (!Array.isArray(value)) {
        return [{ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be a list of checks { kind, field, ... }.`, hint: 'Pass an array, or leave the field out.' }];
    }
    if (value.length > MAX_CHECKS) {
        return [{ code: 'action.ai_check_invalid', severity: 'error', path, message: `\`${field}\` has ${value.length} checks — the maximum is ${MAX_CHECKS}.`, hint: 'Keep the checks that matter most.' }];
    }
    const { checkEntryProblems } = nodeRequire('../core/automationModel/aiStepReliabilityProblems.js') as {
        checkEntryProblems: (entry: unknown, base: string, paths: PathOptions) => Problem[];
    };
    const out: Finding[] = [];
    value.forEach((entry, i) => {
        const base = `${field}[${i}]`;
        for (const p of checkEntryProblems(entry, base, APP_CHECK_PATHS)) {
            const rest = p.path.startsWith(base) ? p.path.slice(base.length) : '';
            out.push({ code: appCode(p.code), severity: draft ? 'warning' : p.severity, path: `${path}[${i}]${rest}`, message: p.message, hint: p.hint });
        }
    });
    return out;
}

/** A `number` field (temperature): a finite number within the spec's bounds. */
export function numberFieldFinding(field: string, fs: { min?: number; max?: number }, value: unknown, path: string): Finding | null {
    const ok = typeof value === 'number' && Number.isFinite(value)
        && (fs.min === undefined || value >= fs.min) && (fs.max === undefined || value <= fs.max);
    if (ok) return null;
    const range = fs.min !== undefined && fs.max !== undefined ? ` from ${fs.min} to ${fs.max}` : '';
    return { code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be a number${range}.`, hint: field === 'temperature' ? 'Lower answers vary less between runs. Leave it out to use the model tier\'s setting.' : 'Pass a number.' };
}

type ValidationCtx = { pushE: (f: Finding) => void; pushW: (f: Finding) => void; dataRefsAsWarnings?: boolean };

/**
 * validate/actions.js validateStepField for the field types this file owns (`number`,
 * `aiChecks`); any other type is not checked here, as before.
 */
export function validateReliabilityField(field: string, fs: { type: string; min?: number; max?: number }, value: unknown, path: string, ctx: ValidationCtx): void {
    if (fs.type === 'number') {
        const f = numberFieldFinding(field, fs, value, path);
        if (f) ctx.pushE(f);
    } else if (fs.type === 'aiChecks') {
        for (const f of aiChecksFindings(field, value, path, { draft: !!ctx.dataRefsAsWarnings })) (f.severity === 'error' ? ctx.pushE : ctx.pushW)(f);
    }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export type AppReliability = {
    /** true when the step has at least one readable check: only then does anything change. */
    active: boolean;
    checks: Obj[];
    repairRounds: number;
    /** The step's own temperature; absent = the tier's. */
    temperature?: number;
};

/** The runner's view (lenient, never throws): unreadable checks are dropped, numbers clamped. */
export function readAppReliability(step: unknown): AppReliability {
    const s = isObject(step) ? step : {};
    const { normalizeAiChecks } = nodeRequire('../core/automationModel/aiStepReliability.js') as {
        normalizeAiChecks: (list: unknown, paths: PathOptions) => Obj[];
    };
    const checks = normalizeAiChecks(s.checks, APP_CHECK_PATHS);
    const r = s.repairRounds;
    const repairRounds = typeof r === 'number' && Number.isInteger(r) && r >= 0
        ? Math.min(r, limits().MAX_AI_REPAIR_ROUNDS) : DEFAULT_REPAIR_ROUNDS;
    const t = s.temperature;
    const { AI_STEP_TEMPERATURE_MIN: min, AI_STEP_TEMPERATURE_MAX: max } = reliabilitySpec();
    const temperature = typeof t === 'number' && Number.isFinite(t) ? Math.min(max, Math.max(min, t)) : undefined;
    return { active: checks.length > 0, checks, repairRounds, ...(temperature === undefined ? {} : { temperature }) };
}

/** The model with the step's temperature in its call options; the same object when the step sets none. */
export function withStepTemperature<M extends { options?: Obj | null }>(model: M, rel: AppReliability): M {
    if (rel.temperature === undefined) return model;
    return { ...model, options: { ...(model.options || {}), temperature: rel.temperature } };
}
