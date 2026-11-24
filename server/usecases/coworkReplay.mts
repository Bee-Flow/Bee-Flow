/**
 * "Replay on last month" for a Cowork item's changed plan (routes/coworkReplayRoutes.js, which checked the item is
 * the caller's): before approving, the owner sees, per past run, whether the plan as it is now comes out the same on
 * what that run read (core/cowork/replay/replayRun.mts). A replay touches no app: no live reads, no writes, no sends.
 *
 *   - START answers as soon as the replay exists, with its id, the fingerprint of the plan being replayed and how
 *     many past runs it takes (the newest `limit`, at most 50); the past runs are replayed one after the other in
 *     the background. Refused: an item without a plan, a plan with findings (it is not one Cowork runs), an owner the
 *     runner would refuse, an organisation that made Cowork read-only, and a second replay while one is running.
 *   - READ answers how far it is: the counts and, per past run, its verdict (same, differs, replayed in part with the
 *     number of steps that had no recording, or not replayable with the reason). Counts and step ids only.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';
import { licenceFindings, mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { policyOfOwner, runRefusalOf, type CoworkPolicy } from '../core/entitlements/coworkPolicy.mts';
import { replayPastRun, type PastRun, type ReplayRunDeps, type ReplayVerdict } from '../core/cowork/replay/replayRun.mts';
import type { ReplayEvent, StoredReplay, PastRunRow } from '../stores/coworkReplays.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { warn: (msg: string) => void };

interface Item { id: string; userId: string; planAutomationId?: string | null }

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export interface ReplayStore {
    beginReplay: (input: { id: string; scheduleId: string; userId: string; fingerprint: string; total: number }) => Promise<boolean>;
    addEvent: (replayId: string, event: ReplayEvent) => Promise<void>;
    finishReplay: (replayId: string, status: 'done' | 'failed') => Promise<void>;
    getReplay: (scheduleId: string, replayId: string) => Promise<{ replay: StoredReplay; events: ReplayEvent[] } | null>;
    pastRunsOf: (scheduleId: string, limit: number) => Promise<PastRunRow[]>;
}

export interface ReplayDeps {
    store: ReplayStore;
    getAutomation: (id: string) => Promise<SourceRow | null>;
    isManaged: (automation: SourceRow) => Promise<boolean>;
    mayAsk: MayAsk;
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    policyOf: (userId: string) => Promise<CoworkPolicy>;
    lookups: ToolLookups;
    /** What one past run's replay needs: the run history and the engine. */
    run: Omit<ReplayRunDeps, 'lookups'>;
    /** Where the replays go on after START answered; a test awaits them. */
    inBackground: (work: () => Promise<void>) => void;
}

/** The real wiring; a caller that only changes where the background work goes spreads it. */
export function replayDeps(): ReplayDeps {
    const automations = () => nodeRequire('../stores/automationStore') as {
        getAutomation: ReplayDeps['getAutomation'];
        getRun: ReplayRunDeps['getRun'];
        getRunStepsForChain: ReplayRunDeps['getRunStepsForChain'];
        getRunFullOutput: ReplayRunDeps['getRunFullOutput'];
    };
    return {
        store: (nodeRequire('../stores/coworkReplays.mts') as typeof import('../stores/coworkReplays.mts')).coworkReplays(),
        getAutomation: (id) => automations().getAutomation(id),
        isManaged: isManagedByStage,
        mayAsk: mayAskByLicence,
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: ReplayDeps['ownerRefusal'] }).ownerRefusal(owner),
        policyOf: (userId) => policyOfOwner(userId),
        lookups: toolLookups(),
        run: {
            getRun: (id) => automations().getRun(id),
            getRunStepsForChain: (id) => automations().getRunStepsForChain(id),
            getRunFullOutput: (runId, stepId, attempts) => automations().getRunFullOutput(runId, stepId, attempts),
            executeAutomation: (a, o) => (nodeRequire('../core/automationRunner') as { executeAutomation: ReplayRunDeps['executeAutomation'] }).executeAutomation(a, o),
        },
        inBackground: (work) => { void work(); },
    };
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a plan.',
    not_entitled: 'A plan runs on the automation engine, and your organisation does not have automations.',
});

/** The automation this item's plan is made from, when it is still the owner's. */
async function planAutomation(item: Item, deps: ReplayDeps): Promise<SourceRow> {
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!automation) throw new HttpError(409, 'cowork_replay_refused', 'This item has no plan to replay.');
    return automation;
}

/** Why this replay may not start, as the error the route answers with; nothing when it may. */
async function assertMayReplay(item: Item, automation: SourceRow, deps: ReplayDeps): Promise<void> {
    const definition = automation.definition as Definition;
    const owner = { userId: item.userId, organizationId: automation.organizationId ?? null };
    const findings = [...checkPlan(definition, deps.lookups), ...await licenceFindings(definition, owner, deps.mayAsk)];
    if (findings.length > 0) throw new HttpError(422, 'cowork_plan_not_allowed', `This plan cannot be replayed yet: ${findings[0]?.message ?? ''}`);
    const readOnly = runRefusalOf(await deps.policyOf(item.userId));
    if (readOnly) throw new HttpError(423, 'cowork_read_only', readOnly);
    const refusal = await deps.ownerRefusal(owner);
    if (refusal) throw new HttpError(403, 'cowork_plan_refused', REFUSAL_TEXT[refusal]);
}

