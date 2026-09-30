/**
 * The per-step run row the outline and the canvas decorate from — one place
 * that answers "what happened at this node". A port of the web builder's
 * flow/runStatus.js `effectiveRunByStep`, pinned by run.lockstep.test.ts
 * (differential):
 *
 *   - primary rows only: a `parentStepId` row is a flowlet call's internal
 *     step and must not shadow the call's own row — unless the flowlet is
 *     open inline, where the runner's `<callId>/<subId>` id IS a node;
 *   - the latest attempt wins (then the later start), so a retried step does
 *     not show its stale failure;
 *   - a pinned node with no row reads as a node with data: a `pinned` stub,
 *     unless the pin is the server's truncation placeholder. A real row wins
 *     over the stub — the server replays a pin as a `pinned` row itself.
 */

import { isTruncatedOutput } from '@/features/flow-editor/bindings';
import type { AnyNode, DefinitionInput } from '@/features/flow-editor/model';
import { isInlineId } from '@/features/flow-editor/model/layout';

/** A run row, as far as the decoration reads one. */
export interface RunRowLike {
    stepId?: string | null;
    parentStepId?: string | null;
    status?: string | null;
    output?: unknown;
    attempts?: number | null;
    startedAt?: string | null;
}

function nodesOf(definition: DefinitionInput): AnyNode[] {
    const nodes: AnyNode[] = [];
    if (definition?.trigger?.id) nodes.push(definition.trigger);
    for (const t of definition?.triggers || []) if (t?.id) nodes.push(t);
    for (const s of definition?.steps || []) if (s?.id) nodes.push(s);
    return nodes;
}

const startOf = (row: RunRowLike): number => (row.startedAt ? Date.parse(row.startedAt) || 0 : 0);

/** Strict comparisons keep the first record on equal keys, so the order stays stable. */
function isNewer(row: RunRowLike, current: RunRowLike): boolean {
    const attempts = Number(row.attempts || 0);
    const currentAttempts = Number(current.attempts || 0);
    return attempts > currentAttempts || (attempts === currentAttempts && startOf(row) > startOf(current));
}

export function effectiveRunByStep<R extends RunRowLike>(definition: DefinitionInput, runSteps: readonly R[] | null | undefined): Map<string, R | RunRowLike> {
    const byStep = new Map<string, R | RunRowLike>();
    const nodes = nodesOf(definition);
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const row of runSteps || []) {
        if (!row?.stepId) continue;
        if (row.parentStepId && !(isInlineId(row.stepId) && nodeIds.has(row.stepId))) continue;
        const current = byStep.get(row.stepId);
        if (!current || isNewer(row, current)) byStep.set(row.stepId, row);
    }
    for (const node of nodes) {
        if (byStep.has(node.id)) continue;
        if (node.pinnedOutput == null || isTruncatedOutput(node.pinnedOutput)) continue;
        byStep.set(node.id, { stepId: node.id, status: 'pinned', output: node.pinnedOutput });
    }
    return byStep;
}
