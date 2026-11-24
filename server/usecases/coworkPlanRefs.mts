/**
 * Does every list a plan's steps work through exist in what the earlier step returns? Checked when a plan is judged for
 * approval (./coworkPlan.mts draftOf), while the planner and the amend mode draft one (their findings go back to the
 * model, ./coworkDraftLoop.mts), and on the try-out's actual outputs (./coworkPlanTry.mts, with
 * core/cowork/runOutcome.mts). Here, not in core: it reads the builder's shape checker (automation/builderTools).
 *
 * A step that runs once per item, a Loop and a list step (filter, limit, ...) name their list as a reference to an
 * earlier step's output. When that output's shape is DESCRIBED (the tool's curated output schema,
 * automation/outputSchemas.js, or what the step's own configuration declares), the reference is walked over it with the
 * builder's own checker (automation/builderTools/refCheck.js): a field the described output does not have, or a value
 * that is not a list, is a finding with a plain sentence ("Step 'Get summaries' reads `transcripts` from 'List
 * meetings', which returns no such field."), and the checker's one obvious fix is named when it has one. An output
 * nobody described is never a reason for a finding: no shape, no complaint.
 *
 * The WIRING of the plan is judged here too (core/cowork/plan/planWiring.mts): a reference to a step that is not in
 * the plan, or that does not run before the step that reads it, and an AI step that starts before the reads it should
 * work on. Those stop an approval; a read nobody uses is advice for the planner (`draftFindings`). What an output holds
 * comes from the builder's shapes (`knowsPath`), so the wiring check and the reference check agree.
 *
 * Not part of core/cowork/plan/planChecks.mts on purpose: that one also runs before every run, and a reference is not a rule about
 * what a plan may do. A broken reference in an approved plan makes the run incomplete (core/cowork/runOutcome.mts) and is
 * fixed by itself when it can be (core/cowork/repairs/autoResolve.mts); it never stops the run from starting.
 */

import { createRequire } from 'node:module';
import type { Definition, PlanFinding, ToolLookups } from '../core/cowork/plan/planTypes.mts';
import { planViewOf } from '../core/cowork/plan/planView.mts';
import { listRefsOf, type ListRef } from '../core/cowork/runOutcome.mts';
import { WIRING_BLOCKING, WIRING_CODES, wiringFindings, type KnowsPath, type WiringOptions } from '../core/cowork/plan/planWiring.mts';

const nodeRequire = createRequire(import.meta.url);

type Token = { type: string; key: unknown };
type Problem = { kind: string; reason?: string; sure?: boolean; here?: string[] };
const { checkRefTokens, stepOutputShape } = nodeRequire('../automation/builderTools/refCheck.js') as {
    checkRefTokens: (graph: unknown, tokens: Token[], opts: { wantList?: boolean }) => { tokens: Token[]; fixes: string[]; problem?: Problem };
    stepOutputShape: (step: unknown, graph: unknown) => { t?: string } | null;
};
const { normalizeAiPath } = nodeRequire('../automation/builderTools/aiPaths.js') as { normalizeAiPath: (p: string) => { tokens: Token[] | null } };
const { formatPath } = nodeRequire('../automation/expr.js') as { formatPath: (t: Token[]) => string };

/** The code of a reference finding. */
export const REF_FINDING = 'ref.missing';

/** A finding about references and wiring: Undo of an earlier version brings it back all the same (usecases/coworkPlan.mts). */
export const isReferenceFinding = (code: string): boolean => code === REF_FINDING || WIRING_CODES.has(code);

/** Does a step's DESCRIBED output have this path? null when nobody described it (no shape, no complaint). */
export const knowsPath: KnowsPath = (step, keys, definition) => {
    let shape;
    try { shape = stepOutputShape(step, definition); } catch { return null; }
    if (!shape || shape.t === 'any' || typeof step.id !== 'string') return null;
    const tokens = ['steps', step.id, 'output', ...keys].map((key) => ({ type: 'prop', key }));
    try { return !checkRefTokens(definition, tokens, {}).problem; } catch { return null; }
};

export const WIRING_OPTIONS: WiringOptions = { knowsPath };

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
    return { code: REF_FINDING, stepId: ref.stepId, message: `${base}${fixed ? ` Use \`${fixed}\`.` : has}` };
}

/** The references of this plan that do not resolve on the described output of the step they read, and its miswiring. */
export function refFindings(definition: Definition | null | undefined, lookups: ToolLookups): PlanFinding[] {
    const wiring = wiringFindings(definition, lookups, WIRING_OPTIONS).filter((f) => WIRING_BLOCKING.has(f.code)).map(({ code, stepId, message }) => ({ code, stepId, message }));
    return [...listFindings(definition, lookups), ...wiring];
}

/** What the planner and the amend mode hear about a draft: the findings, and the advice (a read nobody uses). */
export function draftFindings(definition: Definition | null | undefined, lookups: ToolLookups): PlanFinding[] {
    const advice = wiringFindings(definition, lookups, { ...WIRING_OPTIONS, advice: true }).filter((f) => !WIRING_BLOCKING.has(f.code)).map(({ code, stepId, message }) => ({ code, stepId, message }));
    return [...refFindings(definition, lookups), ...advice];
}

/** The list references that do not resolve on the described output of the step they read. */
function listFindings(definition: Definition | null | undefined, lookups: ToolLookups): PlanFinding[] {
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
