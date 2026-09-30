/**
 * The rows of a test run's result sheet — the pure half of the web builder's
 * DryRunPanel.jsx, pinned by run.lockstep.test.ts (the three helpers are
 * evaluated from the web file's own source and run beside these):
 *
 *   - every step is named as the author knows it (its label, the flowlet's
 *     title, the humanised tool), never by its id — a flowlet's inner row
 *     `<callId>/<innerId>` finds its name by the bare suffix;
 *   - only TOP-LEVEL rows: a flowlet call's sub-steps carry a parentStepId,
 *     and the call's own row already holds what the flowlet returned;
 *   - a dry run's side effects are said, not dumped: "would notify on …",
 *     "would call …" with its arguments, and an output synthesised from a
 *     sample (because the live read failed or came back empty) is marked;
 *   - the runner's plumbing flags on a synthesised output are stripped.
 */

import { buildNameMap, friendlyStepName, nameFor, type AutomationRunStep } from '@/features/automations';
import type { DefinitionInput, Translate } from '@/features/flow-editor/model';

// The naming half lives with the run vocabulary in features/automations, whose
// run screens name steps the same way; re-exported here for the sheet and its lockstep.
export { buildNameMap, friendlyStepName, nameFor };

/** Flags the runner puts on a synthesised output; the "sample data" badge says them already. */
export const DRY_RUN_META_KEYS = ['_dryRun', '_dryRunSynthesised', '_dryRunFallback'] as const;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** The value without the runner's plumbing flags (top level only, where they are put). */
export function stripDryRunMeta(value: unknown): unknown {
    if (!isObj(value)) return value;
    if (!DRY_RUN_META_KEYS.some((k) => k in value)) return value;
    const cleaned: Obj = { ...value };
    for (const k of DRY_RUN_META_KEYS) delete cleaned[k];
    return cleaned;
}

/** Why an output is a sample: the live read failed, came back empty, or there was none. */
export type SampleReason = 'live_failed' | 'live_empty' | 'sample';

export interface RunRowModel {
    key: string;
    stepId: string;
    name: string;
    stepType: string | null;
    status: string;
    durationMs: number | null;
    sample: SampleReason | null;
    notify: { channels: string[]; title: string } | null;
    /** "Would call <tool>", with the arguments it would have sent. */
    call: { tool: string; args: unknown } | null;
    /** What to show as the output, when neither of the two above says it. */
    output: unknown;
    error: string | null;
}

function durationOf(row: AutomationRunStep): number | null {
    if (!row.startedAt || !row.finishedAt) return null;
    const ms = Date.parse(row.finishedAt) - Date.parse(row.startedAt);
    return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function sampleOf(out: Obj | null): SampleReason | null {
    if (!out?._dryRunSynthesised) return null;
    if (out._dryRunFallback === 'live_failed' || out._dryRunFallback === 'live_empty') return out._dryRunFallback;
    return 'sample';
}

function notifyOf(out: Obj | null): RunRowModel['notify'] {
    const n = out?.wouldNotify;
    if (!isObj(n)) return null;
    const channels = Array.isArray(n.channels) ? n.channels.map(String) : [];
    return { channels, title: typeof n.title === 'string' ? n.title : '' };
}

export function runRowModel(row: AutomationRunStep, index: number, names: ReadonlyMap<string, string>, t: Translate): RunRowModel {
    const out = isObj(row.output) ? row.output : null;
    const notify = notifyOf(out);
    const call = !notify && out?._dryRun ? { tool: String(out.wouldHaveCalled ?? ''), args: out.withArgs } : null;
    return {
        key: `${row.stepId || 'step'}-${row.attempts ?? index}`,
        stepId: row.stepId,
        name: nameFor(row.stepId, names, t),
        stepType: row.stepType,
        status: row.status,
        durationMs: durationOf(row),
        sample: sampleOf(out),
        notify,
        call,
        output: notify || call ? undefined : stripDryRunMeta(row.output ?? undefined),
        error: row.error,
    };
}

/** The sheet's rows: the top-level steps, in the order they ran. */
export function runRows(rows: readonly AutomationRunStep[], definition: DefinitionInput, t: Translate): RunRowModel[] {
    const names = buildNameMap(definition, t);
    return rows.filter((r) => r && !r.parentStepId).map((r, i) => runRowModel(r, i, names, t));
}
