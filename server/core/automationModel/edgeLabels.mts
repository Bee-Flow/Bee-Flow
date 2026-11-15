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
 * ── THE EXPIRED BRANCH OF AN APPROVAL ──────────────────────────────────────
 *
 * An edge labelled 'on_expired' leaves an approval and runs only when NOBODY
 * decided before the deadline: the reaper resumes the run along it, with
 * `approved: false, expired: true` in the step's output (approvalOutput.mts),
 * instead of closing the run as ApprovalExpired. Without such an edge the run
 * closes on expiry exactly as before. A reject never follows it (a reject
 * follows 'on_rejected' only), an approve never does either. Same readers as
 * above, plus core/automationRunner/approvalExpiry.mts (the reaper's half, in
 * place of approvalDecision.js) and the validator's expired-label rules.
 *
 * Pure, requires nothing.
 */

export const ON_REJECTED_LABEL = 'on_rejected';
export const ON_EXPIRED_LABEL = 'on_expired';

/** The step types an 'on_rejected' edge may leave. */
export const ON_REJECTED_SOURCE_TYPES: ReadonlySet<string> = new Set(['approval']);

/** The step types an 'on_expired' edge may leave. */
export const ON_EXPIRED_SOURCE_TYPES: ReadonlySet<string> = new Set(['approval']);

/** Does `edges` hold an edge with `label` out of `stepId`? (Whether an approval has a rejected or an expired branch.) */
export function hasEdgeLabelled(edges: unknown, stepId: string | null | undefined, label: string): boolean {
    if (!Array.isArray(edges) || !stepId) return false;
    return edges.some((e) => !!e && typeof e === 'object' && (e as { from?: unknown }).from === stepId && (e as { label?: unknown }).label === label);
}

/**
 * The label an APPROVAL routes on, from its decision: a rejection follows only
 * its 'on_rejected' edge, an expiry (`approved: false, expired: true`, only
 * ever handed in by the reaper when an 'on_expired' edge exists) only its
 * 'on_expired' edge; anything else (an approve, a pinned or synthesised output
 * without `approved: false`) routes as a plain success, which matches neither.
 * Null for every other step type. The ONE rule for the live dispatch and the
 * replay of a resume, so both take the same edge.
 */
export function approvalRouteLabel(step: { type?: unknown } | null | undefined, output: unknown): string | null {
    if (step?.type !== 'approval') return null;
    const decided = output && typeof output === 'object' ? (output as { approved?: unknown; expired?: unknown }) : null;
    if (decided?.approved !== false) return null;
    return decided.expired === true ? ON_EXPIRED_LABEL : ON_REJECTED_LABEL;
}