const pastRunOf = (row: PastRunRow): PastRun => ({
    id: row.id, startedAt: row.startedAt, automationRunId: row.automationRunId,
    planThen: row.planDefinition && typeof row.planDefinition === 'object' ? row.planDefinition as Definition : null,
    independence: row.independence, trustedSteps: row.trustedSteps,
});

const eventOf = (v: ReplayVerdict): ReplayEvent => ({
    pastRunId: v.pastRunId, pastStartedAt: v.startedAt, verdict: v.verdict, reason: v.reason, missingSteps: v.missingSteps, differingSteps: v.differingSteps,
});

/** Replay every past run in turn; one that fails is not replayable, and the replay goes on with the next. */
async function replayAll(replayId: string, input: { item: Item; automation: SourceRow; past: PastRunRow[] }, deps: ReplayDeps): Promise<void> {
    const runDeps: ReplayRunDeps = { ...deps.run, lookups: deps.lookups };
    try {
        for (const row of input.past) {
            const past = pastRunOf(row);
            let verdict: ReplayVerdict;
            try {
                verdict = await replayPastRun({ item: input.item, automation: input.automation, past }, runDeps);
            } catch (e) {
                log.warn(`[Cowork] replay ${replayId}: past run ${past.id} could not be replayed: ${(e as Error).message}`);
                verdict = { pastRunId: past.id, startedAt: past.startedAt, verdict: 'not_replayable', reason: 'failed', missingSteps: 0, differingSteps: [] };
            }
            await deps.store.addEvent(replayId, eventOf(verdict));
        }
        await deps.store.finishReplay(replayId, 'done');
    } catch (e) {
        log.warn(`[Cowork] replay ${replayId} stopped: ${(e as Error).message}`);
        await deps.store.finishReplay(replayId, 'failed');
    }
}

/** Start replaying the item's plan as it is now on its newest past runs. Answers once the replay exists. */
export async function startReplay({ item, limit = DEFAULT_LIMIT }: { item: Item; limit?: number }, deps: ReplayDeps = replayDeps()): Promise<{ replayId: string; fingerprint: string; total: number }> {
    const automation = await planAutomation(item, deps);
    await assertMayReplay(item, automation, deps);
    const past = await deps.store.pastRunsOf(item.id, Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT)));
    if (past.length === 0) throw new HttpError(409, 'cowork_replay_refused', 'This item has no earlier runs to replay the plan on.');
    const fingerprint = planFingerprint(automation.definition as Definition);
    const replayId = randomUUID();
    const begun = await deps.store.beginReplay({ id: replayId, scheduleId: item.id, userId: item.userId, fingerprint, total: past.length });
    if (!begun) throw new HttpError(409, 'cowork_replay_running', 'A replay of this plan is already running. Wait until it is done.');
    // The plan that was read here is the one that is replayed, also when it changes while the replay runs.
    const frozen = { ...automation, definition: JSON.parse(JSON.stringify(automation.definition ?? null)) as unknown };
    deps.inBackground(() => replayAll(replayId, { item, automation: frozen, past }, deps));
    return { replayId, fingerprint, total: past.length };
}

export interface ReplayRunLine {
    pastRunId: string;
    startedAt: string | null;
    verdict: ReplayEvent['verdict'];
    reason: string | null;
    missingSteps: number;
    differingSteps: string[];
}

export interface ReplayState {
    replayId: string;
    status: string;
    /** Nothing more will change. */
    done: boolean;
    fingerprint: string;
    total: number;
    same: number;
    differs: number;
    partial: number;
    notReplayable: number;
    runs: ReplayRunLine[];
}

/** How a replay of this item is going. A replay of another item answers as one that does not exist. */
export async function replayStateOf({ item, replayId }: { item: Item; replayId: string }, deps: ReplayDeps = replayDeps()): Promise<ReplayState> {
    const found = await deps.store.getReplay(item.id, replayId);
    if (!found) throw new HttpError(404, 'cowork_replay_not_found', 'That replay does not exist.');
    const { replay, events } = found;
    return {
        replayId: replay.id, status: replay.status, done: replay.status !== 'running', fingerprint: replay.fingerprint,
        total: replay.total, same: replay.same, differs: replay.differs, partial: replay.partial, notReplayable: replay.notReplayable,
        runs: events.map((e) => ({ pastRunId: e.pastRunId, startedAt: e.pastStartedAt, verdict: e.verdict, reason: e.reason, missingSteps: e.missingSteps, differingSteps: e.differingSteps })),
    };
}
