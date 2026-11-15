/**
 * windmillCompare.mts: the side-by-side comparison of an import from a
 * standalone Windmill (PLAN B6). During the import request that read the
 * workspace with the person's token, the last N completed runs of each
 * imported flow are read, each run's input becomes the trigger payload of the
 * new draft (the converter's payload re-map), and the draft gets one DRY RUN
 * per run through the ordinary runner. Dry runs send and write nothing.
 *
 *   compareLimits()                         AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS (5) and
 *                                           AUTOMATION_IMPORT_WINDMILL_COMPARE_FLOWS (20); 0 = off / unlimited
 *   keyPaths / shapeDiff / counterparts / summariseScenario
 *                                           what is kept of one run (windmillCompareSummary.mts)
 *   compareImported(input, deps)            per imported flow: read, re-map, dry-run, summarise, store
 *
 * What is kept: in the import report (`report.comparison`) a summary per run:
 * whether the dry run reached the end, which steps failed (step id + error
 * code), which steps' output has a different shape than Windmill's result
 * (key paths only; a key that is not a plain name reads `*`), and Windmill's
 * run id. The run's input and results are customer data: they live in memory
 * for this request only, are never logged, and the dry run made from them is
 * deleted once it is summarised.
 *
 * Unless the person ticked "Save the runs as test cases": then the input is
 * scrubbed (the converter's scrubValue) BEFORE the dry run, and a dry run that
 * reached the end is kept and marked as a golden run (the existing golden-run
 * feature: run retention, the run's read access, never exported, refused on a
 * PRD stage or for a run on its starter's own connections). A dry run that did
 * not reach the end cannot be a golden run and is deleted like the others.
 *
 * The activation gate (automation/importGate.mts) is touched only through its
 * own rule: noteDryRun marks a clean dry run of the version it ran on, which
 * here is the draft as stored a moment ago.
 */

import { createRequire } from 'node:module';
import type { WindmillRun } from './windmillRemote.mts';
import { WindmillRemoteError } from './windmillRemote.mts';
import type { Comparison, ComparisonStatus, Counterpart, Saved, ScenarioSummary, StepRow } from './windmillCompareSummary.mts';
import { counterparts, safeCode, summariseScenario } from './windmillCompareSummary.mts';

export { keyPaths, shapeDiff, counterparts, summariseScenario } from './windmillCompareSummary.mts';
export type { Comparison, ComparisonStatus, ScenarioSummary } from './windmillCompareSummary.mts';

const nodeRequire = createRequire(import.meta.url);

type Json = Record<string, any>;

// ── Limits ───────────────────────────────────────────────────────────────

export interface CompareLimits {
    /** Runs compared per flow (0 = the comparison is off). Windmill lists at most 100. */
    runs: number;
    /** Flows compared in one import (0 = unlimited). */
    flows: number;
}

/** Windmill's per_page cap. */
const WINDMILL_PAGE_MAX = 100;

export function compareLimits(): CompareLimits {
    const { envInt } = nodeRequire('../../utils/envNumber.mts') as { envInt: (n: string, d: number, b?: { min?: number }) => number };
    return {
        runs: Math.min(envInt('AUTOMATION_IMPORT_WINDMILL_COMPARE_RUNS', 5, { min: 0 }), WINDMILL_PAGE_MAX),
        flows: envInt('AUTOMATION_IMPORT_WINDMILL_COMPARE_FLOWS', 20, { min: 0 }),
    };
}

// ── Per flow ─────────────────────────────────────────────────────────────

export interface CompareDeps {
    /** The runs of one flow, read on the import's own Windmill session (one byte budget). */
    fetchRuns: (flowPath: string, n: number, moduleIds: ReadonlySet<string>) => Promise<WindmillRun[]>;
    getAutomation?: (id: string) => Promise<Json | null>;
    getImport?: (automationId: string) => Promise<{ report?: Json } | null>;
    /** `onRunCreated` hands over the run id as soon as the row exists, so a run that throws is still cleaned up. */
    dryRun?: (automation: Json, triggerPayload: Record<string, unknown> | null, userId: string, onRunCreated: (run: Json) => void) => Promise<Json>;
    getRunSteps?: (runId: string) => Promise<StepRow[]>;
    deleteDryRun?: (automationId: string, runId: string) => Promise<unknown>;
    setComparison?: (automationId: string, comparison: Comparison) => Promise<unknown>;
    noteDryRun?: (automation: Json, run: Json) => Promise<void>;
    /** Keep a dry run as a golden run; answers why not when it cannot be one. */
    saveGolden?: (automation: Json, run: Json, label: string, userId: string) => Promise<Saved>;
    /** The payload normaliser of the Nextcloud trigger (triggerBus/ncPayload.mts). */
    normalise?: (event: string, payload: Record<string, unknown>) => Record<string, unknown>;
}

