/**
 * A Cowork run in the words a person reads (routes/cowork.js GET /:id/runs; usecases/coworkNeedsYou.mts for a failed
 * last run).
 *
 *   TOOLS   Beside each tool's name and app, what a person calls it ("Outlook: create draft") and what it does to the
 *           world (reads, writes, sends), from the same lookups a plan is read with (core/cowork/plan/planLookups.mts).
 *           Cowork's own tools (asking for a review, giving its verdict) are marked `internal`: no step of the work.
 *   PLAIN   How a run ended, as one sentence its owner understands: the step by its title and the cause by its class
 *           (an app that is no longer allowed, a sign-in that ran out, a step that could not read from another, the
 *           AI's own verdict, a list that never arrived, a run that took too long). Never a step id, a reference in
 *           braces, a tool name or the engine's own words: the raw error stays on the run, for "Technical details".
 *           Null for a run that simply went well.
 *
 * A lookup that fails costs the words, never the history.
 */

import { createRequire } from 'node:module';
import type { Definition, Effect, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { OUTCOME_TOOL_NAME, REVIEW_TOOL_NAME } from '../core/cowork/runActivity.mts';
import { toolLookups } from '../core/cowork/plan/planLookups.mts';

const nodeRequire = createRequire(import.meta.url);
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

type Lookups = Pick<ToolLookups, 'effectOfTool' | 'labelOfTool'>;

interface StoredTool { name: string; [key: string]: unknown }
export interface ToolWords { label: string | null; effect: Effect; internal: boolean }

const INTERNAL: ReadonlySet<string> = new Set([REVIEW_TOOL_NAME, OUTCOME_TOOL_NAME]);

function wordsOf(name: string, lookups: Lookups): ToolWords {
    const internal = INTERNAL.has(name);
    try {
        return { label: internal ? null : lookups.labelOfTool?.(name)?.trim() || null, effect: internal ? 'reads' : lookups.effectOfTool(name), internal };
    } catch (e) {
        // Fail closed on the effect: a tool nobody could classify is read as one that changes something.
        return fallback('usecases/coworkRunWords:wordsOf', e, { label: null, effect: 'writes' as Effect, internal });
    }
}

/** The runs, each tool of their activity with its words; a run without activity is left as it is. */
export function withToolWords<R extends { activity?: unknown }>(runs: R[], lookups: Lookups = toolLookups()): R[] {
    return runs.map((run) => {
        const activity = run.activity as { tools?: unknown } | null | undefined;
        if (!activity || !Array.isArray(activity.tools)) return run;
        const tools = (activity.tools as StoredTool[]).map((tool) => (tool && typeof tool.name === 'string' ? { ...tool, ...wordsOf(tool.name, lookups) } : tool));
        return { ...run, activity: { ...activity, tools } };
    });
}

/** Why a run did not do its work, as a class. `nothing_to_do` is the one that is no failure. */
export type RunCause = 'permission' | 'sign_in' | 'reads' | 'nothing_found' | 'ai_failed' | 'nothing_to_do' | 'timeout' | 'waits' | 'step' | 'other';

/** What the sentence is made of: the class, the step and the step it reads by their titles, the app by its name. */
export interface RunWords { cause: RunCause; step: string | null; source: string | null; app: string | null; reason: string | null }

/** The fields of a run row the words are read from (stores/coworkRows.js rowToRun). */
export interface WordedRun {
    id?: string;
    status?: string | null;
    error?: string | null;
    planId?: string | null;
    outcome?: { kind: string; stepId: string | null; sourceStepId: string | null } | null;
    failure?: { stepId: string; errorClass: string | null; sourceStepId: string | null };
}

/** The plan a run followed, as far as the words need it: each step's title, and the tool it calls. */
export interface PlanWords { titles: ReadonlyMap<string, string>; tools: ReadonlyMap<string, string> }

const FAILED: ReadonlySet<string> = new Set(['error', 'failed', 'timeout', 'cancelled', 'incomplete', 'needs_reauth']);
const hasAny = (text: string, parts: readonly string[]): boolean => parts.some((p) => text.includes(p));

const NOT_ALLOWED = ['no longer have permission to use', 'could not verify your permission'];
const SIGNED_OUT = ['sign in again', 're-authenticate', 'reauthenticate', 'invalid_grant', 'token expired', 'token has expired', 'session expired', 'session has expired', 'sign-in expired', 'sign-in has expired'];
const TOO_LONG = ['took too long', 'timed out', 'timeout', 'deadline'];
const WAITS = ['waits for its owner'];
const UNREAD = ['did not resolve', 'unresolved'];
const AI_SAYS = 'The AI says: ';
const NOTHING: RunWords = { cause: 'nothing_to_do', step: null, source: null, app: null, reason: null };

/** A title a person can read: not an id, not a tool name, not a reference. Null otherwise. */
function readable(title: string | null | undefined, id: string | null = null): string | null {
    const text = (title ?? '').trim();
    if (!text || text === id || text.includes('{{')) return null;
    return text.includes(' ') || !text.includes('_') ? text : null;
}

/** The name of the app a tool belongs to ("Fireflies"), from what a person calls the tool ("Fireflies: list transcripts"). */
function appNameOf(tool: string | null | undefined, lookups: Lookups): string | null {
    if (!tool) return null;
    try {
        const label = lookups.labelOfTool?.(tool)?.trim() ?? '';
        const colon = label.indexOf(':');
        return (colon > 0 ? label.slice(0, colon) : label).trim() || null;
    } catch (e) {
        return fallback('usecases/coworkRunWords:appNameOf', e, null);
    }
}

/** The tool an engine refusal names between quotes ('… permission to use "fireflies_list_transcripts". …'). */
function quotedTool(error: string): string | null {
    const open = error.indexOf('"');
    const close = open >= 0 ? error.indexOf('"', open + 1) : -1;
    const name = close > open ? error.slice(open + 1, close).trim() : '';
    return name && !name.includes(' ') ? name : null;
}

/** What a failed run's class is read from: its status, its outcome code, the step it failed at, and its error in lower case. */
interface Failed { status: string; kind: string; stepId: string | null; errorClass: string; text: string }

/** The classes in the order they are asked: the first whose test holds is the run's. */
const CAUSES: ReadonlyArray<readonly [RunCause, (f: Failed) => boolean]> = [
    ['nothing_found', (f) => f.status === 'incomplete' || f.kind === 'incomplete'],
    ['ai_failed', (f) => f.kind === 'ai_failed'],
    ['permission', (f) => hasAny(f.text, NOT_ALLOWED)],
    ['sign_in', (f) => f.status === 'needs_reauth' || hasAny(f.text, SIGNED_OUT)],
    ['waits', (f) => hasAny(f.text, WAITS)],
    ['reads', (f) => !!f.stepId && (hasAny(f.text, UNREAD) || f.errorClass.includes('unresolved'))],
    ['timeout', (f) => f.status === 'timeout' || hasAny(f.text, TOO_LONG)],
    ['step', (f) => !!f.stepId],
];

/** The class of a failed run, from its status, its outcome code and the engine's own refusals (never shown themselves). */
function causeOfFailure(run: WordedRun, error: string): RunCause {
    const failed: Failed = {
        status: run.status ?? '', kind: run.outcome?.kind ?? '', stepId: run.failure?.stepId ?? null,
        errorClass: run.failure?.errorClass ?? '', text: error.toLowerCase(),
    };
    return CAUSES.find(([, holds]) => holds(failed))?.[0] ?? 'other';
}

/** The step a failed run is about and the step that one reads, by their ids. */
function stepsOfRun(run: WordedRun): { stepId: string | null; sourceId: string | null } {
    const at = run.failure ?? run.outcome ?? null;
    return { stepId: at?.stepId ?? null, sourceId: at?.sourceStepId ?? null };
}

/** A step's title for a person, from the plan the run followed. */
const titleOf = (plan: PlanWords | null, id: string | null): string | null => (id && plan ? readable(plan.titles.get(id), id) : null);

/** The AI's own reason of a failed verdict, when it reads as a sentence for its owner. */
function aiReasonOf(error: string): string | null {
    if (!error.startsWith(AI_SAYS)) return null;
    const reason = error.slice(AI_SAYS.length).trim();
    return reason && !reason.includes('{{') && !reason.toLowerCase().includes('automation') ? reason : null;
}

/** What a run's sentence is made of; null for a run that went well and has nothing to say. */
export function runWordsOf(run: WordedRun, plan: PlanWords | null, lookups: Lookups = toolLookups()): RunWords | null {
    if (!FAILED.has(run.status ?? '')) return run.outcome?.kind === 'nothing_to_do' ? NOTHING : null;
    const error = run.error ?? '';
    const cause = causeOfFailure(run, error);
    const { stepId, sourceId } = stepsOfRun(run);
    return {
        cause,
        step: titleOf(plan, stepId),
        source: titleOf(plan, sourceId),
        app: appOfFailure(cause, (stepId && plan?.tools.get(stepId)) || null, error, lookups),
        reason: cause === 'ai_failed' ? aiReasonOf(error) : null,
    };
}

/** The app a failure names: of the step's own tool, or (an app that is no longer allowed) of the tool the refusal names. */
function appOfFailure(cause: RunCause, stepTool: string | null, error: string, lookups: Lookups): string | null {
    if (cause === 'permission') return appNameOf(stepTool ?? quotedTool(error), lookups);
    return cause === 'sign_in' ? appNameOf(stepTool, lookups) : null;
}

const SENTENCE: Readonly<Record<RunCause, (w: RunWords) => string>> = {
    permission: (w) => {
        if (w.step) return `'${w.step}' could not run: ${w.app ?? 'an app this task uses'} is no longer allowed for this task.`;
        return `${w.app ?? 'An app this task uses'} is no longer allowed for this task.`;
    },
    sign_in: (w) => `The sign-in of ${w.app ?? 'an app'} ran out${w.step ? `, so '${w.step}' could not run` : ''}. Sign in again, then run it again.`,
    reads: (w) => {
        if (!w.step) return 'A step could not read what it needs from an earlier step.';
        return w.source ? `'${w.step}' could not read what it needs from '${w.source}'.` : `'${w.step}' could not read what it needs.`;
    },
    nothing_found: (w) => {
        if (!w.step) return 'A step found nothing to work on, so the run did not do its work.';
        return w.source ? `'${w.step}' got nothing to work on from '${w.source}', so the run did not do its work.` : `'${w.step}' found nothing to work on, so the run did not do its work.`;
    },
    ai_failed: (w) => (w.reason ? `${AI_SAYS}${w.reason}` : 'The AI says it could not do what the task asks.'),
    nothing_to_do: () => 'The AI checked and found nothing to do this time.',
    timeout: () => 'The run took too long and was stopped.',
    waits: () => 'It did not run: the task waits for you to approve its steps.',
    step: (w) => (w.step ? `'${w.step}' did not work.` : 'A step did not work.'),
    other: () => 'The run did not finish.',
};

/** The one sentence of a run's words. */
export const plainSentence = (words: RunWords): string => SENTENCE[words.cause](words);

/** A plan's definition as the words read it. */
export function planWordsOf(definition: unknown, lookups: ToolLookups = toolLookups()): PlanWords {
    const titles = new Map<string, string>();
    const tools = new Map<string, string>();
    for (const step of planViewOf(definition as Definition, lookups).steps) {
        titles.set(step.id, step.title);
        if (step.tool) tools.set(step.id, step.tool);
    }
    return { titles, tools };
}

export interface PlainDeps {
    /** The plan one run followed, as approved then (stores/coworkPlans.mts getPlanRun); null for a run without one. */
    planOfRun: (scheduleId: string, runId: string) => Promise<{ plan: { definition: unknown } } | null>;
    lookups: ToolLookups;
}

const plainDefaults = (): PlainDeps => ({
    planOfRun: (scheduleId, runId) => (nodeRequire('../stores/coworkStore.js') as { getPlanRun: PlainDeps['planOfRun'] }).getPlanRun(scheduleId, runId),
    lookups: toolLookups(),
});

/** The plan a failed run followed, read once per plan (`known`); null for a run that followed none, or that went well. */
async function planOfFailed(scheduleId: string, run: WordedRun, known: Map<string, PlanWords | null>, deps: PlainDeps): Promise<PlanWords | null> {
    if (!run.id || !run.planId || !FAILED.has(run.status ?? '')) return null;
    if (!known.has(run.planId)) {
        const found = await deps.planOfRun(scheduleId, run.id).catch((e: unknown) => fallback('usecases/coworkRunWords:planOfRun', e, null));
        known.set(run.planId, found ? planWordsOf(found.plan.definition, deps.lookups) : null);
    }
    return known.get(run.planId) ?? null;
}

/** The words of one run of an item. */
export async function wordsOfRun(scheduleId: string, run: WordedRun, known: Map<string, PlanWords | null> = new Map(), deps: PlainDeps = plainDefaults()): Promise<RunWords | null> {
    try {
        return runWordsOf(run, await planOfFailed(scheduleId, run, known, deps), deps.lookups);
    } catch (e) {
        return fallback('usecases/coworkRunWords:wordsOfRun', e, null);
    }
}

/** The runs of one item, each with `plain`: how it ended in its owner's words, or null. */
export async function withPlainWords<R extends WordedRun>(scheduleId: string, runs: R[], deps: PlainDeps = plainDefaults()): Promise<Array<R & { plain: string | null }>> {
    const known = new Map<string, PlanWords | null>();
    const out: Array<R & { plain: string | null }> = [];
    for (const run of runs) {
        const words = await wordsOfRun(scheduleId, run, known, deps);
        out.push({ ...run, plain: words ? plainSentence(words) : null });
    }
    return out;
}
