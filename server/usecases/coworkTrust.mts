/**
 * Trust per action and recipient, for the item's owner (routes/coworkPlanRoutes.js): what each step of the plan has
 * earned, and letting one go on its own (core/cowork/planTrust.mts). Only a step let through TRUST_AFTER times since
 * the last stop can be trusted, and only while the organisation's ceiling allows "on its own".
 */

import { createRequire } from 'node:module';
import type { Definition, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { TRUST_AFTER } from '../core/cowork/planTrust.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';
import { policyOfOwner, OPEN_POLICY, type CoworkPolicy } from '../core/entitlements/coworkPolicy.mts';
import type { TrustRow } from '../stores/coworkTrust.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

interface Item { id: string; userId: string }

export interface TrustDeps {
    listTrust: (scheduleId: string) => Promise<TrustRow[]>;
    setTrusted: (scheduleId: string, stepId: string, recipient: string, trusted: boolean) => Promise<boolean>;
    getApprovedPlan: (scheduleId: string) => Promise<{ definition: unknown } | null>;
    policyOf?: (userId: string) => Promise<CoworkPolicy>;
    lookups: ToolLookups;
}

const defaults = (): TrustDeps => {
    const trust = () => (nodeRequire('../stores/coworkTrust.mts') as typeof import('../stores/coworkTrust.mts')).coworkTrust();
    return {
        listTrust: (id) => trust().listTrust(id),
        setTrusted: (...a) => trust().setTrusted(...a),
        getApprovedPlan: (id) => (nodeRequire('../stores/coworkStore.js') as { getApprovedPlan: TrustDeps['getApprovedPlan'] }).getApprovedPlan(id),
        policyOf: (userId) => policyOfOwner(userId),
        lookups: toolLookups(),
    };
};

export interface TrustEntry { stepId: string; title: string; recipient: string; letThrough: number; trusted: boolean; canTrust: boolean }
export interface TrustState { entries: TrustEntry[]; needed: number; ceilingAllows: boolean }

/** What each step has earned, with its title in the approved plan; a step the plan no longer has is left out. */
export async function trustOf(item: Item, deps: TrustDeps = defaults()): Promise<TrustState> {
    const [rows, plan, policy] = await Promise.all([
        deps.listTrust(item.id), deps.getApprovedPlan(item.id), deps.policyOf ? deps.policyOf(item.userId) : Promise.resolve(OPEN_POLICY),
    ]);
    const titles = new Map((plan ? planViewOf(plan.definition as Definition, deps.lookups).steps : []).map((s) => [s.id, s.title]));
    const ceilingAllows = policy.ceiling === 'on_its_own';
    const entries = rows.filter((r) => titles.has(r.stepId)).map((r): TrustEntry => ({
        ...r, title: titles.get(r.stepId) ?? r.stepId, canTrust: ceilingAllows && r.letThrough >= TRUST_AFTER,
    }));
    return { entries, needed: TRUST_AFTER, ceilingAllows };
}

/** Let one step and recipient go on its own, or ask again. Asking again is always allowed. */
export async function chooseTrust({ item, stepId, recipient, trusted }: { item: Item; stepId: string; recipient: string; trusted: boolean }, deps: TrustDeps = defaults()): Promise<TrustState> {
    const state = await trustOf(item, deps);
    const entry = state.entries.find((e) => e.stepId === stepId && e.recipient === recipient);
    if (!entry) throw new HttpError(404, 'cowork_trust_refused', 'That step has no decisions to go on yet.');
    if (trusted && !entry.canTrust) {
        throw new HttpError(409, 'cowork_trust_refused', state.ceilingAllows
            ? `This step goes on its own after you let it through ${TRUST_AFTER} times without stopping it (${entry.letThrough} so far).`
            : 'Your organisation does not let a cowork act on its own.');
    }
    await deps.setTrusted(item.id, stepId, recipient, trusted);
    return trustOf(item, deps);
}
