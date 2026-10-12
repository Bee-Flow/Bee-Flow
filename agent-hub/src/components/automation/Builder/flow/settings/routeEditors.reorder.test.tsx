import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderRoute } from './routeEditors.harness';
import { mergeStepPatchIntoDefinition } from '../switchCaseOps';

/** BFSF-406: outputs of a multi-output Condition can be moved up and down. */
const SWITCH = {
    id: 's1', type: 'switch', routeStyle: 'rules',
    cases: [
        { name: 'Invoices', expr: 'steps.m.output.kind == "invoice"' },
        { name: 'Minutes', expr: 'steps.m.output.kind == "minutes"' },
        { name: 'Other', expr: 'steps.m.output.kind == "other"' },
    ],
};

afterEach(cleanup);

describe('reordering outputs', () => {
    it('moves an output down and writes the new order', async () => {
        const { saved } = renderRoute(SWITCH);
        await userEvent.click(screen.getAllByRole('button', { name: 'Move output down' })[0]);
        const names = (saved().cases as { name: string }[]).map((c) => c.name);
        expect(names).toEqual(['Minutes', 'Invoices', 'Other']);
    });

    it('moves an output up, and the ends cannot move past the list', async () => {
        const { saved } = renderRoute(SWITCH);
        const ups = screen.getAllByRole('button', { name: 'Move output up' });
        expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
        const downs = screen.getAllByRole('button', { name: 'Move output down' });
        expect((downs[2] as HTMLButtonElement).disabled).toBe(true);
        await userEvent.click(ups[2]);
        expect((saved().cases as { name: string }[]).map((c) => c.name)).toEqual(['Invoices', 'Other', 'Minutes']);
    });
});

describe('edges after a reorder', () => {
    it('every connection stays on its own output', () => {
        const definition = {
            steps: [SWITCH],
            edges: [
                { from: 's1', to: 'a', label: 'case:Invoices', caseName: 'Invoices' },
                { from: 's1', to: 'b', label: 'case:Minutes', caseName: 'Minutes' },
            ],
        };
        const next = mergeStepPatchIntoDefinition(definition, SWITCH, {
            cases: [SWITCH.cases[1], SWITCH.cases[0], SWITCH.cases[2]],
        });
        expect(next.edges).toEqual(definition.edges);
        expect(next.steps[0].cases.map((c: { name: string }) => c.name)).toEqual(['Minutes', 'Invoices', 'Other']);
    });
});
