import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState } from '@/features/flow-editor/formState';
import type { FlowDefinition, Route } from '@/features/flow-editor/model';
import { findNode } from '@/features/flow-editor/model/outline';

import { formWriteOp, patchWriteOp, stepChanged, writeStepPatch } from './stepForm';
import { workThroughList } from '../editors/route/routeSourceEdits';

const FORM = { extract: extractFormState, patch: buildPatch };

const def = (): FlowDefinition =>
    ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        triggers: [{ id: 'hook', type: 'trigger', kind: 'webhook' }],
        steps: [
            { id: 'g', type: 'guard', label: 'Shield', icon: null, sourceRef: 'trigger.output.body' },
            { id: 'a', type: 'wait', label: 'Pause', icon: null, seconds: 5 },
            { id: 'b', type: 'set', label: 'Clean' },
            { id: 'c', type: 'set', label: 'Alert' },
        ],
        edges: [
            { from: 'trg', to: 'g' },
            { from: 'g', to: 'b', label: 'then' },
            { from: 'g', to: 'c', label: 'else' },
            { from: 'b', to: 'a' },
        ],
    }) as unknown as FlowDefinition;

describe('findNode', () => {
    it('finds the trigger, a secondary trigger and a step', () => {
        const d = def();
        expect(findNode(d, 'trg')?.type).toBe('trigger');
        expect(findNode(d, 'hook')?.kind).toBe('webhook');
        expect(findNode(d, 'a')?.type).toBe('wait');
        expect(findNode(d, 'nope')).toBeNull();
        expect(findNode(null, 'a')).toBeNull();
    });
});

describe('formWriteOp', () => {
    it('writes only what the form changed', () => {
        const d = def();
        const draft = { ...extractFormState(findNode(d, 'a') as FlowNode), seconds: 60 };
        const next = formWriteOp('a', draft, FORM)(d);
        expect(findNode(next, 'a')).toMatchObject({ seconds: 60, label: 'Pause' });
        expect(next.edges).toBe(d.edges);
    });

    it('is a no-op when the form matches the step', () => {
        const d = def();
        expect(formWriteOp('a', extractFormState(findNode(d, 'a') as FlowNode), FORM)(d)).toBe(d);
        expect(formWriteOp('gone', {}, FORM)(d)).toBe(d);
    });

    it('edits a trigger in place', () => {
        const d = def();
        const next = patchWriteOp('trg', { label: 'Start' })(d);
        expect(next.trigger?.label).toBe('Start');
        expect(next.steps).toEqual(d.steps);
    });
});

describe('writeStepPatch', () => {
    it('takes out the connection a Privacy Shield mode switch leaves without a port', () => {
        const next = writeStepPatch(def(), 'g', { type: 'tokenize', onFound: undefined });
        expect(findNode(next, 'g')?.type).toBe('tokenize');
        expect(next.edges.filter((e) => e.from === 'g')).toEqual([{ from: 'g', to: 'b', label: 'then' }]);
    });

    it('keeps both connections when the shield keeps branching', () => {
        const next = writeStepPatch(def(), 'g', { onFound: { tokenize: true } });
        expect(next.edges.filter((e) => e.from === 'g')).toHaveLength(2);
    });
});

describe('Check each item instead (BFSF-485 F4)', () => {
    const RESULTS = 'steps.s.output.results';
    const wholeRun = (): FlowDefinition =>
        ({
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 's', type: 'integration_action', label: 'Search' },
                { id: 'c', type: 'condition', label: 'Condition', expr: `contains(${RESULTS}[*].title, "invoice")` },
                { id: 't', type: 'integration_action', label: 'Read', forEach: { overRef: RESULTS, itemVar: 'r' } },
            ],
            edges: [
                { from: 'trg', to: 's' },
                { from: 's', to: 'c' },
                { from: 'c', to: 't', label: 'then' },
            ],
        }) as unknown as FlowDefinition;

    it('converts in one write and re-points the loop after it to what passes', () => {
        const d = wholeRun();
        const base = extractFormState(findNode(d, 'c') as FlowNode);
        const route = base.route as Route;
        const draft = { ...base, route: { ...route, ...workThroughList(route.rules, RESULTS) } };
        const next = formWriteOp('c', draft, FORM)(d);
        expect(findNode(next, 'c')).toMatchObject({ type: 'filter', arrayRef: RESULTS });
        expect(findNode(next, 't')?.forEach).toEqual({ overRef: 'steps.c.output.items', itemVar: 'r' });
    });
});

describe('stepChanged', () => {
    it('compares the step as the form reads it', () => {
        const step = findNode(def(), 'a') as FlowNode;
        const baseline = extractFormState(step);
        expect(stepChanged(FORM, step, baseline)).toBe(false);
        expect(stepChanged(FORM, { ...step, seconds: 9 }, baseline)).toBe(true);
    });
});
