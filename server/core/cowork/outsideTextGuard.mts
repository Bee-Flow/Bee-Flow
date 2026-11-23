/**
 * Outside text in an unattended Cowork run that follows no plan (a prompt run or an agent run): once the run has
 * read text written outside the workspace, it no longer sends anything to other people.
 *
 * A plan is judged on its structure before it runs (./plan/outsideText.mts, decision 0031). A prompt or agent run
 * has no plan to judge: the model picks its tools as it goes. So the same rule is held at run time, per call:
 *
 *   - a call that reads outside text (a mailbox or a group conversation, a read on the open web) marks the run;
 *   - from then on a call that SENDS (the side-effect map's `sends`: a mail, a chat message, a share) is refused
 *     before it runs, with a sentence the model reads: save it as a draft, or ask the owner.
 *
 * Writing inside the owner's own apps (a draft, a row, a file) stays possible: the owner looks at it. A run started by
 * a new mail has its own, stricter allow-list (core/agentRuntime/toolPolicy/mailRun.mts) and is not held here.
 *
 * The mark is set when the reading call is let through, before it runs, so a send in the same batch is held too.
 */

import { createRequire } from 'node:module';
import { OUTSIDE_TEXT_APPS } from './plan/outsideText.mts';

const nodeRequire = createRequire(import.meta.url);

type Effect = 'reads' | 'writes' | 'sends';

export interface GuardLookups {
    appOf: (toolName: string) => string | null;
    effectOf: (toolName: string) => Effect;
    isOpenWebRead: (toolName: string) => boolean;
}

export function defaultLookups(): GuardLookups {
    const { effectOf } = nodeRequire('../automationModel/sideEffectMap.js') as { effectOf: (n: string) => Effect };
    const { OUTSIDE_READS } = nodeRequire('../agentRuntime/toolPolicy/mailRun.mts') as { OUTSIDE_READS: ReadonlySet<string> };
    const { appIdForTool } = nodeRequire('../agentRuntime/toolPolicy/appIndex.js') as { appIdForTool: (n: string) => string | null };
    return { appOf: (n) => appIdForTool(n), effectOf: (n) => effectOf(n), isOpenWebRead: (n) => OUTSIDE_READS.has(n) };
}

/** Does this tool read text an outside party wrote? */
export function readsOutsideText(toolName: string, lookups: GuardLookups): boolean {
    if (lookups.isOpenWebRead(toolName)) return true;
    let app: string | null = null;
    try { app = lookups.appOf(toolName); } catch { app = null; }
    return app !== null && OUTSIDE_TEXT_APPS.has(app) && lookups.effectOf(toolName) === 'reads';
}

export const OUTSIDE_TEXT_REFUSAL = 'This run has read text written outside the workspace (a mail or a web page), so it no longer sends anything to other people. Save it as a draft for the owner, or ask the owner for a review.';

/** What a run keeps: whether it read outside text. */
export interface OutsideTextMark { seen: boolean }

export function createOutsideTextMark(): OutsideTextMark {
    return { seen: false };
}

/**
 * One call, before it runs: marks the run when the call reads outside text, and answers the refusal when the run is
 * marked and the call sends. Null: the call may run.
 */
export function holdCall(mark: OutsideTextMark, toolName: string, lookups: GuardLookups = defaultLookups()): string | null {
    if (readsOutsideText(toolName, lookups)) {
        mark.seen = true;
        return null;
    }
    return mark.seen && lookups.effectOf(toolName) === 'sends' ? OUTSIDE_TEXT_REFUSAL : null;
}
