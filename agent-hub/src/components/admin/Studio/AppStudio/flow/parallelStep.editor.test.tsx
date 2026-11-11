import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { graphToSteps, scopesOf, stepsToGraph, stripStepIds, withStepIds } from './stepGraph';
import type { FlowStep } from './stepGraph';
import { newStep, stepMeta } from './stepKinds';
import { StepField } from './StepSettings/StepField';
import { fieldControlFor } from './StepSettings/fieldTypes';
import type { StepFieldProps } from './StepSettings.types';
import { mapStepBranches } from '../state/stepBranches';
import type { Step } from '../state/definitionOps.types';

/**
 * The `parallel` step in the editor: its branches are drawn on the flow canvas like the cases
 * of a switch (one scope per branch), read back without changing the action, and added or
 * removed with the `stepBranches` control in the step's settings.
 */

const toast = (message: string): FlowStep => ({ kind: 'toast', message, tone: 'info' });
const parallel = (branches: FlowStep[][], extra: Record<string, unknown> = {}): FlowStep => ({ kind: 'parallel', branches: branches.map((steps) => ({ steps })), ...extra });

const roundTrip = (steps: FlowStep[]) => {
    const tagged = withStepIds({ kind: 'sequence', steps });
    const { nodes, edges } = stepsToGraph(tagged);
    return stripStepIds(graphToSteps(nodes, edges));
};

describe('a parallel step on the flow canvas', () => {
    it('has one branch per entry of `branches`, numbered from 1', () => {
        const rows = scopesOf(parallel([[toast('a'), toast('b')], [], [toast('c')]])).map(({ key, label, steps }) => [key, label, steps?.length]);
        expect(rows).toEqual([['branches:0', 'Branch 1', 2], ['branches:1', 'Branch 2', 0], ['branches:2', 'Branch 3', 1]]);
    });

    it('translates the branch label', () => {
        const t = (key: string | undefined) => `t:${String(key)}`;
        expect(scopesOf(parallel([[], []]), t).map(({ label }) => label)).toEqual(['t:studio_apps_flow_parallel.scope.branch 1', 't:studio_apps_flow_parallel.scope.branch 2']);
    });

    it('the graph holds a node per step of a branch, in the scope of its branch', () => {
        const { nodes } = stepsToGraph(withStepIds({ kind: 'sequence', steps: [parallel([[toast('a')], [toast('b'), toast('c')]])] }));
        expect(nodes.filter((n) => !n.isEntry).map((n) => `${n.scopeKey ?? '-'}:${n.kind}`)).toEqual(['-:parallel', 'branches:0:toast', 'branches:1:toast', 'branches:1:toast']);
        expect(nodes.filter((n) => n.isEntry).map((n) => n.scopeLabel)).toEqual(['Branch 1', 'Branch 2']);
    });

    it('opening an action on the canvas does not change it', () => {
        const actions: FlowStep[][] = [
            [parallel([[toast('a')], [toast('b')]])],
            [parallel([[], [toast('b')]], { failFast: true })],
            [parallel([[{ kind: 'try', steps: [parallel([[toast('x')]])], catch: [] }], [{ kind: 'loop', source: { kind: 'static', value: [] }, steps: [toast('y')] }]])],
            [{ kind: 'condition', expr: 'true', then: [parallel([[toast('a')]])], else: [] }],
        ];
        for (const steps of actions) expect(roundTrip(steps)).toEqual(steps);
    });

    it('a fresh one has two empty branches and sits with the flow steps', () => {
        expect(newStep('parallel')).toEqual({ kind: 'parallel', branches: [{ steps: [] }, { steps: [] }] });
        expect(stepMeta('parallel')).toMatchObject({ container: true, group: 'Flow', label: 'Run side by side' });
    });
});

describe('the editor\'s step clean-ups reach into the branches', () => {
    const drop = (kind: string) => (list: Step[] | undefined) => {
        if (!Array.isArray(list)) return list;
        const kept = list.filter((s) => s.kind !== kind);
        return kept.length === list.length ? list : kept;
    };

    it('maps the steps of every branch; an untouched step comes back by reference', () => {
        const step = parallel([[toast('a'), { kind: 'navigate', screenId: 's' }], [toast('b')]], { failFast: true }) as unknown as Step;
        const out = mapStepBranches(step, drop('navigate')) as unknown as { branches: Array<{ steps: unknown[] }>; failFast: boolean };
        expect(out.branches).toEqual([{ steps: [toast('a')] }, { steps: [toast('b')] }]);
        expect(out.branches[1]).toBe((step as unknown as { branches: unknown[] }).branches[1]);
        expect(out.failFast).toBe(true);
        expect(mapStepBranches(step, drop('refresh'))).toBe(step);
    });
});

describe('the branches control in the step settings', () => {
    const props = (value: unknown, onChange: (next: unknown) => void): StepFieldProps => ({
        fieldKey: 'branches', fs: { type: 'stepBranches', required: true }, value, step: { kind: 'parallel' } as StepFieldProps['step'], onChange,
        definition: {} as StepFieldProps['definition'], node: null, options: {}, references: {} as StepFieldProps['references'], formFields: [], disabled: false,
    });

    it('is the registered control of the stepBranches field type', () => {
        expect(typeof fieldControlFor('stepBranches')).toBe('function');
    });

    it('lists the branches with their step counts, adds an empty one and removes one with its steps', async () => {
        const onChange = vi.fn();
        const value = [{ steps: [toast('a'), toast('b')] }, { steps: [] }];
        render(<StepField {...props(value, onChange)} />);
        expect(screen.getByText('Branch 1 (2 steps)')).toBeTruthy();
        expect(screen.getByText('Branch 2 (0 steps)')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Add a branch' }));
        expect(onChange).toHaveBeenLastCalledWith([...value, { steps: [] }]);
        await userEvent.click(screen.getByRole('button', { name: 'Remove branch 1' }));
        expect(onChange).toHaveBeenLastCalledWith([{ steps: [] }]);
    });

    it('keeps at least one branch and stops adding at the limit', () => {
        const { unmount } = render(<StepField {...props([{ steps: [] }], () => {})} />);
        expect((screen.getByRole('button', { name: 'Remove branch 1' }) as HTMLButtonElement).disabled).toBe(true);
        unmount();
        render(<StepField {...props(Array.from({ length: 8 }, () => ({ steps: [] })), () => {})} />);
        expect((screen.getByRole('button', { name: 'Add a branch' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText('A step holds at most 8 branches.')).toBeTruthy();
    });
});
