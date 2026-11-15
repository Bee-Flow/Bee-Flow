/**
 * windmillCompareSummary.mts: what the side-by-side comparison of a Windmill
 * import keeps of one run (PLAN B6, usecases/automation/windmillCompare.mts).
 *
 *   keyPaths(value) / shapeDiff(wm, bf)     the shape of a value as key paths, never a value
 *   counterparts(flow, storedReport)        which Bee Flow step output stands for which Windmill step
 *   summariseScenario(run, dry, steps, m)   one run's summary for the report
 *
 * Pure: no database, no network. A key that is not a plain name reads `*`, an
 * error code that is not a plain code reads `step_failed`, so neither a value
 * nor a key made of data reaches the report.
 */

import type { WindmillRun } from './windmillRemote.mts';

type Json = Record<string, any>;

// ── Shapes ───────────────────────────────────────────────────────────────

const NAME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
const MAX_DEPTH = 4;
const MAX_PATHS = 200;
/** An object with more keys than this is a map (keyed by data), not a record. */
const MAP_KEYS = 50;
const ITEMS_LOOKED_AT = 3;
const PATHS_LISTED = 20;

/** A key as it may appear in a summary: a plain name, or `*` for a key that could be data. */
function safeKey(k: string): string {
    if (!k || k.length > 64) return '*';
    for (const ch of k) if (!NAME_CHARS.includes(ch)) return '*';
    return k;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Bee Flow's markers on an output a dry run made up (core/automationRunner/blankInputs.js SIMULATED_OUTPUT_KEYS). */
export function isSimulated(output: unknown): boolean {
    return isRecord(output) && (output._dryRun === true || output._dryRunSynthesised === true);
}

/**
 * The key paths of a value: `a`, `a.b`, `list[]`, `list[].id`, `map.*`.
 * Keys starting with `_` (Bee Flow's own markers) are left out; at most
 * MAX_DEPTH levels and MAX_PATHS paths. No value is ever part of a path.
 */
export function keyPaths(value: unknown): Set<string> {
    const out = new Set<string>();
    const walk = (v: unknown, prefix: string, depth: number): void => {
        if (depth >= MAX_DEPTH || out.size >= MAX_PATHS) return;
        if (Array.isArray(v)) {
            const p = `${prefix}[]`;
            out.add(p);
            for (const item of v.slice(0, ITEMS_LOOKED_AT)) walk(item, p, depth + 1);
            return;
        }
        if (!isRecord(v)) return;
        const keys = Object.keys(v).filter((k) => !k.startsWith('_'));
        if (keys.length > MAP_KEYS) {
            const p = prefix ? `${prefix}.*` : '*';
            out.add(p);
            for (const k of keys.slice(0, ITEMS_LOOKED_AT)) walk(v[k], p, depth + 1);
            return;
        }
        for (const k of keys) {
            if (out.size >= MAX_PATHS) return;
            const p = prefix ? `${prefix}.${safeKey(k)}` : safeKey(k);
            out.add(p);
            walk(v[k], p, depth + 1);
        }
    };
    walk(value, '', 0);
    return out;
}

/** Key paths Windmill's result has and Bee Flow's output lacks (`missing`), and the other way round (`extra`). */
export function shapeDiff(windmill: unknown, beeflow: unknown): { missing: string[]; extra: string[] } {
    const wm = keyPaths(windmill);
    const bf = keyPaths(beeflow);
    return {
        missing: [...wm].filter((p) => !bf.has(p)).sort().slice(0, PATHS_LISTED),
        extra: [...bf].filter((p) => !wm.has(p)).sort().slice(0, PATHS_LISTED),
    };
}

// ── One scenario ─────────────────────────────────────────────────────────

export interface FailedStep { stepId: string; code: string }
export interface ShapeDifference { stepId: string; wmId: string; simulated: boolean; missing: string[]; extra: string[] }
export interface Saved { golden: boolean; runId: string | null; reason: string | null }

export interface ScenarioSummary {
    windmillRunId: string;
    windmillSuccess: boolean | null;
    /** The dry run's status: success | error | cancelled | not_started. */
    status: string;
    reachedEnd: boolean;
    failedSteps: FailedStep[];
    shapeDiffs: ShapeDifference[];
    saved: Saved | null;
}

export type ComparisonStatus = 'done' | 'no_runs' | 'skipped_flow_limit' | 'unauthorized' | 'unreadable' | 'budget_spent';

export interface Comparison {
    at: string;
    requested: number;
    status: ComparisonStatus;
    savedAsTests: boolean;
    scenarios: ScenarioSummary[];
}

/** An error code as a summary may hold it: a plain name, at most 64 characters. */
export function safeCode(v: unknown): string {
    if (typeof v !== 'string' || !v || v.length > 64) return 'step_failed';
    for (const ch of v) if (!NAME_CHARS.includes(ch) && ch !== '.') return 'step_failed';
    return v;
}

const safeId = (v: unknown): string => (typeof v === 'string' && v.length <= 200 ? v : '');

export interface StepRow { stepId?: unknown; status?: unknown; output?: unknown; errorInfo?: { code?: unknown } | null; errorClass?: unknown }

export interface Counterpart { stepId: string; path: string[] }

/**
 * Windmill step id → the Bee Flow step (as STORED, after the import re-keyed
 * the ids) and the path in its output that holds the same result. Only the
 * steps the converter registered with the same shape (FlowConversion.outputs);
 * the stored id is the one at the same place in the module's step list.
 */
export function counterparts(flow: Json, storedReport: Json): Map<string, Counterpart> {
    const out = new Map<string, Counterpart>();
    const modulesOf = (r: Json): Map<string, unknown[]> => new Map((Array.isArray(r?.modules) ? r.modules : [])
        .filter((m: Json) => typeof m?.wmId === 'string' && Array.isArray(m.stepIds))
        .map((m: Json) => [m.wmId as string, m.stepIds as unknown[]]));
    const converted = modulesOf(flow.report ?? {});
    const stored = modulesOf(storedReport);
    for (const o of Array.isArray(flow.outputs) ? flow.outputs : []) {
        const idx = converted.get(o?.wmId)?.indexOf(o?.stepId) ?? -1;
        const storedId = idx >= 0 ? stored.get(o.wmId)?.[idx] : undefined;
        if (typeof storedId !== 'string' || !Array.isArray(o.path)) continue;
        out.set(o.wmId, { stepId: storedId, path: o.path.map(String) });
    }
    return out;
}

function valueAt(v: unknown, path: string[]): unknown {
    let cur = v;
    for (const k of path) {
        if (!isRecord(cur) || !Object.hasOwn(cur, k)) return undefined;
        cur = cur[k];
    }
    return cur;
}

export function summariseScenario(run: WindmillRun, dry: { status?: unknown } | null, steps: StepRow[], modules: Map<string, Counterpart>): Omit<ScenarioSummary, 'saved'> {
    const status = dry && typeof dry.status === 'string' ? dry.status : 'not_started';
    const failedSteps: FailedStep[] = steps
        .filter((s) => s.status === 'error' || s.status === 'handled_error')
        .map((s) => ({ stepId: safeId(s.stepId), code: safeCode(s.errorInfo?.code ?? s.errorClass) }))
        .filter((f) => f.stepId)
        .slice(0, 50);
    const byStep = new Map<string, StepRow>();
    for (const s of steps) if (typeof s.stepId === 'string' && (s.status === 'success' || s.status === 'pinned')) byStep.set(s.stepId, s);
    const shapeDiffs: ShapeDifference[] = [];
    for (const [wmId, wmResult] of run.stepResults) {
        const counterpart = modules.get(wmId);
        const row = counterpart ? byStep.get(counterpart.stepId) : undefined;
        if (!counterpart || !row) continue;
        const d = shapeDiff(wmResult, valueAt(row.output, counterpart.path));
        if (d.missing.length || d.extra.length) shapeDiffs.push({ stepId: counterpart.stepId, wmId: safeId(wmId), simulated: isSimulated(row.output), ...d });
    }
    return {
        windmillRunId: run.id,
        windmillSuccess: run.success,
        status,
        reachedEnd: status === 'success',
        failedSteps,
        shapeDiffs: shapeDiffs.slice(0, 50),
    };
}
