import { describe, it, expect } from 'vitest';
import { duplicateInGraph, withNewStep } from './ActionFlowEditor.helpers';
import { graphToSteps, stepsToGraph, stripStepIds, withStepIds, type FlowStep } from '../stepGraph';

const graphOf = (steps: FlowStep[]) => stepsToGraph(withStepIds({ kind: 'sequence', steps }));
const kinds = (steps: FlowStep[]) => steps.map((s) => s.kind);
const rootIds = (g: ReturnType<typeof graphOf>) => g.nodes.filter((n) => n.prefix === '' && !n.isEntry).map((n) => n.id);

describe('withNewStep', () => {
    it('appends after the last step of the scope when no position is given', () => {
        const g = graphOf([{ kind: 'navigate' }, { kind: 'toast' }]);
        const added = withNewStep(g, 'refresh', { kind: 'refresh', id: 'n9' }, '', null);
        expect(added.at).toBe(2);
        expect(kinds(graphToSteps(added.nodes, added.edges))).toEqual(['navigate', 'toast', 'refresh']);
    });

    it('inserts at the given position, in node order', () => {
        const g = graphOf([{ kind: 'navigate' }, { kind: 'toast' }]);
        const added = withNewStep(g, 'refresh', { kind: 'refresh', id: 'n9' }, '', 1);
        expect(added.at).toBe(1);
        expect(kinds(graphToSteps(added.nodes, added.edges))).toEqual(['navigate', 'refresh', 'toast']);
    });

    it('starts an empty scope from its entry', () => {
        const g = graphOf([]);
        const added = withNewStep(g, 'toast', { kind: 'toast', id: 'n1' }, '', null);
        expect(added.at).toBe(0);
        expect(kinds(graphToSteps(added.nodes, added.edges))).toEqual(['toast']);
    });
});

describe('duplicateInGraph', () => {
    it('puts a copy right after the original, without the editor id', () => {
        const g = graphOf([{ kind: 'navigate', screenId: 's1' }, { kind: 'toast', message: 'hi' }]);
        const [first] = rootIds(g);
        const copy = duplicateInGraph(g, first, 'n99');
        const steps = stripStepIds(graphToSteps(copy.nodes, copy.edges));
        expect(steps).toEqual([
            { kind: 'navigate', screenId: 's1' },
            { kind: 'navigate', screenId: 's1' },
            { kind: 'toast', message: 'hi' },
        ]);
    });

    it('copies a container with its branches populated', () => {
        const g = graphOf([{ kind: 'condition', expr: 'x', then: [{ kind: 'toast', message: 'yes' }], else: [{ kind: 'toast', message: 'no' }] }]);
        const [cond] = rootIds(g);
        const copy = duplicateInGraph(g, cond, 'n99');
        const steps = stripStepIds(graphToSteps(copy.nodes, copy.edges));
        expect(steps).toHaveLength(2);
        expect(steps[1]).toEqual(steps[0]);
        expect(steps[1].then).toEqual([{ kind: 'toast', message: 'yes' }]);
        expect(steps[1].else).toEqual([{ kind: 'toast', message: 'no' }]);
    });
});
