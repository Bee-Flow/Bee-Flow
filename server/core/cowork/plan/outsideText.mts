/**
 * Outside text: what a plan reads that was written by someone outside the workspace, and where it travels.
 *
 * A mail, a web page, the body of a webhook: text a stranger chose. A model that reads it can be talked into things,
 * and no instruction to the model makes that impossible. So the plan is judged on its STRUCTURE instead. This file
 * answers two questions about a definition, without running it:
 *
 *   - which steps BRING outside text into the run (a read of a mail app, a read on the open web, the output of a
 *     trigger that an outside event fires);
 *   - which steps CARRY it: a step that reads the output of a carrying step carries it too, whatever it does with it.
 *     A value a model extracted from a mail is still the mail's.
 *
 * ./planChecks.mts turns the answer into rules (an AI step that reads outside text gets no tools; outside text never
 * picks a recipient, an address or a target). The mark is conservative on purpose: it follows every reference a step
 * makes, and a loop's item carries what the loop itself reads.
 */

import type { Definition, DefStep, ToolLookups } from './planTypes.mts';
import { stepsOf, refsOfStep, aiToolsOf, type Refs, type WalkedStep } from './planWalk.mts';

/** Apps whose reads return text other people wrote: mailboxes and group conversations. */
export const OUTSIDE_TEXT_APPS: ReadonlySet<string> = new Set([
    'gmail', 'outlook', 'outlook-readonly', 'nextcloud-mail', 'google-groups',
]);

/** Trigger kinds whose output an outside party writes. An app event is one when its provider is a mailbox. */
const OUTSIDE_TRIGGER_PROVIDERS: ReadonlySet<string> = new Set(['gmail', 'msgraph', 'nextcloud-mail']);

/** Does this tool read text an outside party wrote (a mailbox, a group conversation, the open web)? */
function readsOutside(tool: string, lookups: ToolLookups): boolean {
    if (lookups.isOpenWebRead(tool)) return true;
    const app = lookups.appOfTool(tool);
    return app !== null && OUTSIDE_TEXT_APPS.has(app) && lookups.effectOfTool(tool) === 'reads';
}

/** An AI step offered a tool that reads outside text reads it itself, whatever its prompt refers to. */
export function aiReadsOutsideText(step: DefStep, lookups: ToolLookups): boolean {
    return step.type === 'ai_step' && aiToolsOf(step).some((tool) => readsOutside(tool, lookups));
}

/** Does this step, by what it is, bring outside text into the run? */
export function bringsOutsideText(step: DefStep, lookups: ToolLookups): boolean {
    if (aiReadsOutsideText(step, lookups)) return true;
    if (step.type !== 'integration_action' || typeof step.tool !== 'string' || !step.tool) return false;
    return readsOutside(step.tool, lookups);
}

/** Is the trigger's output written by an outside party (a new mail, a webhook call)? */
export function triggerBringsOutsideText(definition: Definition | null | undefined): boolean {
    const trigger = definition?.trigger;
    if (!trigger || typeof trigger !== 'object') return false;
    // A plan an event starts (a webhook, a row, a file, another cowork, a mail): ../startKinds.mts asStartedBy.
    if (trigger.kind === 'webhook' || trigger.startedFromOutside === true) return true;
    if (trigger.kind !== 'app_event') return false;
    const provider = trigger.appEvent?.provider;
    return typeof provider === 'string' && OUTSIDE_TRIGGER_PROVIDERS.has(provider);
}

export interface OutsideText {
    /** Steps whose OUTPUT carries outside text. */
    carries: Set<string>;
    /** Steps that READ outside text (through a reference, the trigger or their loop's item). */
    reads: Set<string>;
    /** Whether a given set of references reads outside text, for one field of a step. */
    refsReadIt(refs: Refs, step: WalkedStep): boolean;
}

/** Where outside text enters this plan and where it travels. */
export function outsideTextOf(definition: Definition | null | undefined, lookups: ToolLookups): OutsideText {
    const steps = stepsOf(definition);
    const byId = new Map(steps.map((s) => [s.id, s]));
    const triggerOutside = triggerBringsOutsideText(definition);
    const carries = new Set<string>();
    const reads = new Set<string>();
    const refsOf = new Map(steps.map((s) => [s.id, refsOfStep(s.step)]));

    const refsReadIt = (refs: Refs, step: WalkedStep): boolean => {
        if (refs.trigger && triggerOutside) return true;
        for (const id of refs.steps) if (carries.has(id)) return true;
        // The item of a loop is whatever the loop iterates over: it carries what the loop itself reads. Inside a loop
        // within a loop the outer items are in reach too (the engine merges them in), so every enclosing loop counts.
        if (refs.loop) {
            for (let at = step.parentId; at !== null; at = byId.get(at)?.parentId ?? null) {
                if (reads.has(at) || carries.has(at)) return true;
            }
        }
        return false;
    };

    // To a fixed point: a reference normally points back, but nothing here relies on that. Each pass can only add
    // steps, so it ends after at most one pass per step.
    for (let pass = 0; pass <= steps.length; pass += 1) {
        let changed = false;
        for (const s of steps) {
            const readsIt = refsReadIt(refsOf.get(s.id) as Refs, s) || aiReadsOutsideText(s.step, lookups);
            if (readsIt && !reads.has(s.id)) { reads.add(s.id); changed = true; }
            if ((readsIt || bringsOutsideText(s.step, lookups)) && !carries.has(s.id)) { carries.add(s.id); changed = true; }
        }
        if (!changed) break;
    }
    return { carries, reads, refsReadIt };
}
