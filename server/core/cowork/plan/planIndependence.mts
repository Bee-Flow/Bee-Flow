/**
 * How independent a plan may be: the three levels its owner chooses from, and the copy of the plan a run executes
 * at that level.
 *
 *   asks_everything      every step that changes or sends something waits for the owner's decision;
 *   asks_before_sending  it changes things inside its own reach (a table, a draft) on its own; anything that leaves
 *                        Bee Flow (a mail or a message to someone) waits for the owner's decision;
 *   on_its_own           it runs as approved. Offered once the owner approved ON_ITS_OWN_AFTER runs of this version
 *                        without stopping one (and, from 2.2, when the organisation's ceiling allows it).
 *
 * A level adds questions; it never removes a step and never changes one. The question is an approval step placed in
 * front of the step it is about; a step inside a loop is asked about once, in front of its outermost loop, so a run
 * asks once per part and not once per item. A result for the owner ('deliver') and the plan's own questions are never
 * asked about. The approved plan and its fingerprint stay as they are: this is derived at run time, like the rest of
 * the run copy (./planRunCopy.mts), and the run keeps the level it started with across a pause.
 */

import type { Definition, DefStep, Effect, PlanStep, ToolLookups } from './planTypes.mts';
import { planViewOf } from './planView.mts';
import { stepsOf } from './planWalk.mts';

export type Independence = 'asks_everything' | 'asks_before_sending' | 'on_its_own';
export const INDEPENDENCE_LEVELS: readonly Independence[] = Object.freeze(['asks_everything', 'asks_before_sending', 'on_its_own']);
/** The level of a plan whose owner chose none. */
export const DEFAULT_INDEPENDENCE: Independence = 'asks_before_sending';
/** Runs of one approved version the owner let through before "on its own" is offered. */
export const ON_ITS_OWN_AFTER = 10;
/** The id of the question in front of a step: never one an author can write (the plan grammar has no such ids). */
export const ASK_PREFIX = 'cowork_ask__';

export function isIndependence(value: unknown): value is Independence {
    return typeof value === 'string' && (INDEPENDENCE_LEVELS as readonly string[]).includes(value);
}

/** Does this level ask before a step like this one? */
function asksBefore(step: PlanStep, level: Independence): boolean {
    if (level === 'on_its_own' || step.kind === 'ask' || step.kind === 'deliver') return false;
    const asked: readonly Effect[] = level === 'asks_everything' ? ['writes', 'sends'] : ['sends'];
    return asked.includes(step.effect);
}

export interface AskTarget {
    /** The top-level step the question stands in front of. */
    id: string;
    /** What the question is about: the first step under it that made it ask. */
    title: string;
    effect: Effect;
}

/** The top-level steps a run at this level asks before, in the plan's order. */
export function askTargets(definition: Definition | null | undefined, level: Independence, lookups: ToolLookups): AskTarget[] {
    if (level === 'on_its_own') return [];
    const parentOf = new Map(stepsOf(definition).map((s) => [s.id, s.parentId]));
    const rootOf = (id: string): string => {
        let at = id;
        for (let parent = parentOf.get(at); parent; parent = parentOf.get(at)) at = parent;
        return at;
    };
    const out = new Map<string, AskTarget>();
    for (const step of planViewOf(definition, lookups).steps) {
        // A loop says what its steps do; those steps decide, and name the question.
        if (step.type === 'loop' || !asksBefore(step, level)) continue;
        const root = rootOf(step.id);
        if (!out.has(root)) out.set(root, { id: root, title: step.title, effect: step.effect });
    }
    return [...out.values()];
}

/** The question in front of one target, as an approval step of the engine; it asks the run's owner (no approvers named). */
function questionFor(target: AskTarget): DefStep {
    const what = target.effect === 'sends' ? 'Before it sends' : 'Before it changes something';
    return {
        id: `${ASK_PREFIX}${target.id}`,
        type: 'approval',
        label: `${what}: ${target.title}`,
        prompt: `${what}: "${target.title}". Approve to let it go ahead, or reject to stop this run here.`,
    };
}

interface Edge { from?: unknown; to?: unknown; [key: string]: unknown }

/** The plan with a question in front of every step this level asks about; the plan itself when it asks about none. */
export function withAsks(definition: Definition, level: Independence, lookups: ToolLookups): Definition {
    const targets = askTargets(definition, level, lookups);
    if (targets.length === 0 || !Array.isArray(definition.steps)) return definition;
    let steps = [...(definition.steps as DefStep[])];
    let edges = Array.isArray(definition.edges) ? [...(definition.edges as Edge[])] : [];
    for (const target of targets) {
        const at = steps.findIndex((s) => s?.id === target.id);
        if (at < 0) continue;
        const question = questionFor(target);
        steps = [...steps.slice(0, at), question, ...steps.slice(at)];
        // Whatever led to the step leads to its question; the question leads to the step.
        edges = edges.map((e) => (e.to === target.id ? { ...e, to: question.id } : e));
        edges.push({ from: question.id, to: target.id });
    }
    return { ...definition, steps, edges };
}

export const ASKING_NOT_AVAILABLE = 'This plan asks you before it acts, and asking needs approvals, which your organisation\'s Bee Flow plan does not include. Choose "On its own", or ask your administrator.';

/**
 * The level a run uses: the owner's choice; with none, asking before sending where asking is possible, else on its
 * own (the approval of the plan is then the only question). A choice to be asked that cannot be honoured throws: a
 * run never goes ahead without the question its owner asked for.
 */
export function effectiveIndependence(chosen: unknown, mayAsk: boolean): Independence {
    if (!isIndependence(chosen)) return mayAsk ? DEFAULT_INDEPENDENCE : 'on_its_own';
    if (chosen !== 'on_its_own' && !mayAsk) throw new Error(ASKING_NOT_AVAILABLE);
    return chosen;
}
