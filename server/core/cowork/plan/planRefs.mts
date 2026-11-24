/**
 * Does every list a plan's steps work through exist in what the earlier step returns? Checked when a plan is judged for
 * approval (usecases/coworkPlan.mts draftOf), while the planner and the amend mode draft one (their findings go back to
 * the model, usecases/coworkDraftLoop.mts), and on the try-out's actual outputs (usecases/coworkPlanTry.mts, with
 * ../runOutcome.mts).
 *
 * A step that runs once per item, a Loop and a list step (filter, limit, ...) name their list as a reference to an
 * earlier step's output. When that output's shape is DESCRIBED (the tool's curated output schema,
 * automation/outputSchemas.js, or what the step's own configuration declares), the reference is walked over it with the
 * builder's own checker (automation/builderTools/refCheck.js): a field the described output does not have, or a value
 * that is not a list, is a finding with a plain sentence ("Step 'Get summaries' reads `transcripts` from 'List
 * meetings', which returns no such field."), and the checker's one obvious fix is named when it has one. An output
 * nobody described is never a reason for a finding: no shape, no complaint.
 *
 * Not part of ./planChecks.mts on purpose: that one also runs before every run, and a reference is not a rule about
 * what a plan may do. A broken reference in an approved plan makes the run incomplete (../runOutcome.mts) and is fixed
 * by itself when it can be (../repairs/autoResolve.mts); it never stops the run from starting.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding, ToolLookups } from './planTypes.mts';
import { planViewOf } from './planView.mts';
import { listRefsOf, type ListRef } from '../runOutcome.mts';

const nodeRequire = createRequire(import.meta.url);

type Token = { type: string; key: unknown };
type Problem = { kind: string; reason?: string; sure?: boolean; here?: string[] };
const { checkRefTokens } = nodeRequire('../../../automation/builderTools/refCheck.js') as {
    checkRefTokens: (graph: unknown, tokens: Token[], opts: { wantList?: boolean }) => { tokens: Token[]; fixes: string[]; problem?: Problem };
};
const { normalizeAiPath } = nodeRequire('../../../automation/builderTools/aiPaths.js') as { normalizeAiPath: (p: string) => { tokens: Token[] | null } };
const { formatPath } = nodeRequire('../../../automation/expr.js') as { formatPath: (t: Token[]) => string };

/** The field a reference reads, after `steps.<id>.output.`. */
function fieldOf(ref: ListRef): string {
    const prefix = `steps.${ref.sourceStepId}.output.`;
    return ref.ref.startsWith(prefix) ? ref.ref.slice(prefix.length) : ref.ref;
}

/** A problem the walk is sure enough of to say: a key a closed (described) object does not have, or no list. */
function said(problem: Problem | undefined): boolean {
    if (!problem) return false;
    if (problem.kind === 'not-a-list') return true;
    return problem.kind === 'broken' && (problem.reason === 'missing' || problem.reason === 'scalar');
}

function findingOf(ref: ListRef, titles: Map<string, string>, problem: Problem | undefined, fixed: string | null): PlanFinding {
    const step = titles.get(ref.stepId) ?? ref.stepId;
    const source = titles.get(ref.sourceStepId) ?? ref.sourceStepId;
    const base = problem?.kind === 'not-a-list'
        ? `Step '${step}' reads \`${fieldOf(ref)}\` from '${source}' as a list, but it is no list.`
        : `Step '${step}' reads \`${fieldOf(ref)}\` from '${source}', which returns no such field.`;
    const has = problem?.here?.length ? ` It returns: ${problem.here.slice(0, 8).join(', ')}.` : '';
    return { code: 'ref.missing', stepId: ref.stepId, message: `${base}${fixed ? ` Use \`${fixed}\`.` : has}` };
}

/** The references of this plan that do not resolve on the described output of the step they read. */
export function refFindings(definition: Definition | null | undefined, lookups: ToolLookups): PlanFinding[] {
    const refs = listRefsOf(definition);
    if (refs.length === 0) return [];
    const titles = new Map(planViewOf(definition, lookups).steps.map((s) => [s.id, s.title]));
    const out: PlanFinding[] = [];
    for (const ref of refs) {
        const tokens = normalizeAiPath(ref.ref).tokens;
        if (!tokens) continue;
        let checked;
        try { checked = checkRefTokens(definition, tokens, { wantList: true }); } catch { continue; }
        const rewritten = formatPath(checked.tokens);
        if (said(checked.problem)) out.push(findingOf(ref, titles, checked.problem, null));
        else if (!checked.problem && checked.fixes.length > 0 && rewritten !== ref.ref) out.push(findingOf(ref, titles, undefined, rewritten));
    }
    return out;
}
