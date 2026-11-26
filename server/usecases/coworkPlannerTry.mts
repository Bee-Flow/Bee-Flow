/**
 * The planner tries its own plan before its owner sees it (./coworkPlanner.mts, and "make it routine", which drafts
 * through the planner with the item's past runs as hints).
 *
 * Once a draft passes the static checks (Cowork's rules, the references, the wiring: ./coworkPlanRefs.mts), it is run
 * once in test mode (./coworkPlanTryOut.mts: reads for real, AI steps for real, nothing that changes or sends leaves
 * Bee Flow). What went wrong goes back to the model as FACTS (core/cowork/plan/planTryFacts.mts: step titles, error
 * classes, the fields the plan reads, the keys an output really has; never a value), the model repairs the draft, and
 * the repaired draft is checked and tried again: at most MAX_TRY_ROUNDS try-outs. Every try-out first asks the item's
 * and the organisation's budget (core/cowork/spendGate.mts): one try-out per round, and none when the budget is used up.
 *
 * However it ends, the item keeps the outcome (stores/coworkPlanTries.mts) with `required`: the plan is approved from
 * its card only after a try-out of exactly that plan passed. A plan that never passed says honestly what still fails.
 */

import { planViewOf } from '../core/cowork/plan/planView.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { REF_FINDING } from './coworkPlanRefs.mts';
import { planReport } from './coworkPlannerPrompt.mts';
import type { Definition, PlanFinding, StepKind } from '../core/cowork/plan/planTypes.mts';
import type { SourceRow } from '../core/cowork/plan/planSource.mts';
import type { PlanTryRecord } from '../stores/coworkPlanTries.mts';
import type { DraftProgress, DraftWrap, LoopDeps, LoopInput, Message } from './coworkDraftLoop.mts';
import { draftWithin, progressSteps } from './coworkDraftLoop.mts';
import { tryReport } from '../core/cowork/plan/planTryFacts.mts';
import { recordFor, untriedRecord, type TryVerdict } from './coworkPlanTryOut.mts';

/** Try-outs the making of one plan may take. */
export const MAX_TRY_ROUNDS = 3;
/** Rounds of the model after a try-out, to repair what it found. */
export const REPAIR_ROUNDS = 4;

interface Item { id: string; userId: string; monthlyBudget?: number | null }

/** What the try rounds need besides the draft loop. */
export interface TryRoundDeps extends LoopDeps {
    /** Run the definition of the plan automation once in test mode, wait for it and judge it. */
    tryOut: (input: { item: Item; automation: SourceRow; definition: Definition; onDryRunStep?: (id: string) => void }) => Promise<TryVerdict>;
    getAutomation: (id: string) => Promise<SourceRow | null>;
    /** Throws when the item's or the organisation's budget is used up. */
    spendLeft: (item: Item) => Promise<void>;
    recordTry: (scheduleId: string, record: PlanTryRecord) => Promise<void>;
}

/** What a draft is told when a try-out found something, and what the page hears. */
export type TryProgress = DraftProgress | { phase: 'trying'; round: number; step?: { id: string; number: number; total: number; title: string; kind: StepKind; app: string | null; type: string } } | { phase: 'repairing'; round: number };

export interface TryRoundsInput {
    item: Item;
    draft: DraftWrap;
    automationId: string;
    /** The planner's conversation so far: a repair goes on with it. */
    loop: Omit<LoopInput, 'maxRounds' | 'messages'> & { messages: Message[] };
    /** The findings that stop approval (Cowork's rules, references, wiring, licence). */
    blockingOf: (def: Definition) => Promise<PlanFinding[]>;
    signal?: AbortSignal | null;
    onProgress?: (progress: TryProgress) => void;
}

export interface TriedPlan {
    status: PlanTryRecord['status'];
    summary: PlanTryRecord['summary'];
    problems: string[];
    rounds: number;
}

const tooLong = { code: 'cowork_planner_timeout', message: 'Making the plan took too long. Try again, or write a shorter brief.' };

