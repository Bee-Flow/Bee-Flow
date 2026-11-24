/**
 * "Replay on last month", for one past run of a Cowork item (usecases/coworkReplay.mts runs it per past run): the
 * plan as it is now is run on what that run read, and the result is compared with the plan as it was then, on the
 * same reads.
 *
 * A replay TOUCHES NO APP. Both runs are the automation runner's dry run with `recordedReads.recordedOnly`
 * (core/automationRunner/recordedReads.mts): every write and send is simulated as in a try-out, and every read is
 * answered from the past run's recording (./recordingOf.mts). A read the recording does not have (the step is new,
 * or asks something different than then) is not read live: it hands on nothing, marked, and the replay counts it.
 *
 * The runs are pinned to that past run: its own trigger data (the `since` and `now` it ran with, ./sinceLastTime.mts),
 * the independence level it ran with and the steps it trusted, and the answers its questions got. An AI step that is
 * the same as then, reading what it read then, gives the answer it gave then; a changed one asks the model, on the
 * owner's account like a try-out.
 *
 * Not replayable: a run without an automation run (it ran as a prompt or an agent), one that followed no plan, and
 * one whose recording is gone: the run history keeps runs AUTOMATION_RUN_RETENTION_DAYS (90 by default).
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../plan/planTypes.mts';
import type { SourceRow } from '../plan/planSource.mts';
import { runCopyOf } from '../plan/planRunCopy.mts';
import { isIndependence, withAsks } from '../plan/planIndependence.mts';
import { planFingerprint } from '../plan/planPermissions.mts';
import { stepsOf } from '../plan/planWalk.mts';
import { decisionsOf, outputHashesOf, recordedReadsOf, recordedStepsOf, recordingOf, unchangedAnswersOf, type Recording, type RecordingDeps } from './recordingOf.mts';
import { compareReplay, type Comparison } from './replayCompare.mts';

const nodeRequire = createRequire(import.meta.url);
const { envInt } = nodeRequire('../../../utils/envNumber.mts') as { envInt: (name: string, d: number, b?: { min?: number }) => number };

const DAY_MS = 86_400_000;

/** How long the run history keeps a run (jobs/runRetention.js); 0 keeps them for good. */
export function retentionDays(): number {
    return envInt('AUTOMATION_RUN_RETENTION_DAYS', 90, { min: 0 });
}

export type NotReplayable = 'too_old' | 'no_plan' | 'no_automation_run' | 'not_recorded' | 'failed';
export interface ReplayVerdict {
    pastRunId: string;
    startedAt: string | null;
    verdict: Comparison['verdict'] | 'not_replayable';
    reason: NotReplayable | null;
    missingSteps: number;
    differingSteps: string[];
}

/** One past run of the item, as a replay needs it. */
export interface PastRun {
    id: string;
    startedAt: string | null;
    automationRunId: string | null;
    /** The plan as it was approved when this run started; null for a run that followed no plan. */
    planThen: Definition | null;
    independence: string | null;
    trustedSteps: string[];
}

interface RunResult { id?: string; status?: string }

export interface ReplayRunDeps extends RecordingDeps {
    executeAutomation: (automation: SourceRow, opts: Record<string, unknown>) => Promise<RunResult | null | undefined>;
    lookups: ToolLookups;
    retentionDays?: number;
    now?: () => Date;
}

/** Why this past run cannot be replayed, before anything runs; null when it may be. */
function refusalOf(past: PastRun, deps: ReplayRunDeps): NotReplayable | null {
    const days = deps.retentionDays ?? retentionDays();
    const started = past.startedAt ? Date.parse(past.startedAt) : NaN;
    if (days > 0 && Number.isFinite(started) && (deps.now?.() ?? new Date()).getTime() - started > days * DAY_MS) return 'too_old';
    if (!past.planThen) return 'no_plan';
    if (!past.automationRunId) return 'no_automation_run';
    return null;
}

/** The harness both dry runs of one past run execute under: its recording, and nothing live. */
function harnessFor(recording: Recording, planThen: Definition, definition: Definition, runCopy: Definition): Record<string, unknown> {
    const questions = stepsOf(runCopy).filter((w) => w.type === 'approval' || w.type === 'form_page').map((w) => w.id);
    return {
        source: { kind: 'run', id: recording.automationRunId },
        approvals: decisionsOf(recording),
        aiAnswers: 'live',
        recordedReads: {
            recordedOnly: true,
            byKey: recordedReadsOf(recording, planThen),
            unchanged: unchangedAnswersOf(recording, planThen, definition),
            outputHashes: outputHashesOf(recording),
            skipUpstream: questions,
        },
    };
}

/** One dry run of `definition` on the recording, as the past run ran (its level, trusted steps and trigger data). */
async function dryRunOn(definition: Definition, ctx: { item: { userId: string }; automation: SourceRow; past: PastRun; recording: Recording }, deps: ReplayRunDeps): Promise<string> {
    const { past, recording } = ctx;
    const level = isIndependence(past.independence) ? past.independence : 'on_its_own';
    const runCopy = runCopyOf(withAsks(definition, level, deps.lookups, new Set(past.trustedSteps)));
    const row = await deps.executeAutomation({ ...ctx.automation, definition: runCopy }, {
        triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: ctx.item.userId, origin: 'api',
        // Nobody answers a pause in a replay: a question gets the answer it got then.
        pausesRequested: false,
        triggerPayload: recording.triggerPayload,
        harness: harnessFor(recording, past.planThen as Definition, definition, runCopy),
    });
    if (!row?.id) throw new Error('The replay did not start.');
    return row.id;
}

const notReplayable = (past: PastRun, reason: NotReplayable): ReplayVerdict => ({
    pastRunId: past.id, startedAt: past.startedAt, verdict: 'not_replayable', reason, missingSteps: 0, differingSteps: [],
});

/** Replay the item's plan as it is now (`automation.definition`) on one past run, and say how it came out. */
export async function replayPastRun({ item, automation, past }: { item: { userId: string }; automation: SourceRow; past: PastRun }, deps: ReplayRunDeps): Promise<ReplayVerdict> {
    const refused = refusalOf(past, deps);
    if (refused) return notReplayable(past, refused);
    const recording = await recordingOf(past.automationRunId as string, deps);
    if (!recording || recording.steps.size === 0) return notReplayable(past, 'not_recorded');
    const planThen = past.planThen as Definition;
    const planNow = automation.definition as Definition;
    const ctx = { item, automation, past, recording };
    const baselineId = await dryRunOn(planThen, ctx, deps);
    // The same plan as then needs no second run: it is its own baseline.
    const candidateId = planFingerprint(planNow) === planFingerprint(planThen) ? baselineId : await dryRunOn(planNow, ctx, deps);
    const comparison = compareReplay(await recordedStepsOf(baselineId, deps), await recordedStepsOf(candidateId, deps));
    return { pastRunId: past.id, startedAt: past.startedAt, verdict: comparison.verdict, reason: null, missingSteps: comparison.missingSteps, differingSteps: comparison.differingSteps };
}
