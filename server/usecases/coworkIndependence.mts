/**
 * How independent an item's plan may be, for its owner (routes/coworkPlanRoutes.js): the three levels with what each
 * would ask about, which one runs, and the rules of choosing one.
 *
 *   - asking ("asks everything", "asks before sending") needs approvals in the owner's licence;
 *   - "on its own" opens once the owner let ON_ITS_OWN_AFTER runs of this version through without stopping one
 *     (core/cowork/plan/planIndependence.mts), or at once when asking is not possible at all (the approval of the plan
 *     is then the only question there is).
 *
 * The choice is the item's; a run keeps the level it started with (core/cowork/planRun.mts).
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import {
    askTargets, effectiveIndependence, isIndependence, INDEPENDENCE_LEVELS, ON_ITS_OWN_AFTER, ASKING_NOT_AVAILABLE,
    type Independence,
} from '../core/cowork/plan/planIndependence.mts';
import { mayAskByLicence, type MayAsk } from '../core/cowork/plan/planLicence.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { aboveCeiling, capLevel, policyOfOwner, OPEN_POLICY, type CoworkPolicy } from '../core/entitlements/coworkPolicy.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string; organizationId?: string | null; independence?: string | null }
interface ApprovedPlan { id: string; definition: unknown }

export interface IndependenceDeps {
    store: {
        getApprovedPlan: (scheduleId: string) => Promise<ApprovedPlan | null>;
        countLetThrough: (scheduleId: string, planId: string) => Promise<number>;
        setIndependence: (scheduleId: string, level: string | null) => Promise<void>;
    };
    mayAsk: MayAsk;
    lookups: ToolLookups;
    /** The organisation's Cowork policy; without one, the open policy. */
    policyOf?: (userId: string) => Promise<CoworkPolicy>;
}

const defaults = (): IndependenceDeps => ({
    store: nodeRequire('../stores/coworkStore.js') as IndependenceDeps['store'],
    mayAsk: mayAskByLicence,
    lookups: toolLookups(),
    policyOf: (userId) => policyOfOwner(userId),
});

export interface LevelOption {
    level: Independence;
    /** May the owner choose it now. */
    open: boolean;
    /** The steps a run at this level asks about first (of the approved plan). */
    asksBefore: string[];
}

export interface IndependenceState {
    /** The owner's choice; null when they made none (the run then uses `level`). */
    chosen: Independence | null;
    /** The level the next run uses; null when it cannot run as chosen (asking is no longer possible). */
    level: Independence | null;
    asksAvailable: boolean;
    /** The most independent level the organisation allows. */
    ceiling: Independence;
    /** Runs of this version let through since the last one stopped, and how many open "on its own". */
    letThrough: number;
    needed: number;
    options: LevelOption[];
}

/** Where the item stands. Without an approved plan nothing would be asked about. */
export async function independenceOf(item: Item, deps: IndependenceDeps = defaults()): Promise<IndependenceState> {
    const plan = await deps.store.getApprovedPlan(item.id);
    const asksAvailable = await deps.mayAsk({ userId: item.userId, organizationId: item.organizationId ?? null });
    const letThrough = plan ? await deps.store.countLetThrough(item.id, plan.id) : 0;
    const { ceiling } = deps.policyOf ? await deps.policyOf(item.userId) : OPEN_POLICY;
    const chosen = isIndependence(item.independence) ? item.independence : null;
    let level: Independence | null;
    try { level = effectiveIndependence(capLevel(effectiveIndependence(chosen, asksAvailable), ceiling), asksAvailable); } catch { level = null; }
    const definition = (plan?.definition ?? null) as Definition | null;
    const options = INDEPENDENCE_LEVELS.map((l): LevelOption => ({
        level: l,
        open: !aboveCeiling(l, ceiling) && (l === 'on_its_own' ? (!asksAvailable || letThrough >= ON_ITS_OWN_AFTER) : asksAvailable),
        asksBefore: askTargets(definition, l, deps.lookups).map((t) => t.title),
    }));
    return { chosen, level, ceiling, asksAvailable, letThrough, needed: ON_ITS_OWN_AFTER, options };
}

/** Choose a level. A level that is not open is refused, with why. */
export async function chooseIndependence({ item, level }: { item: Item; level: string }, deps: IndependenceDeps = defaults()): Promise<IndependenceState> {
    if (!isIndependence(level)) throw new HttpError(400, 'cowork_independence_refused', 'That is not one of the three levels.');
    const state = await independenceOf(item, deps);
    const option = state.options.find((o) => o.level === level);
    if (!option?.open) {
        const why = aboveCeiling(level, state.ceiling)
            ? 'Your organisation does not allow this much independence for a cowork.'
            : level === 'on_its_own'
                ? `"On its own" opens after ${ON_ITS_OWN_AFTER} runs of this plan you let through without stopping one (${state.letThrough} so far).`
                : ASKING_NOT_AVAILABLE;
        throw new HttpError(409, 'cowork_independence_refused', why);
    }
    await deps.store.setIndependence(item.id, level);
    return independenceOf({ ...item, independence: level }, deps);
}
