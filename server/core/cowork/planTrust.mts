/**
 * Trust per action and recipient: "You let 'Mail the supplier' to orders@hoekstra.example through 5 times. Let it go
 * on its own?" Every decision of the owner on a question in front of a step (./plan/planIndependence.mts) counts for
 * that step and its recipient: let through counts one up, a stop starts the count again and takes the trust away.
 * After TRUST_AFTER the owner is offered to let that one step to that one recipient go on its own; the question in
 * front of it then goes, as long as the plan still sends that step to that recipient.
 *
 * The recipient is who the plan fixes: every field that says who receives something (to, cc, bcc, attendees, ...: the
 * list the plan checks use, ./plan/planChecks.mts), each a literal. A step that fixes more than one is keyed by all of
 * them; a step where the plan picks any one of them from data counts as ANY_RECIPIENT, so trusting it trusts the step.
 * The organisation's ceiling wins: below "on its own", no step goes on its own, whatever it was trusted with
 * (core/entitlements/coworkPolicy.mts).
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, ToolLookups } from './plan/planTypes.mts';
import { ASK_PREFIX } from './plan/planIndependence.mts';
import { planViewOf } from './plan/planView.mts';
import { stepsOf, inputsOf } from './plan/planWalk.mts';
import { DESTINATION_FIELDS, fieldKey } from './plan/planChecks.mts';
import type { TrustRow, Decision } from '../../stores/coworkTrust.mts';

const nodeRequire = createRequire(import.meta.url);

export const TRUST_AFTER = 5;
export const ANY_RECIPIENT = '*';

/** The addresses one recipient field fixes ([] when it names nobody), or null when the plan picks them from data. */
function fixedBy(input: unknown): string[] | null {
    if (input === null || input === undefined) return [];
    const { kind, value } = input as { kind?: unknown; value?: unknown };
    if (kind !== 'literal') return null;
    const values = Array.isArray(value) ? value : [value];
    if (!values.every((v) => typeof v === 'string')) return null;
    return (values as string[]).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

/**
 * Who a step sends to as the plan fixes it: the literal addresses of all its recipient fields, sorted and joined; else
 * ANY_RECIPIENT. A step with one literal `to` is keyed by that address alone, as trust was always kept.
 */
export function recipientOf(step: DefStep | null | undefined): string {
    const found = new Set<string>();
    for (const [name, input] of Object.entries(step ? inputsOf(step) : {})) {
        if (!DESTINATION_FIELDS.has(fieldKey(name))) continue;
        const fixed = fixedBy(input);
        if (!fixed) return ANY_RECIPIENT;
        for (const address of fixed) found.add(address);
    }
    return found.size > 0 ? [...found].sort().join(',') : ANY_RECIPIENT;
}

/** The steps a question in front of `rootId` is about: the step itself, or what changes or sends inside its loop. */
export function stepsUnder(definition: Definition, rootId: string, lookups: ToolLookups): DefStep[] {
    const walked = stepsOf(definition);
    const parentOf = new Map(walked.map((s) => [s.id, s.parentId]));
    const rootOf = (id: string): string => { let at = id; for (let p = parentOf.get(at); p; p = parentOf.get(at)) at = p; return at; };
    const acting = new Set(planViewOf(definition, lookups).steps.filter((s) => s.type !== 'loop' && s.effect !== 'reads' && s.kind !== 'ask' && s.kind !== 'deliver').map((s) => s.id));
    return walked.filter((s) => acting.has(s.id) && rootOf(s.id) === rootId).map((s) => s.step);
}

/** The steps that go on their own in a run: trusted, still to the same recipient, and the ceiling allows it. */
export function trustedSteps(definition: Definition, rows: TrustRow[], ceiling: string): Set<string> {
    if (ceiling !== 'on_its_own') return new Set();
    const byId = new Map(stepsOf(definition).map((s) => [s.id, s.step]));
    return new Set(rows.filter((r) => r.trusted && byId.has(r.stepId) && recipientOf(byId.get(r.stepId)) === r.recipient).map((r) => r.stepId));
}

export interface JourneyDeps {
    decisionsOfJourney: (journeyId: string, prefix: string) => Promise<Decision[]>;
    recordDecision: (scheduleId: string, stepId: string, recipient: string, approved: boolean) => Promise<void>;
    lookups: ToolLookups;
}

const defaults = (): JourneyDeps => {
    const trust = () => (nodeRequire('../../stores/coworkTrust.mts') as typeof import('../../stores/coworkTrust.mts')).coworkTrust();
    return {
        decisionsOfJourney: (id, prefix) => trust().decisionsOfJourney(id, prefix),
        recordDecision: (...a) => trust().recordDecision(...a),
        lookups: (nodeRequire('./plan/planLookups.mts') as typeof import('./plan/planLookups.mts')).toolLookups(),
    };
};

/** Count the owner's decisions on the questions of one journey that ended. Answers how many steps were counted. */
export async function recordJourneyDecisions(plan: { scheduleId: string; definition: unknown }, journeyId: string, deps: JourneyDeps = defaults()): Promise<number> {
    const definition = plan.definition as Definition;
    let counted = 0;
    for (const decision of await deps.decisionsOfJourney(journeyId, ASK_PREFIX)) {
        if (decision.status !== 'approved' && decision.status !== 'rejected') continue;
        for (const step of stepsUnder(definition, decision.stepId.slice(ASK_PREFIX.length), deps.lookups)) {
            await deps.recordDecision(plan.scheduleId, String(step.id), recipientOf(step), decision.status === 'approved');
            counted += 1;
        }
    }
    return counted;
}