export interface CompareInput {
    /** The converter's flows (flowPath, payload, report) of this import. */
    flows: Json[];
    /** commitWindmill's results: which flows became which draft. */
    results: Array<{ path: string; ok: boolean; automationId?: string }>;
    limits: CompareLimits;
    saveAsTests: boolean;
    userId: string;
}

type Converter = {
    remapRunInput: (kind: string, event: string | null, input: unknown) => Record<string, unknown> | null;
    scrubValue: (value: unknown, counter: { removed: number }) => unknown;
};

const converter = (): Converter => nodeRequire('../../automation/importers/windmill/index.mts') as Converter;
const store = (): Json => nodeRequire('../../stores/automationStore') as Json;

function runnerDryRun(automation: Json, triggerPayload: Record<string, unknown> | null, userId: string, onRunCreated: (run: Json) => void): Promise<Json> {
    const runner = nodeRequire('../../core/automationRunner') as { executeAutomation: (a: Json, o: Json) => Promise<Json> };
    // The dry run of the API: nobody is asked, approvals and form pages are answered with blanks (marked).
    return runner.executeAutomation(automation, { triggerKind: 'dry_run', triggerPayload, mode: 'dry_run', startedByUserId: userId, onRunCreated });
}

const goldensMax = (): number => (nodeRequire('../../automation/mcpRunReadCaps') as { envCap: (n: string, d: number) => number }).envCap('AUTOMATION_GOLDENS_MAX', 50);

async function defaultSaveGolden(automation: Json, run: Json, label: string, userId: string): Promise<Saved> {
    if (run.status !== 'success') return { golden: false, runId: null, reason: 'golden_needs_success' };
    const { makeRunDataAccess } = nodeRequire('../../automation/testing/runDataAccess') as { makeRunDataAccess: () => { assertTestDataAllowed: (a: Json) => Promise<void>; assertCapturable: (r: Json, legs: Json[]) => Promise<void> } };
    const access = makeRunDataAccess();
    try {
        await access.assertTestDataAllowed(automation);
        await access.assertCapturable(run, [run]);
    } catch (e) {
        return { golden: false, runId: null, reason: safeCode((e as { code?: unknown }).code) };
    }
    const testing = nodeRequire('../../stores/automationTestingStore') as Json;
    const cap = goldensMax();
    if (cap > 0 && await testing.countGoldens(automation.id) >= cap) return { golden: false, runId: null, reason: 'golden_limit' };
    await testing.createGolden({ automationId: automation.id, runId: run.id, label, ignorePaths: [], createdBy: userId });
    return { golden: true, runId: String(run.id), reason: null };
}

function withDefaults(deps: CompareDeps): Required<CompareDeps> {
    return {
        fetchRuns: deps.fetchRuns,
        getAutomation: deps.getAutomation ?? ((id) => store().getAutomation(id)),
        getImport: deps.getImport ?? ((id) => store().getImportForAutomation(id)),
        dryRun: deps.dryRun ?? runnerDryRun,
        getRunSteps: deps.getRunSteps ?? ((runId) => store().getRunSteps(runId)),
        deleteDryRun: deps.deleteDryRun ?? ((automationId, runId) => store().deleteFinishedDryRun(automationId, runId)),
        setComparison: deps.setComparison ?? ((automationId, c) => store().setImportComparison(automationId, c)),
        noteDryRun: deps.noteDryRun ?? ((a, run) => (nodeRequire('../../automation/importGate.mts') as { noteDryRun: (a: Json, r: Json) => Promise<void> }).noteDryRun(a, run)),
        saveGolden: deps.saveGolden ?? defaultSaveGolden,
        normalise: deps.normalise ?? ((event, payload) => (nodeRequire('../../automation/triggerBus/ncPayload.mts') as { normaliseNextcloudPayload: (e: string, p: Json) => Json }).normaliseNextcloudPayload(event, payload)),
    };
}

const log = (): { warn: (...a: unknown[]) => void } => nodeRequire('../../telemetry/log') as { warn: (...a: unknown[]) => void };

/** The trigger payload of the draft for one Windmill run; scrubbed first when it may be kept. */
function payloadFor(flow: Json, run: WindmillRun, scrub: boolean, d: Required<CompareDeps>): Record<string, unknown> | null {
    const c = converter();
    const args = scrub ? c.scrubValue(run.args, { removed: 0 }) : run.args;
    const kind = String(flow.payload?.kind ?? 'manual');
    const event = typeof flow.payload?.event === 'string' ? flow.payload.event : null;
    const payload = c.remapRunInput(kind, event, args);
    return payload && kind === 'nextcloud' && event ? d.normalise(event, payload) : payload;
}

