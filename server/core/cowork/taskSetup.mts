/**
 * The rules of a task's set-up (stores/coworkSetup.mts holds it; usecases/coworkSetup.mts changes it). Pure.
 *
 *   HELD      A task that was started as one with fixed steps does not start by itself until a plan of it is approved,
 *             or its owner said the AI may work it out every run. Cowork never makes that second choice for them: a
 *             set-up that failed, or that its owner walked away from, leaves the task waiting, with a card under
 *             "Needs you" that says so (usecases/coworkNeedsYou.mts).
 *   SENDS TO  Who the owner chose on the confirmation reaches whoever does the work, as one last line of the brief:
 *             the planner drafts the steps for exactly these recipients (usecases/coworkPlanner.mts), and a run the AI
 *             works out itself reads the same line (./coworkRunner.js). The stored sentence stays as it was written.
 *   USES      The apps they chose are the ones the planner is told to build with (none: the AI only writes). A run
 *             the AI works out itself is held to the same list by the runner, as every task's own list of apps is.
 *   CAUSE     Why a set-up ended without steps, as a class the card words; never the error itself.
 */

import type { SendsTo, SetupCause, TaskSetup } from '../../stores/coworkSetup.mts';

interface SetupItem { planId?: string | null; planAutomationId?: string | null; setup?: Pick<TaskSetup, 'steps' | 'cause' | 'since'> | null }

/** A set-up that neither ended nor failed after this long was cut off (the server stopped, the request was lost). */
export const SETUP_GRACE_MS = 240_000;

/** The most addresses one task sends to, and the longest one. */
export const MAX_RECIPIENTS = 20;
export const MAX_ADDRESS = 320;

/** It waits for its owner: it wants fixed steps, and none is approved. */
export function heldForSetup(item: SetupItem): boolean {
    const steps = item.setup?.steps;
    return (steps === 'wanted' || steps === 'failed') && !item.planId;
}

/**
 * Why a held task has no steps to look at, when that is so: its set-up failed, or it never ended. Null while a plan
 * waits on its card (that card asks for it), while the set-up is on the go, and for a task that is not held.
 */
export function setupProblemOf(item: SetupItem, now: Date = new Date()): SetupCause | null {
    if (!heldForSetup(item) || item.planAutomationId) return null;
    if (item.setup?.steps === 'failed') return item.setup.cause ?? 'failed';
    const since = Date.parse(item.setup?.since ?? '');
    return Number.isFinite(since) && now.getTime() - since < SETUP_GRACE_MS ? null : 'left';
}

/** An e-mail address, by plain string checks (never a pattern on text a person typed): one @, a dotted host, no blanks. */
export function isAddress(value: string): boolean {
    const text = value.trim();
    if (!text || text.length > MAX_ADDRESS || text.includes(' ') || text.includes(',') || text.includes(';')) return false;
    const at = text.indexOf('@');
    if (at <= 0 || at !== text.lastIndexOf('@')) return false;
    const host = text.slice(at + 1);
    const dot = host.lastIndexOf('.');
    return dot > 0 && dot < host.length - 1 && !host.includes('..');
}

/** A body's list ("me" and addresses) as who the task sends to: once each, the owner apart. */
export function sendsToOf(list: readonly string[]): SendsTo {
    const others: string[] = [];
    let me = false;
    for (const raw of list) {
        const entry = raw.trim();
        if (entry.toLowerCase() === 'me') me = true;
        else if (isAddress(entry) && !others.some((o) => o.toLowerCase() === entry.toLowerCase())) others.push(entry);
    }
    return { me, others: others.slice(0, MAX_RECIPIENTS) };
}

/** "Send the result to: me, sam@example.com." Null when the owner chose nobody, or nothing was chosen. */
export function recipientsLine(sendsTo: SendsTo | null | undefined): string | null {
    if (!sendsTo) return null;
    const names = [...(sendsTo.me ? ['me'] : []), ...sendsTo.others];
    return names.length > 0 ? `Send the result to: ${names.join(', ')}.` : 'Send the result to nobody: only write it.';
}

/** The brief with who it sends to as its last line; the brief itself when nothing was chosen. */
export function briefWithRecipients(brief: string, setup: Pick<TaskSetup, 'sendsTo'> | null | undefined): string {
    const line = recipientsLine(setup?.sendsTo);
    return line ? `${brief.trim()}\n\n${line}` : brief;
}

/**
 * The brief a plan is drafted from, for a task its owner confirmed (it has a set-up): the apps they chose as the only
 * ones to build with (none: the AI only writes), then who it sends to. A task without a set-up gets its brief as it is.
 */
export function briefForPlanner(brief: string, item: { enabledApps?: readonly string[] | null; setup?: Pick<TaskSetup, 'sendsTo'> | null }): string {
    if (!item.setup) return brief;
    const apps = Array.isArray(item.enabledApps) ? item.enabledApps : null;
    const line = apps && (apps.length > 0 ? `Use only these apps: ${apps.join(', ')}.` : 'Use no apps: the AI only writes.');
    return briefWithRecipients(line ? `${brief.trim()}\n\n${line}` : brief, item.setup);
}

const CAUSE_OF_CODE: Readonly<Record<string, SetupCause>> = {
    cowork_planner_no_model: 'no_model',
    cowork_planner_timeout: 'timeout',
    cowork_planner_empty: 'unclear',
    cowork_budget_used: 'budget',
};

/** The class of what ended a set-up: the planner's own refusals by their code, a caller that left, else just "failed". */
export function causeOf(err: unknown, left = false): SetupCause {
    if (left) return 'left';
    const e = (err && typeof err === 'object' ? err : {}) as { code?: unknown; status?: unknown; name?: unknown };
    if (e.name === 'AbortError') return 'left';
    const known = typeof e.code === 'string' ? CAUSE_OF_CODE[e.code] : undefined;
    if (known) return known;
    return e.status === 403 ? 'not_available' : 'failed';
}
