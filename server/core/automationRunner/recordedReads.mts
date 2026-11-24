/**
 * Recorded reads: a dry run whose reads are answered from what an earlier run read, not from the app. Cowork's
 * "replay on last month" (core/cowork/replay/replayRun.mts) runs a changed plan this way on each of an item's past
 * runs, so the owner sees whether it comes out the same before approving it.
 *
 * The dry-run harness (./testHarness.js) may carry `recordedReads`:
 *
 *   {
 *     byKey:        { [key]: output }   the integration reads of the earlier run, by recordingKey()
 *     unchanged:    { [stepId]: output } the answers of other steps that reach outside (an AI step, a GET, a table
 *                                       read), for a step that is the same in the plan as it was then
 *     outputHashes: { [stepId]: hash }   what each step of the earlier run handed on (canonicalHash of its output)
 *     skipUpstream: [stepId]             steps whose output no later step is judged by (the questions Cowork asks)
 *     recordedOnly: true                 a miss never falls through to a live read
 *   }
 *
 * An integration read is looked up by its recordingKey: the step id, the tool and the SHA-256 of its resolved input
 * in the form the run history stores it (stores/automationStore/persistedInput.mts). A hit hands on the recorded
 * output and nothing is dispatched. A miss under `recordedOnly` hands on the tool's empty shape marked
 * `{ _noRecording: true }`, and the step row records exactly that, so the comparison can say "no recording": the step
 * is new, or asks something different than then.
 *
 * Any other step that would reach outside in a dry run is answered from `unchanged` when its own definition is the
 * same as then (the caller only lists those) and every step before it handed on what it handed on then; otherwise,
 * under `recordedOnly`, it is marked as having no recording too. A plain AI step is the exception: it asks the model
 * (that is reading nothing from an app), and so does a changed one.
 *
 * Only in a dry run: ./testHarness.js hands every other mode a null harness, so a live run is never steered by this.
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { persistedInputOf } from '../../stores/automationStore/persistedInput.mts';

const nodeRequire = createRequire(import.meta.url);
const { stableStringify } = nodeRequire('../../utils/stableJson.js') as { stableStringify: (value: unknown, opts?: { undefined?: 'null' | 'drop' | 'raw' }) => string };
const { resolveDeep, bindingLogStore } = nodeRequire('../automationModel/bind') as {
    resolveDeep: (structure: unknown, runState: unknown, opts?: { allowSecrets?: boolean }) => unknown;
    bindingLogStore: { exit: <T>(fn: () => T) => T };
};
const { secretValuesFor } = nodeRequire('./shared') as { secretValuesFor: (runState: unknown) => unknown[] };
const { publicValuesFor } = nodeRequire('./publicValues') as { publicValuesFor: (runState: unknown) => unknown[] };
const { DATATABLE_WRITE_OPS, HTTP_REQUEST_WRITE_METHODS } = nodeRequire('../automationModel/constants') as {
    DATATABLE_WRITE_OPS: ReadonlySet<string>; HTTP_REQUEST_WRITE_METHODS: ReadonlySet<string>;
};

/** The mark on the output of a step that had no recording. */
export const NO_RECORDING = '_noRecording';

export interface RecordedReads {
    recordedOnly: boolean;
    byKey: Readonly<Record<string, unknown>>;
    unchanged: Readonly<Record<string, unknown>>;
    outputHashes: Readonly<Record<string, string>>;
    skipUpstream: readonly string[];
}

interface StepLike {
    id: string;
    type?: string;
    tool?: string;
    inputs?: unknown;
    forEach?: unknown;
    method?: unknown;
    op?: unknown;
    agentId?: unknown;
    allowTools?: unknown;
    tools?: unknown;
    skillIds?: unknown;
}
interface CtxLike { testHarness?: { recordedReads?: RecordedReads | null } | null; stepRecord?: { prefix?: string } | null }
interface RunStateLike { steps?: Record<string, { output?: unknown; synthesised?: boolean } | undefined> }
export interface RecordedResult { output: unknown; dryRunSynthesised?: true; dryRunFallback?: 'no_recording' }

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** A JSON copy: what a step hands on is never the harness's own (frozen) object. */
const copyOf = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** SHA-256 over a value's canonical JSON (keys sorted, undefined left out), after a JSON round trip. */
export function canonicalHash(value: unknown): string {
    return createHash('sha256').update(stableStringify(copyOf(value), { undefined: 'drop' })).digest('hex');
}

/** The key one integration read is recorded under. */
export function recordingKey(stepId: string, tool: string, persistedInput: unknown): string {
    return `${stepId}\n${tool}\n${canonicalHash(persistedInput ?? null)}`;
}

function copiedRecord(raw: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null);
    const entries = raw instanceof Map ? [...raw.entries()] : isPlainObject(raw) ? Object.entries(raw) : [];
    for (const [k, v] of entries) if (typeof k === 'string') out[k] = copyOf(v);
    return out;
}

