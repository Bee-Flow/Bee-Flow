/**
 * "Try it first": run the plan of a Cowork item once without it changing or sending anything, and read how that
 * went, step by step (routes/coworkPlanRoutes.js, which checked the item is the caller's).
 *
 * The try-out is the automation runner's dry run: steps that only read run for real, on the owner's real data, and
 * every step that would change or send something is simulated. So the owner sees what the plan would have read this
 * morning and what it would have done with it, before approving anything.
 *
 *   - START answers as soon as the run exists, with its id and the fingerprint of the plan that is being tried; the
 *     run goes on in the background. A plan with findings is not tried (it is not a plan Cowork runs), and neither
 *     is one for an owner the runner would refuse.
 *   - READ answers the run so far: per plan step whether it ran, how long it took, and a short preview. For a step
 *     that only reads, the preview is what it got. For a step that would change or send, it is what it WOULD have
 *     sent or written (its resolved input): the draft, the row, the recipient. The simulated answer of such a step
 *     is made-up sample data and is never shown as if it were real.
 *     The runner records a loop as one step, not its body per item, so a step inside a loop goes by its loop: it has
 *     the loop's status and no preview of its own. A step the finished run never came to is 'not_reached'.
 *
 * A try-out belongs to its item: the run must be a dry run of the automation this item's plan is made from.
 */

import { createRequire } from 'node:module';
import type { Definition, Effect, StepKind, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { stepsOf } from '../core/cowork/plan/planWalk.mts';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { warn: (msg: string) => void };

interface Item { id: string; userId: string; planAutomationId?: string | null }
interface AutomationRow { id: string; userId: string; organizationId?: string | null; kind?: string | null; definition?: unknown }
interface RunRow { id?: string; automationId?: string; mode?: string; status?: string; summary?: string | null; error?: string | null; durationMs?: number | null }
interface RunStepRow { stepId: string; attempts?: number; status?: string; startedAt?: string | null; finishedAt?: string | null; input?: unknown; output?: unknown; error?: string | null }

export interface TryDeps {
    getAutomation: (id: string) => Promise<AutomationRow | null>;
    ownerRefusal: (owner: { userId: string; organizationId?: string | null }) => Promise<'inactive' | 'not_entitled' | null>;
    executeAutomation: (automation: AutomationRow, opts: Record<string, unknown>) => Promise<RunRow | null | undefined>;
    getRun: (runId: string) => Promise<RunRow | null>;
    getRunSteps: (runId: string) => Promise<RunStepRow[]>;
    lookups: ToolLookups;
}

function defaultDeps(): TryDeps {
    const store = () => nodeRequire('../stores/automationStore') as { getAutomation: TryDeps['getAutomation']; getRun: TryDeps['getRun']; getRunSteps: TryDeps['getRunSteps'] };
    return {
        getAutomation: (id) => store().getAutomation(id),
        getRun: (id) => store().getRun(id),
        getRunSteps: (id) => store().getRunSteps(id),
        ownerRefusal: (owner) => (nodeRequire('../core/automationRunner/ownerGate.mts') as { ownerRefusal: TryDeps['ownerRefusal'] }).ownerRefusal(owner),
        executeAutomation: (a, o) => (nodeRequire('../core/automationRunner') as { executeAutomation: TryDeps['executeAutomation'] }).executeAutomation(a, o),
        lookups: toolLookups(),
    };
}

/** One plan step of a try-out. */
export interface TryStep {
    id: string;
    title: string;
    kind: StepKind;
    effect: Effect;
    /** 'pending' until the run reaches it, then the runner's own status; 'not_reached' when the run ended before it. */
    status: string;
    /** 0 at the top level, 1 inside a loop: such a step runs once per item and goes by its loop's status. */
    depth: number;
    durationMs: number | null;
    /** The step would change or send something, so the try-out held it back. */
    held: boolean;
    error: string | null;
    /** What the step read (a reading step) or would have written or sent (a held step); null when there is nothing. */
    preview: string | null;
}

export interface TryState {
    tryId: string;
    status: string;
    /** The run is over: nothing more will change. */
    done: boolean;
    summary: string | null;
    error: string | null;
    durationMs: number | null;
    steps: TryStep[];
}

const PREVIEW_MAX = 600;
const RUNNING: ReadonlySet<string> = new Set(['queued', 'running']);

/** A value as a short text a person can read. */
export function previewOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else {
        try { text = JSON.stringify(value, null, 1); } catch { return null; }
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed === '{}' || trimmed === '[]') return null;
    return trimmed.length > PREVIEW_MAX ? `${trimmed.slice(0, PREVIEW_MAX)}…` : trimmed;
}