/** One repair of the draft from the facts of a try-out, stored on the plan automation. */
async function repair(input: TryRoundsInput, report: string, round: number, deps: TryRoundDeps): Promise<boolean> {
    input.onProgress?.({ phase: 'repairing', round });
    input.loop.messages.push({ role: 'user', content: report });
    const before = planFingerprint(input.draft.def);
    await draftWithin({ ...input.loop, onProgress: undefined, maxRounds: REPAIR_ROUNDS }, input.signal, tooLong, deps);
    if (planFingerprint(input.draft.def) === before) return false;
    const stored = await deps.builder.persistDraft(input.draft, { finalize: true });
    if (stored?.error) throw new Error(`the planner could not store its repaired draft: ${stored.error}`);
    input.onProgress?.({ phase: 'drafted', round, steps: progressSteps(input.draft.def, deps.lookups) });
    return true;
}

/** Keep the outcome on the item and answer it. */
async function kept(input: TryRoundsInput, record: PlanTryRecord, deps: TryRoundDeps): Promise<TriedPlan> {
    await deps.recordTry(input.item.id, record);
    return { status: record.status, summary: record.summary, problems: record.problems, rounds: record.rounds };
}

/** Describe the step that actually started, by its position in this version of the plan. */
function testObserver(input: TryRoundsInput, round: number, deps: TryRoundDeps) {
    const publish = input.onProgress;
    if (!publish) return undefined;
    const { steps, runOrder } = planViewOf(input.draft.def, deps.lookups);
    const byId = new Map(steps.map(step => [step.id, step]));
    const positions = new Map(runOrder.map((id, index) => [id, index + 1]));
    return (id: string) => {
        const number = positions.get(id);
        const step = byId.get(id);
        if (number && step && !input.signal?.aborted) publish({ phase: 'trying', round, step: { id, number, total: runOrder.length, title: step.title, kind: step.kind, app: step.app, type: step.type } });
    };
}

/** Try the stored draft, repair it from what the try-out found, and try again; at most MAX_TRY_ROUNDS try-outs. */
export async function tryAndRepair(input: TryRoundsInput, deps: TryRoundDeps): Promise<TriedPlan> {
    const extra = (rounds: number) => ({ required: true, rounds });
    let last: TryVerdict | null = null;
    let tried = 0;
    let attemptedStaticRepair = false;
    while (tried < MAX_TRY_ROUNDS) {
        const round = tried + 1;
        input.signal?.throwIfAborted();
        const def = input.draft.def;
        const blocking = await input.blockingOf(def);
        const report = blocking.every((f) => f.code === REF_FINDING || f.code === 'step.chat_notebook') ? planReport([], blocking) : null;
        if (blocking.length && (!report || attemptedStaticRepair)) {
            return kept(input, untriedRecord(input.automationId, def, blocking.map((f) => f.message), extra(tried)), deps);
        }
        try { await deps.spendLeft(input.item); } catch (e) {
            return kept(input, untriedRecord(input.automationId, def, [`Not tried: ${(e as Error).message}`], extra(tried)), deps);
        }
        if (report) {
            attemptedStaticRepair = true;
            await repair(input, report, round, deps);
            // Revalidate the draft and check the budget again before testing it.
            continue;
        }
        const automation = await deps.getAutomation(input.automationId);
        if (!automation) return kept(input, untriedRecord(input.automationId, def, ['The plan could not be tried: its automation is gone.'], extra(tried)), deps);
        input.onProgress?.({ phase: 'trying', round });
        last = await deps.tryOut({ item: input.item, automation, definition: def, onDryRunStep: testObserver(input, round, deps) });
        tried = round;
        if (last.passed || round === MAX_TRY_ROUNDS) break;
        if (!await repair(input, tryReport(last.facts), round, deps)) break;
    }
    return kept(input, recordFor(input.automationId, input.draft.def, last as TryVerdict, extra(tried)), deps);
}
