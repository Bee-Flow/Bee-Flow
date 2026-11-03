/**
 * ── THE REJECTED BRANCH OF AN APPROVAL ─────────────────────────────────────
 *
 * An edge labelled 'on_rejected' (one of constants.js KNOWN_EDGE_LABELS)
 * leaves an approval and runs only when the approver REJECTS: the decision
 * resumes the run like an approve does, with `approved: false` in the step's
 * output (approvalOutput.mts). Without such an edge a reject ends the run as
 * before (ApprovalRejected). An approve never follows it; a reject follows
 * nothing else. The approval is deliberately NOT a brancher (BRANCHER_TYPES):
 * its plain edges keep meaning "on approve", exactly as before the branch
 * existed.
 *
 * WHO READS THIS (keep them in step when the rule changes):
 *   1. automation/approvalDecision.js        reject resumes when the pinned
 *                                            definition wires this edge
 *   2. core/automationRunner/runDagRecord.js approvalRouteLabel below: the
 *      core/automationRunner/runDag.js       live dispatch and the replay route
 *   3. automation/validate/graphEdges.js     only from an approval, at most one
 *   4. automation/builderTools/draftGraph.js branch:"rejected" wires it; the
 *      builder prompt and schemas say how
 *   5. the editors: agent-hub …/Builder/flow/branchEdges.ts (the approval
 *      node's 'On rejected' port), routeEdges.ts, layout.ts; mobile
 *      flow-editor canvas edgeModel.ts / ports.ts / chips.ts
 *
 * Pure, requires nothing.
 */

export const ON_REJECTED_LABEL = 'on_rejected';

/** The step types an 'on_rejected' edge may leave. */
export const ON_REJECTED_SOURCE_TYPES: ReadonlySet<string> = new Set(['approval']);

/**
 * The label an APPROVAL routes on, from its decision: a rejection follows only
 * its 'on_rejected' edge; anything else (an approve, a pinned or synthesised
 * output without `approved: false`) routes as a plain success, which never
 * matches 'on_rejected'. Null for every other step type. The ONE rule for the
 * live dispatch and the replay of a resume, so both take the same edge.
 */
export function approvalRouteLabel(step: { type?: unknown } | null | undefined, output: unknown): string | null {
    if (step?.type !== 'approval') return null;
    const decided = output && typeof output === 'object' ? (output as { approved?: unknown }) : null;
    return decided?.approved === false ? ON_REJECTED_LABEL : null;
}
