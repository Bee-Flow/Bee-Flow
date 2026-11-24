/**
 * A try-out that is waited for: run a plan's definition once in test mode (the automation runner's dry run, the same
 * as "Try it first", ./coworkPlanTry.mts: reads for real, AI steps for real, nothing that changes or sends leaves Bee
 * Flow) and judge how it went, as FACTS (core/cowork/plan/planTryFacts.mts). Two callers:
 *
 *   - the planner (./coworkPlanner.mts, ./coworkPlannerTry.mts) tries every draft before its owner sees it and repairs
 *     from the facts;
 *   - the automatic resolver (./coworkAutoResolve.mts) proves a fix of the wiring with it when the run that failed
 *     never reached the steps a replay would need.
 *
 * And the record of the item's last try-out (stores/coworkPlanTries.mts), which the plan card shows and approval reads.
 * What is kept is counts, the plan's titles and the plan's own sentences: never a value the try-out read.
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import type { SourceRow } from '../core/cowork/plan/planSource.mts';
import type { RecordingDeps } from '../core/cowork/replay/recordingOf.mts';
import type { CoworkPlanTries, PlanTryRecord, TryStatus } from '../stores/coworkPlanTries.mts';
import { withIsolatedScripts } from '../core/cowork/plan/planRunCopy.mts';
import { recordedStepsOf } from '../core/cowork/replay/recordingOf.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { factsOfTry, failingFacts, trySummaryOf, type TryFact, type TrySummary } from '../core/cowork/plan/planTryFacts.mts';
import { WIRING_OPTIONS } from './coworkPlanRefs.mts';

const nodeRequire = createRequire(import.meta.url);

interface Item { id: string; userId: string }
interface RunRow { id?: string; status?: string | null }

export interface TryVerdict {
    tryId: string | null;
    /** The runner's word for how it ended. */
    status: string;
    passed: boolean;
    facts: TryFact[];
    summary: TrySummary;
    /** The facts that made it fail, as plain sentences. */
    problems: string[];
}

export interface TryOutDeps {
    executeAutomation: (automation: SourceRow, opts: Record<string, unknown>) => Promise<RunRow | null | undefined>;
    recording: RecordingDeps;
    lookups: ToolLookups;
}

export function tryOutDeps(): TryOutDeps {
    const store = () => nodeRequire('../stores/automationStore') as RecordingDeps;
    const { toolLookups } = nodeRequire('../core/cowork/plan/planLookups.mts') as typeof import('../core/cowork/plan/planLookups.mts');
    return {
        executeAutomation: (a, o) => (nodeRequire('../core/automationRunner') as { executeAutomation: TryOutDeps['executeAutomation'] }).executeAutomation(a, o),
        recording: { getRun: (id) => store().getRun(id), getRunStepsForChain: (id) => store().getRunStepsForChain(id), getRunFullOutput: (r, s, a) => store().getRunFullOutput(r, s, a) },
        lookups: toolLookups(),
    };
}

const field = (f: string): string => (f ? `\`${f}\`` : 'its output');

/** One fact as the sentence its owner reads. */
export function factSentence(f: TryFact): string {
    switch (f.kind) {
        case 'step_failed': {
            const from = f.reads[0];
            if (f.errorClass === 'datetime_unresolved_input' && from) return `'${f.step}' could not read a date from ${from.from === 'the start of the run' ? from.from : `'${from.from}'`} (${field(from.field)}).`;
            return from ? `'${f.step}' failed (${f.errorClass}). It reads ${field(from.field)} from ${from.from === 'the start of the run' ? from.from : `'${from.from}'`}.` : `'${f.step}' failed (${f.errorClass}).`;
        }
        case 'list_missing': return `'${f.step}' reads ${field(f.field)} from '${f.from}' as a list, and found ${f.found === 'nothing' ? 'no such field' : `a value of the kind ${f.found}`}.`;
        case 'not_reached': return `'${f.step}' was not reached.`;
        default: return f.message;
    }
}

/** How a finished try-out went, from what it recorded. */
export function verdictOf(definition: Definition, steps: Parameters<typeof factsOfTry>[1], ended: string, lookups: ToolLookups): Omit<TryVerdict, 'tryId'> {
    const facts = factsOfTry(definition, steps, ended, lookups, WIRING_OPTIONS);
    const failing = failingFacts(facts);
    const passed = ended === 'success' && failing.length === 0;
    return { status: ended, passed, facts, summary: trySummaryOf(definition, steps, lookups), problems: (passed ? [] : facts).map(factSentence) };
}

/** Run `definition` of the item's plan automation once in test mode, wait for it, and judge it. */
export async function tryDefinition({ item, automation, definition }: { item: Item; automation: SourceRow; definition: Definition }, deps: TryOutDeps = tryOutDeps()): Promise<TryVerdict> {
    const row = await deps.executeAutomation({ ...automation, definition: withIsolatedScripts(definition) }, {
        triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: item.userId, origin: 'api',
        // Nobody answers a pause in a try-out: an approval is answered with a marked, made-up answer.
        pausesRequested: false,
    });
    if (!row?.id) return { tryId: null, status: 'error', passed: false, facts: [], summary: { reads: [], ai: 0, held: 0 }, problems: ['The try-out did not start.'] };
    const steps = await recordedStepsOf(row.id, deps.recording);
    return { tryId: row.id, ...verdictOf(definition, steps, String(row.status ?? 'error'), deps.lookups) };
}

/** What the item's try-out record says after a try-out that ended. */
export function recordFor(automationId: string, definition: Definition, verdict: Pick<TryVerdict, 'tryId' | 'passed' | 'summary' | 'problems'>, extra: { required: boolean; rounds: number }): PlanTryRecord {
    const status: TryStatus = verdict.passed ? 'passed' : 'failed';
    return { automationId, fingerprint: planFingerprint(definition), tryId: verdict.tryId, status, required: extra.required, summary: verdict.summary, problems: verdict.problems, rounds: extra.rounds, at: new Date().toISOString() };
}

/** A plan that was not tried (it still has findings, or the budget is used up), with why. */
export function untriedRecord(automationId: string, definition: Definition, problems: string[], extra: { required: boolean; rounds: number }): PlanTryRecord {
    return { automationId, fingerprint: planFingerprint(definition), tryId: null, status: 'untried', required: extra.required, summary: null, problems, rounds: extra.rounds, at: new Date().toISOString() };
}

export const planTries = (): CoworkPlanTries => (nodeRequire('../stores/coworkPlanTries.mts') as typeof import('../stores/coworkPlanTries.mts')).coworkPlanTries();
