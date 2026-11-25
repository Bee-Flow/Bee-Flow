/**
 * What the last test of an item's plan produced, for its owner before the first approval (routes/coworkPlanRoutes.js
 * GET /:id/plan, which checked the item is the caller's): "This is what you would have received".
 *
 * Read from the try-out the item keeps as its last one (stores/coworkPlanTries.mts), and only when that try-out
 * passed and tried exactly the plan of the moment (the same automation, the same fingerprint): what other steps
 * produced says nothing about these. The run must be a dry run of that automation, as for any try-out
 * (./coworkPlanTry.mts).
 *
 *   - A plan that ends in a result for its owner: the message that step would have delivered, its title and its text.
 *   - Else the last step that would have sent something: the text that went into it.
 *   - Else nothing: the plan sends nothing, so there is nothing its owner would have received.
 *
 * The text is the owner's own data, read from the steps as the runner recorded them. Nothing is kept here, and the
 * try-out record itself still holds counts and titles only.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanStep, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { lastAttempts, longestText, messageOf, type RunStepRow } from '../core/cowork/plan/planTrace.mts';
import { planFingerprint } from '../core/cowork/plan/planPermissions.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { isManagedByStage, planSourceOf, type SourceRow } from '../core/cowork/plan/planSource.mts';
import type { PlanTryRecord } from '../stores/coworkPlanTries.mts';
import { parseJsonText } from '../shared/expr/path.mjs';

const nodeRequire = createRequire(import.meta.url);

interface Item { id: string; userId: string; planAutomationId?: string | null }
interface RunRow { automationId?: string; mode?: string }

export interface TriedResultDeps {
    getAutomation: (id: string) => Promise<SourceRow | null>;
    isManaged: (automation: SourceRow) => Promise<boolean>;
    getRun: (runId: string) => Promise<RunRow | null>;
    getRunSteps: (runId: string) => Promise<RunStepRow[]>;
    getPlanTry: (scheduleId: string) => Promise<PlanTryRecord | null>;
    lookups: ToolLookups;
}

function defaultDeps(): TriedResultDeps {
    const store = () => nodeRequire('../stores/automationStore') as Pick<TriedResultDeps, 'getAutomation' | 'getRun' | 'getRunSteps'>;
    return {
        getAutomation: (id) => store().getAutomation(id),
        getRun: (id) => store().getRun(id),
        getRunSteps: (id) => store().getRunSteps(id),
        isManaged: isManagedByStage,
        getPlanTry: (id) => (nodeRequire('../stores/coworkPlanTries.mts') as typeof import('../stores/coworkPlanTries.mts')).coworkPlanTries().getPlanTry(id),
        lookups: toolLookups(),
    };
}

/** What the test produced: the step it came from, the message's title when it has one, and its text. */
export interface TriedResult {
    stepId: string;
    title: string | null;
    text: string;
}

const TEXT_MAX = 4000;
const TITLE_MAX = 200;

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Decode before capping the preview so the cap cannot leave an invalid JSON envelope. */
function previewText(raw: string): string {
    const answer: unknown = parseJsonText(raw)?.answer;
    return (typeof answer === 'string' && answer.trim() ? answer : raw).trim();
}

/** What one sending step would have delivered or sent, as text; null when its row says nothing. */
function saidBy(step: PlanStep, row: RunStepRow): TriedResult | null {
    if (step.kind !== 'deliver') {
        const text = previewText(longestText(row.input));
        return text ? { stepId: step.id, title: null, text: cut(text, TEXT_MAX) } : null;
    }
    const message = messageOf(row.output);
    const { title, body } = (message && typeof message === 'object' ? message : {}) as { title?: unknown; body?: unknown };
    const text = previewText(typeof body === 'string' && body.trim() ? body : longestText(message));
    if (!text) return null;
    return { stepId: step.id, title: typeof title === 'string' && title.trim() && title.trim() !== text ? cut(title.trim(), TITLE_MAX) : null, text: cut(text, TEXT_MAX) };
}

/** The result in the rows of a try-out of `definition`: the last result for the owner, else the last step that sends. */
export function resultIn(definition: Definition, rows: RunStepRow[], lookups: ToolLookups): TriedResult | null {
    const view = planViewOf(definition, lookups);
    const at = new Map(view.runOrder.map((id, i) => [id, i]));
    const last = lastAttempts(rows);
    const lastFirst = view.steps
        .filter((s) => s.kind === 'deliver' || s.effect === 'sends')
        .sort((a, b) => (at.get(b.id) ?? 0) - (at.get(a.id) ?? 0));
    for (const step of [...lastFirst.filter((s) => s.kind === 'deliver'), ...lastFirst.filter((s) => s.kind !== 'deliver')]) {
        const row = last.get(step.id);
        const said = row ? saidBy(step, row) : null;
        if (said) return said;
    }
    return null;
}

/** What the item's last test produced; null unless it passed and tried exactly the plan as it is now. */
export async function triedResultOf({ item }: { item: Item }, deps: TriedResultDeps = defaultDeps()): Promise<TriedResult | null> {
    const record = await deps.getPlanTry(item.id);
    if (!record?.tryId || record.status !== 'passed') return null;
    const automation = await planSourceOf(item.planAutomationId, item.userId, deps);
    if (!automation || automation.id !== record.automationId) return null;
    const definition = automation.definition as Definition;
    if (planFingerprint(definition) !== record.fingerprint) return null;
    const run = await deps.getRun(record.tryId);
    if (!run || run.automationId !== automation.id || run.mode !== 'dry_run') return null;
    return resultIn(definition, await deps.getRunSteps(record.tryId), deps.lookups);
}
