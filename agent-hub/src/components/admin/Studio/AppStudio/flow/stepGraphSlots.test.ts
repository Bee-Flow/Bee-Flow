import { describe, expect, it } from 'vitest';
import { graphToSteps, scopesOf, stepsToGraph, stripStepIds, withStepIds } from './stepGraph';
import type { FlowStep } from './stepGraph';
import { newStep, stepMeta } from './stepKinds';

/**
 * The container kinds of the step registry (while, try) on the flow canvas:
 * drawn like a loop, one branch per child slot, and read back without changing
 * the action.
 */

const toast = (message: string): FlowStep => ({ kind: 'toast', message, tone: 'info' });

const roundTrip = (steps: FlowStep[]) => {
    const tagged = withStepIds({ kind: 'sequence', steps });
    const { nodes, edges } = stepsToGraph(tagged);
    return stripStepIds(graphToSteps(nodes, edges));
};

/** Each scope as [key, label, number of steps]. */
const scopeRows = (step: FlowStep) => scopesOf(step).map((scope) => [scope.key, scope.label, scope.steps?.length]);

describe('registry containers on the flow canvas', () => {
    it('a while has one branch, its body', () => {
        expect(scopeRows({ kind: 'while', expr: 'vars.go', steps: [toast('a')] })).toEqual([['steps', 'While it holds', 1]]);
    });

    it('a try has three branches in the order its steps are numbered, also the ones it does not carry yet', () => {
        expect(scopeRows({ kind: 'try', steps: [toast('a')] })).toEqual([
            ['steps', 'Try', 1], ['catch', 'If a step fails', undefined], ['finally', 'Always, at the end', undefined],
        ]);
    });

    it('branch labels are translated', () => {
        const t = (key: string | undefined) => `t:${String(key)}`;
        expect(scopesOf({ kind: 'try', steps: [] }, t).map((scope) => scope.label)).toEqual([
            't:studio_apps_flow_control.scope.try_steps', 't:studio_apps_flow_control.scope.try_catch', 't:studio_apps_flow_control.scope.try_finally',
        ]);
    });

    it('the graph holds a node per child, in a scope of its container', () => {
        const tagged = withStepIds({ kind: 'sequence', steps: [{ kind: 'try', steps: [toast('a')], catch: [toast('b')], finally: [toast('c')] }] });
        const { nodes } = stepsToGraph(tagged);
        expect(nodes.filter((n) => !n.isEntry).map((n) => `${n.scopeKey ?? '-'}:${n.kind}`)).toEqual(['-:try', 'steps:toast', 'catch:toast', 'finally:toast']);
        expect(nodes.filter((n) => n.isEntry).map((n) => n.scopeLabel)).toEqual(['Try', 'If a step fails', 'Always, at the end']);
    });

    it('opening an action on the canvas does not change it: an absent catch or finally stays absent, an empty one stays empty', () => {
        const actions: FlowStep[][] = [
            [{ kind: 'try', steps: [toast('a')] }],
            [{ kind: 'try', steps: [toast('a')], catch: [] }],
            [{ kind: 'try', steps: [], finally: [toast('f')] }],
            [{ kind: 'while', expr: 'vars.go', maxIterations: 5, steps: [{ kind: 'try', steps: [{ kind: 'break' }], catch: [{ kind: 'continue' }] }] }],
            [{ kind: 'loop', source: { kind: 'static', value: [] }, steps: [{ kind: 'while', expr: 'true', steps: [] }] }],
        ];
        for (const steps of actions) expect(roundTrip(steps)).toEqual(steps);
    });

    it('a fresh try catches from the start and a fresh while has a body to drop steps into', () => {
        expect(newStep('try')).toEqual({ kind: 'try', steps: [], catch: [] });
        expect(newStep('while')).toEqual({ kind: 'while', expr: '', steps: [] });
        expect(stepMeta('try').container).toBe(true);
        expect(stepMeta('return').group).toBe('Flow');
    });
});