/** The harness's recordedReads, copied and checked; null when it has none. */
export function normalizeRecordedReads(raw: unknown): RecordedReads | null {
    if (!isPlainObject(raw)) return null;
    const hashes: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(copiedRecord(raw.outputHashes))) if (typeof v === 'string') hashes[k] = v;
    return {
        recordedOnly: raw.recordedOnly === true,
        byKey: copiedRecord(raw.byKey),
        unchanged: copiedRecord(raw.unchanged),
        outputHashes: hashes,
        skipUpstream: Array.isArray(raw.skipUpstream) ? raw.skipUpstream.filter((s): s is string => typeof s === 'string') : [],
    };
}

function readsOf(ctx: CtxLike | null | undefined, mode: string): RecordedReads | null {
    return mode === 'dry_run' ? ctx?.testHarness?.recordedReads ?? null : null;
}

/** This dry run answers its reads from recordings only: nothing it does may reach an app. */
export function answersFromRecordings(ctx: CtxLike | null | undefined, mode: string): boolean {
    return readsOf(ctx, mode)?.recordedOnly === true;
}

const recordedIdOf = (ctx: CtxLike | null | undefined, step: StepLike): string => (ctx?.stepRecord?.prefix || '') + step.id;

/** The step's input as its run-step row would store it. Resolved outside the binding log: it is not the step's read. */
export function persistedInputOfStep(step: StepLike, runState: unknown): unknown {
    if (!step.inputs) return null;
    const snapshot = bindingLogStore.exit(() => resolveDeep(step.inputs, runState, { allowSecrets: false }));
    return persistedInputOf(snapshot, { secretValues: secretValuesFor(runState), publicValues: publicValuesFor(runState), toolName: step.tool ?? null });
}

function noRecording(shape: unknown): RecordedResult {
    const base = isPlainObject(shape) ? shape : {};
    return { output: { ...base, [NO_RECORDING]: true }, dryRunSynthesised: true, dryRunFallback: 'no_recording' };
}

/**
 * An integration read answered from the recording, before anything is dispatched: the recorded output, the marked
 * empty shape for a miss under `recordedOnly`, or null to go on as a dry run does (a write, or no recordings).
 */
export function recordedIntegrationRead(step: StepLike, ctx: CtxLike, runState: unknown, mode: string, { sideEffect, emptyOutput }: { sideEffect: boolean; emptyOutput: () => unknown }): RecordedResult | null {
    const reads = readsOf(ctx, mode);
    if (!reads || sideEffect) return null;
    const key = recordingKey(recordedIdOf(ctx, step), String(step.tool ?? ''), persistedInputOfStep(step, runState));
    if (has(reads.byKey, key)) return { output: copyOf(reads.byKey[key]) };
    return reads.recordedOnly ? noRecording(emptyOutput()) : null;
}

const nonEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

/** Would this step, in a dry run, read something from outside Bee Flow's own run (an app, the web, a table)? */
function readsOutside(step: StepLike): boolean {
    if (step.type === 'http_request') return !HTTP_REQUEST_WRITE_METHODS.has(String(step.method ?? 'GET').toUpperCase());
    if (step.type === 'datatable') return !DATATABLE_WRITE_OPS.has(String(step.op ?? 'find_rows'));
    if (step.type === 'kb_query_log') return true;
    // An AI step with tools, an agent or skills may call an app itself.
    if (step.type === 'ai_step') return !!step.agentId || step.allowTools === true || nonEmptyList(step.tools) || nonEmptyList(step.skillIds);
    return false;
}

const isMissing = (output: unknown): boolean => isPlainObject(output) && output[NO_RECORDING] === true;

/**
 * Every step that already ran handed on what it handed on in the recorded run. A step this dry run simulated (a
 * write) is left out: it hands on the same sample in every replay, never what the live run got back. A step that had
 * no recording is not.
 */
function upstreamSame(reads: RecordedReads, runState: RunStateLike, stepId: string): boolean {
    for (const [id, entry] of Object.entries(runState?.steps ?? {})) {
        if (id === stepId || reads.skipUpstream.includes(id)) continue;
        if (entry?.synthesised === true && !isMissing(entry.output)) continue;
        const recorded = reads.outputHashes[id];
        if (!recorded || recorded !== canonicalHash(entry?.output ?? null)) return false;
    }
    return true;
}

/**
 * Any other step that reaches outside (or asks a model), before its executor runs: the recorded answer of a step
 * that is the same as then, the marked "no recording" for one that would read from outside under `recordedOnly`, or
 * null to run the step as a dry run does. Integration actions are answered in ./execIntegrationAction.js, which knows
 * their resolved input.
 */
export function recordedStepResult(step: StepLike, ctx: CtxLike, runState: RunStateLike, mode: string): RecordedResult | null {
    const reads = readsOf(ctx, mode);
    if (!reads || step.type === 'integration_action') return null;
    const outside = readsOutside(step);
    if (!outside && step.type !== 'ai_step') return null;
    const id = recordedIdOf(ctx, step);
    if (!step.forEach && has(reads.unchanged, id) && upstreamSame(reads, runState, id)) return { output: copyOf(reads.unchanged[id]) };
    return outside && reads.recordedOnly ? noRecording(null) : null;
}
