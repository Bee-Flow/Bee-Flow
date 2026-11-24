/**
 * The automatic fix of a plan's WIRING (decision 0050, the order between a plan's own steps), the part that acts. Set
 * off by core/cowork/repairs/autoResolve.mts after a run of an item whose approved plan is miswired
 * (core/cowork/plan/planWiring.mts), under the same limits as the fix of a reference: the organisation's `autoFix`, not
 * read-only, no open repair, one attempt per item per day.
 *
 *   1. The deterministic fixes (core/cowork/plan/planWiringFix.mts fixWiring), judged with the builder's shapes: a
 *      step reads from the one step that has what it reads, waits for the step it reads, an AI step waits for the reads
 *      it should work on and gets their output. Every wiring finding must be answered.
 *   2. The fixed plan must reach exactly what the approved one reaches (`sameWiringReach`: the same steps, tools and
 *      inputs once the references are taken out, edges only between the plan's own steps, exactly equal permissions),
 *      and be a plan approval allows (./coworkPlan.mts draftOf: no finding).
 *   3. The proof: a replay on that run's recording when it holds what every read of the plan returned; otherwise (the
 *      run failed before it reached the reads) a try-out in test mode (./coworkPlanTryOut.mts), under the item's and
 *      the organisation's budget. Nothing may fail, every list must be found.
 *   4. Then it is approved as a new version by AUTO_FIX_APPROVER, recorded with its Undo (reason `wiring_fixed`), the
 *      trail gets `cowork.plan_wiring_fixed` with what changed (step ids) and the proof, and a scheduled item runs
 *      once more.
 *
 * Whatever does not hold falls back to a repair its owner decides (./coworkProposals.mts propose, reason
 * `wiring_broken`), with the fixed plan when there is one. The facts are step ids, titles and the findings' sentences:
 * never a value.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Definition } from '../core/cowork/plan/planTypes.mts';
import type { JudgedRun } from '../stores/coworkRunOutcomes.mts';
import type { RecordedStep } from '../core/cowork/replay/recordingOf.mts';
import type { AutoResolveDeps, ResolveOutcome } from './coworkAutoResolve.mts';
import { AUTO_FIX_APPROVER, WIRING_FIX_REASON, type ResolveItem } from '../core/cowork/repairs/autoResolve.mts';
import { WIRING_BLOCKING, wiringFindings } from '../core/cowork/plan/planWiring.mts';
import { fixWiring, sameWiringReach, type WiringChange } from '../core/cowork/plan/planWiringFix.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';
import { factsOfTry, failingFacts } from '../core/cowork/plan/planTryFacts.mts';
import { recordedStepsOf } from '../core/cowork/replay/recordingOf.mts';
import { WIRING_OPTIONS } from './coworkPlanRefs.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

interface Approved { id: string; version: number; definition: unknown; fingerprint: string }
type Proof = 'replay' | 'try_out';

/** The reads of a plan: a replay can only stand in for them when the run recorded what each returned. */
const readsOf = (definition: Definition, deps: AutoResolveDeps): string[] => planViewOf(definition, deps.lookups).steps
    .filter((s) => s.depth === 0 && s.type === 'integration_action' && s.effect === 'reads').map((s) => s.id);

async function recordedOfRun(run: JudgedRun, deps: AutoResolveDeps): Promise<Map<string, RecordedStep>> {
    if (!run.automationRunId) return new Map();
    return recordedStepsOf(run.automationRunId, deps.replay).catch(() => new Map<string, RecordedStep>());
}

/** Do these recorded steps show the fixed plan working: nothing failed, every list was found, every AI step answered? */
function holds(steps: ReadonlyMap<string, RecordedStep> | null, patched: Definition, deps: AutoResolveDeps): boolean {
    if (!steps || [...steps.values()].some((s) => s.status === 'error')) return false;
    if (failingFacts(factsOfTry(patched, steps, 'success', deps.lookups, WIRING_OPTIONS)).length > 0) return false;
    return planViewOf(patched, deps.lookups).steps.filter((s) => s.depth === 0 && s.kind === 'ai').every((s) => steps.get(s.id)?.status === 'success');
}

/** One fix of the wiring being worked out: the item, the run that set it off, the plan it followed, its automation. */
interface Case { item: ResolveItem; run: JudgedRun; approved: Approved; automation: SourceRow }

