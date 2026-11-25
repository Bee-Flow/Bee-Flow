/**
 * The amend mode of the Cowork planner: a CHANGE to an approved plan, worked out by the planner's own loop
 * (./coworkDraftLoop.mts) on the planner's menu, for ./coworkProposals.mts.
 *
 * The loop is seeded with a COPY of the approved definition: the builder's tools change the copy, and nothing is
 * stored here. Not the item, not its plan automation, not its approved plans: what comes out is a definition the
 * caller may offer its owner as a proposal. After every change the copy is held to Cowork's rules and the licence, as
 * a plan being made is, and the report goes back to the model.
 *
 * The model is told FACTS ONLY (./coworkPlanAmendPrompt.mts): which step failed and the class of its error, or the
 * goal's numbers, or which steady AI step to make fixed. Never an error message, a run's content or outside text.
 *
 * Its AI is booked on the run that set it off (`bookOn`), so it counts on the item's budget.
 */

import { createRequire } from 'node:module';
import type { Definition } from '../core/cowork/plan/planTypes.mts';
import { asStartedBy } from '../core/cowork/startKinds.mts';
import { checkPlan } from '../core/cowork/plan/planChecks.mts';
import { refFindings } from './coworkPlanRefs.mts';
import { licenceFindings } from '../core/cowork/plan/planLicence.mts';
import { plannerRefusal, plannerTools } from './coworkPlannerPrompt.mts';
import { amendSystemPrompt, type AmendFacts } from './coworkPlanAmendPrompt.mts';
import { draftWithin, newDraft, type LoopDeps } from './coworkDraftLoop.mts';
import type { PlannerDeps } from './coworkPlanner.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

export type { AmendFacts } from './coworkPlanAmendPrompt.mts';

/** Rounds of model and tools before amending stops with what it has. */
export const MAX_AMEND_ROUNDS = 6;
/** The whole working out of a change, in ms. */
export const AMEND_MAX_MS = 150_000;

interface Item { id: string; userId: string; title?: string | null; triggerKind?: string | null }

export type AmendDeps = LoopDeps & Pick<PlannerDeps, 'ownerRefusal' | 'resolveModel' | 'mayAsk'>;

/** The planner's own wiring, with the amend mode's time limit. */
export function amendDeps(): AmendDeps {
    const planner = nodeRequire('./coworkPlanner.mts') as typeof import('./coworkPlanner.mts');
    return { ...planner.plannerDeps(), maxMs: AMEND_MAX_MS };
}

export interface AmendInput {
    item: Item;
    /** The approved definition; it is copied, never changed. */
    approved: Definition;
    facts: AmendFacts;
    ownerRequest?: string;
    userOrgId?: string | null;
    /** The Cowork run this change is booked on. */
    bookOn?: string | null;
    signal?: AbortSignal | null;
}

export interface Amended {
    definition: Definition;
    /** What the model said it changed. */
    summary: string;
    rounds: number;
}

/** Work out a change to the approved plan from the facts. Answers the changed copy; stores nothing. */
export async function amendPlan(input: AmendInput, deps: AmendDeps = amendDeps()): Promise<Amended> {
    const { item } = input;
    const userOrgId = input.userOrgId ?? null;
    const owner = { userId: item.userId, organizationId: userOrgId };
    const refusal = await deps.ownerRefusal(owner);
    if (refusal) throw new HttpError(403, 'cowork_plan_refused', 'This account can no longer run a plan.');
    const modelId = await deps.resolveModel({ userOrgId, userId: item.userId });
    if (!modelId) throw new HttpError(409, 'cowork_planner_no_model', 'No AI model is configured for this workspace.');

    const catalog = await deps.builder.catalogFor(item.userId, null);
    const draft = await newDraft({
        userId: item.userId, userOrgId, catalog,
        sessionId: `cwa_${item.id}_${deps.now().toString(36)}`,
        title: item.title || 'Cowork plan', description: 'A change Cowork proposes to the approved plan of this item.',
    }, deps);
    // A COPY: the builder's tools change this one only.
    draft.def = structuredClone(input.approved);
    const approvals = await deps.mayAsk(owner);
    const findingsOf = async (def: Definition) => [...checkPlan(asStartedBy(def, item), deps.lookups), ...refFindings(def, deps.lookups), ...await licenceFindings(def, owner, async () => approvals)];
    const system = amendSystemPrompt({
        title: draft.title, plan: input.approved, facts: input.facts, approvals,
        catalog: deps.builder.renderCatalog(catalog), datatables: deps.builder.renderDatatables(catalog.datatables),
    });
    const menu = { tools: plannerTools(deps.builder.toolSchemas), refusal: plannerRefusal };
    const loop = await draftWithin(
        { draft, modelId, system, ask: input.facts.kind === 'owner_request' ? input.ownerRequest || '' : 'Change the plan as the facts call for.', menu, maxRounds: MAX_AMEND_ROUNDS, findingsOf, bookOn: input.bookOn ?? null },
        input.signal, { code: 'cowork_amend_timeout', message: 'Working out a change took too long.' }, deps,
    );
    return { definition: draft.def, summary: loop.summary, rounds: loop.rounds };
}