interface FlowAt { automation: Json; flow: Json; modules: Map<string, Counterpart> }

async function oneScenario({ automation, flow, modules }: FlowAt, run: WindmillRun, input: CompareInput, d: Required<CompareDeps>): Promise<ScenarioSummary> {
    let dry: Json | null = null;
    let createdId: string | null = null;
    try {
        dry = await d.dryRun(automation, payloadFor(flow, run, input.saveAsTests, d), input.userId, (created) => { createdId = typeof created?.id === 'string' ? created.id : null; });
    } catch (e) {
        // The code only: the message of a failed run can quote its input.
        log().warn('[automation/import/windmill] a comparison dry run did not finish:', safeCode((e as { code?: unknown }).code));
        dry = null;
    }
    const runId = dry && typeof dry.id === 'string' ? dry.id : createdId;
    let saved: Saved | null = null;
    try {
        if (!dry || !runId) return { ...summariseScenario(run, dry, [], modules), saved: null };
        const summary = summariseScenario(run, dry, await d.getRunSteps(runId), modules);
        if (summary.reachedEnd) await d.noteDryRun(automation, dry);
        if (input.saveAsTests) {
            try { saved = await d.saveGolden(automation, dry, `Windmill run ${run.id.slice(0, 8)}`, input.userId); } catch (e) {
                log().warn('[automation/import/windmill] a comparison run was not kept as a golden run:', safeCode((e as { code?: unknown }).code));
                saved = { golden: false, runId: null, reason: 'save_failed' };
            }
        }
        return { ...summary, saved };
    } finally {
        // Whatever happened above, a run that is not a golden run holds the input: it goes.
        if (runId && !saved?.golden) {
            try { await d.deleteDryRun(String(automation.id), runId); } catch (e) {
                log().warn('[automation/import/windmill] a comparison dry run was not deleted:', (e as Error).message);
            }
        }
    }
}

function stopCode(e: unknown): ComparisonStatus {
    if (e instanceof WindmillRemoteError) {
        if (e.code === 'too_large') return 'budget_spent';
        if (e.code === 'unauthorized') return 'unauthorized';
    }
    return 'unreadable';
}

/** Read, re-map, dry-run and summarise, per imported flow; the summary lands in each report. */
export async function compareImported(input: CompareInput, deps: CompareDeps): Promise<Map<string, Comparison>> {
    const d = withDefaults(deps);
    const out = new Map<string, Comparison>();
    if (input.limits.runs <= 0) return out;
    const byPath = new Map(input.flows.map((f) => [String(f.flowPath), f]));
    // A spent budget or a refused token ends the reads for the flows after it too.
    let stopped: ComparisonStatus | null = null;
    let compared = 0;
    for (const r of input.results) {
        if (!r.ok || !r.automationId) continue;
        const flow = byPath.get(r.path);
        if (!flow) continue;
        const base = { at: new Date().toISOString(), requested: input.limits.runs, savedAsTests: input.saveAsTests };
        let comparison: Comparison;
        if (stopped) comparison = { ...base, status: stopped, scenarios: [] };
        else if (input.limits.flows > 0 && compared >= input.limits.flows) comparison = { ...base, status: 'skipped_flow_limit', scenarios: [] };
        else {
            compared += 1;
            comparison = await compareFlow(r.automationId, flow, input, d, base);
            if (comparison.status === 'budget_spent' || comparison.status === 'unauthorized') stopped = comparison.status;
        }
        out.set(r.path, comparison);
        try { await d.setComparison(r.automationId, comparison); } catch (e) {
            log().warn('[automation/import/windmill] comparison not stored:', (e as Error).message);
        }
    }
    return out;
}

async function compareFlow(automationId: string, flow: Json, input: CompareInput, d: Required<CompareDeps>, base: Omit<Comparison, 'status' | 'scenarios'>): Promise<Comparison> {
    const automation = await d.getAutomation(automationId);
    const row = await d.getImport(automationId);
    if (!automation || !row) return { ...base, status: 'unreadable', scenarios: [] };
    // The STORED report: its step ids are the ones the draft really has.
    const modules = counterparts(flow, row.report ?? {});
    let runs: WindmillRun[];
    try {
        runs = await d.fetchRuns(String(flow.flowPath), input.limits.runs, new Set(modules.keys()));
    } catch (e) {
        return { ...base, status: stopCode(e), scenarios: [] };
    }
    if (!runs.length) return { ...base, status: 'no_runs', scenarios: [] };
    const scenarios: ScenarioSummary[] = [];
    for (const run of runs) scenarios.push(await oneScenario({ automation, flow, modules }, run, input, d));
    return { ...base, status: 'done', scenarios };
}