function durationOf(row: RunStepRow): number | null {
    if (!row.startedAt || !row.finishedAt) return null;
    const ms = new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The automation this item's plan is made from, when it is still the owner's. */
async function planAutomation(item: Item, deps: TryDeps): Promise<AutomationRow> {
    const automation = item.planAutomationId ? await deps.getAutomation(item.planAutomationId) : null;
    if (!automation || automation.userId !== item.userId) throw new HttpError(409, 'cowork_plan_refused', 'This item has no plan to try.');
    return automation;
}

const REFUSAL_TEXT = Object.freeze({
    inactive: 'This account can no longer run a plan.',
    not_entitled: 'A plan runs on the automation engine, and your organisation does not have automations.',
});

/** Start a try-out of the item's plan as it is now. Answers once the run exists; the run goes on by itself. */
export async function startTry({ item }: { item: Item }, deps: TryDeps = defaultDeps()): Promise<{ tryId: string; fingerprint: string }> {
    const automation = await planAutomation(item, deps);
    const definition = automation.definition as Definition;
    const findings = checkPlan(definition, deps.lookups);
    if (findings.length > 0) {
        throw new HttpError(422, 'cowork_plan_not_allowed', `This plan cannot be tried yet: ${findings[0]?.message ?? ''}`);
    }
    const refusal = await deps.ownerRefusal({ userId: item.userId, organizationId: automation.organizationId ?? null });
    if (refusal) throw new HttpError(403, 'cowork_plan_refused', REFUSAL_TEXT[refusal]);

    const tryId = await new Promise<string>((resolve, reject) => {
        // The plan that was read here is the one that is tried (a spread row with its own definition runs exactly that).
        deps.executeAutomation({ ...automation, definition }, {
            triggerKind: 'dry_run', mode: 'dry_run', startedByUserId: item.userId, origin: 'api',
            // Nobody answers a pause in a try-out: an approval is answered with a marked, made-up answer.
            pausesRequested: false,
            onRunCreated: (run: { id?: string }) => { if (run?.id) resolve(run.id); },
        }).then((row) => {
            if (row?.id) resolve(row.id);
            else reject(new Error('The try-out did not start.'));
        }).catch((e: Error) => {
            // After the id was handed out this rejects nothing: the run's own row says how it ended.
            log.warn(`[Cowork] try-out of ${item.id} ended with an error: ${e.message}`);
            reject(e);
        });
    });
    return { tryId, fingerprint: planFingerprint(definition) };
}

/** How a try-out is going, per plan step. */
export async function tryStateOf({ item, tryId }: { item: Item; tryId: string }, deps: TryDeps = defaultDeps()): Promise<TryState> {
    const automation = await planAutomation(item, deps);
    const run = await deps.getRun(tryId);
    if (!run || run.automationId !== automation.id || run.mode !== 'dry_run') {
        throw new HttpError(404, 'cowork_plan_refused', 'That try-out does not exist.');
    }
    const status = run.status ?? 'running';
    const done = !RUNNING.has(status);
    // The last attempt of each step is the one that counts.
    const last = new Map<string, RunStepRow>();
    for (const row of await deps.getRunSteps(tryId)) {
        const seen = last.get(row.stepId);
        if (!seen || (row.attempts ?? 0) >= (seen.attempts ?? 0)) last.set(row.stepId, row);
    }
    const definition = automation.definition as Definition;
    const parentOf = new Map(stepsOf(definition).map((s) => [s.id, s.parentId]));
    /** A step's own status, else its loop's; a step no row speaks for is still to come, or was never reached. */
    const statusOf = (id: string): string => {
        for (let at: string | null | undefined = id; at; at = parentOf.get(at)) {
            const row = last.get(at);
            if (row) return row.status ?? 'pending';
        }
        return done ? 'not_reached' : 'pending';
    };
    const steps = planViewOf(definition, deps.lookups).steps.map((step): TryStep => {
        const row = last.get(step.id);
        const held = step.effect !== 'reads';
        return {
            id: step.id, title: step.title, kind: step.kind, effect: step.effect,
            status: statusOf(step.id),
            depth: step.depth,
            durationMs: row ? durationOf(row) : null,
            held,
            error: row?.error ?? null,
            preview: row ? previewOf(held ? row.input : row.output) : null,
        };
    });
    return {
        tryId, status, done,
        summary: run.summary ?? null, error: run.error ?? null, durationMs: run.durationMs ?? null, steps,
    };
}