/** The proof: a replay on the run's recording when it holds every read, else a try-out. Null: not proven. */
async function prove({ item, run, approved, automation }: Case, patched: Definition, deps: AutoResolveDeps): Promise<Proof | null> {
    const recorded = await recordedOfRun(run, deps);
    const covered = readsOf(patched, deps).every((id) => recorded.get(id)?.status === 'success' && recorded.get(id)?.usable);
    if (covered && recorded.size > 0) {
        const past = { id: run.runId, startedAt: run.startedAt, automationRunId: run.automationRunId, planThen: approved.definition as Definition, independence: null, trustedSteps: [] };
        const replayed = await deps.replayOnRecording({ item, automation, past, definition: patched }, deps.replay)
            .catch((e: Error) => { log.warn(`[Cowork] ${item.id}: the wiring fix was not replayed: ${e.message}`); return null; });
        return holds(replayed, patched, deps) ? 'replay' : null;
    }
    try { await deps.spendLeft(item); } catch { return null; }
    const tried = await deps.tryOut({ item, automation, definition: patched })
        .catch((e: Error) => { log.warn(`[Cowork] ${item.id}: the wiring fix was not tried: ${e.message}`); return null; });
    return tried?.passed ? 'try_out' : null;
}

const titlesOf = (definition: Definition, deps: AutoResolveDeps): Map<string, string> => new Map(planViewOf(definition, deps.lookups).steps.map((s) => [s.id, s.title]));

/** The fallback: a repair its owner decides, with the facts of the wiring, and the fixed plan when there is one. */
async function fallBack(item: ResolveItem, run: JudgedRun, definition: Definition, patched: Definition | null, deps: AutoResolveDeps): Promise<ResolveOutcome> {
    const titles = titlesOf(definition, deps);
    const findings = wiringFindings(definition, deps.lookups, WIRING_OPTIONS).filter((f) => WIRING_BLOCKING.has(f.code))
        .map((f) => ({ stepId: f.stepId, stepTitle: titles.get(f.stepId) ?? f.stepId, message: f.message }));
    const first = findings[0];
    if (!first) return 'not_fixed';
    const base = deps.proposalDeps();
    const proposalDeps = patched ? { ...base, amend: async () => ({ definition: patched, summary: '', rounds: 0 }) } : base;
    const outcome = await deps.propose(item, { kind: 'repair', reasonCode: 'wiring_broken', stepId: first.stepId, stepTitle: first.stepTitle, facts: { kind: 'wiring', findings }, bookOn: run.runId }, proposalDeps)
        .catch((e: Error) => { log.warn(`[Cowork] ${item.id}: no repair of the wiring was proposed: ${e.message}`); return 'failed' as const; });
    return outcome === 'proposed' ? 'proposed' : 'not_fixed';
}

/** Apply the fixed plan as a new approved version, leave its record and trail entry, and run a scheduled item again. */
async function apply({ item, approved }: Case, fixed: { patched: Definition; changes: WiringChange[]; proof: Proof }, deps: AutoResolveDeps): Promise<ResolveOutcome> {
    const { patched, changes, proof } = fixed;
    const state = await deps.approveDefinition({ item, definition: patched, approvedBy: AUTO_FIX_APPROVER });
    const fingerprint = planFingerprint(patched);
    const first = changes[0] as WiringChange;
    await deps.proposals.recordAutoFix({
        id: randomUUID(), scheduleId: item.id, userId: item.userId, kind: 'repair', reasonCode: WIRING_FIX_REASON,
        stepId: first.stepId, stepTitle: titlesOf(patched, deps).get(first.stepId) ?? first.stepId, baseFingerprint: approved.fingerprint,
        definition: patched, fingerprint, widens: [], replayId: null,
    });
    await deps.audit(item, { stepId: first.stepId, version: state.approved?.version ?? null, fingerprint, proof, wiring: changes }, 'cowork.plan_wiring_fixed');
    log.info(`[Cowork] ${item.id}: the wiring of its plan was fixed by itself (${changes.length} change(s), proof: ${proof})`);
    if (item.triggerKind && item.triggerKind !== 'schedule') return 'fixed';
    await deps.rerun(item);
    return 'fixed_and_rerun';
}

/** Fix the wiring of the plan the run `run` of `item` followed, or propose a repair. */
export async function resolveWiring(item: ResolveItem, run: JudgedRun, deps: AutoResolveDeps): Promise<ResolveOutcome> {
    const approved = await deps.getApprovedPlan(item.id) as Approved | null;
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!approved || !automation || approved.id !== run.planId) return 'not_fixed';
    const definition = approved.definition as Definition;
    const fixed = fixWiring(definition, deps.lookups, WIRING_OPTIONS);
    if (!fixed || fixed.remaining.length > 0) return fallBack(item, run, definition, fixed?.definition ?? null, deps);
    const patched = fixed.definition;
    if (!sameWiringReach(definition, patched, deps.lookups)) return fallBack(item, run, definition, patched, deps);
    if ((await deps.judge({ ...automation, definition: patched }, item)).findings.length > 0) return fallBack(item, run, definition, patched, deps);
    const c: Case = { item, run, approved, automation };
    const proof = await prove(c, patched, deps);
    if (!proof) return fallBack(item, run, definition, patched, deps);
    try {
        return await apply(c, { patched, changes: fixed.changes, proof }, deps);
    } catch (e) {
        log.warn(`[Cowork] ${item.id}: the wiring fix was not applied: ${(e as Error).message}`);
        return fallBack(item, run, definition, patched, deps);
    }
}
