/**
 * The findings the editor shows, from three sources that answer at different
 * times: every save (draft-stage warnings, or a 400's details), the last
 * activation attempt (strict-stage details), and the AI builder's last
 * `validation_errors`. Each source is replaced wholesale by its next answer;
 * this merges them, drops duplicates, and maps them to steps with
 * model/issues.ts.
 */

import type { IssueSource, IssueSources } from './types';
import type { FlowIssue, IssueSet } from '../api/types';
import { buildIssuesByStep, type InlineScope, type StepIssues } from '../model/issues';
import { bodyOf } from '../model/outline/nested';
import type { FlowDefinition, FlowStep } from '../model/types';

export const NO_ISSUES: IssueSet = Object.freeze({ errors: [], warnings: [] }) as IssueSet;

export function emptyIssueSources(): IssueSources {
    return { save: NO_ISSUES, activate: NO_ISSUES, builder: NO_ISSUES };
}

const ORDER: readonly IssueSource[] = ['activate', 'save', 'builder'];

function keyOf(issue: FlowIssue): string {
    return [issue.severity, issue.code ?? '', issue.path ?? '', issue.message].join('\u0000');
}

function unique(lists: FlowIssue[][]): FlowIssue[] {
    const seen = new Set<string>();
    const out: FlowIssue[] = [];
    for (const issue of lists.flat()) {
        const key = keyOf(issue);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(issue);
    }
    return out;
}

/** Every source in one set; the activation's findings first — they are what blocks going live. */
export function mergeIssues(sources: IssueSources): IssueSet {
    return {
        errors: unique(ORDER.map((s) => sources[s].errors)),
        warnings: unique(ORDER.map((s) => sources[s].warnings)),
    };
}

/**
 * Every loop's body as an inline scope keyed by its address (`loop_1`,
 * `loop_1/loop_2`), with its steps' addresses: a finding about a step inside
 * a loop is then that step's, not only its loop's — its card shows it and
 * the step editor finds it under the step's own address.
 */
function loopScopes(definition: FlowDefinition | null): [string, InlineScope][] {
    const out: [string, InlineScope][] = [];
    const visit = (steps: readonly FlowStep[], prefix: string | null) => {
        for (const step of steps) {
            const address = prefix ? `${prefix}/${step.id}` : step.id;
            const body = bodyOf(step);
            if (step.type !== 'loop' || body.length === 0) continue;
            out.push([address, { kind: 'loop', callStepId: step.id, childIds: body.map((c) => `${address}/${c.id}`) }]);
            visit(body, address);
        }
    };
    visit(definition?.steps ?? [], null);
    return out;
}

/** The per-step map the outline and the canvas badge from. */
export function issuesByStepFor(issues: IssueSet, definition: FlowDefinition | null): Map<string, StepIssues> {
    return buildIssuesByStep(issues, definition, loopScopes(definition));
}
