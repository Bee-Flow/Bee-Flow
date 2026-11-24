/**
 * The tools a Cowork run used, in the words a person reads (routes/cowork.js GET /:id/runs): beside each tool's name
 * and app, what a person calls it ("Outlook: create draft") and what it does to the world (reads, writes, sends), from
 * the same lookups a plan is read with (core/cowork/plan/planLookups.mts). The task's Steps list shows "what it did
 * last time" with these, never a raw tool name.
 *
 * Cowork's own tools (asking for a review, giving its verdict) are marked `internal`: they are no step of the work.
 * A lookup that fails costs the words, never the history.
 */

import { createRequire } from 'node:module';
import type { Effect, ToolLookups } from '../core/cowork/plan/planTypes.mts';
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
