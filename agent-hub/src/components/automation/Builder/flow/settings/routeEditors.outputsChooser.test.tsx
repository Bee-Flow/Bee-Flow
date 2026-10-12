import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderRoute } from './routeEditors.harness';

/**
 * The outputs chooser of the Condition editor: the shared SegmentedControl
 * (O1), one "Otherwise" story (O2), outputs named "Output 1", "Output 2"
 * (O3) and, for one output in list mode, "Send what doesn't match to
 * “Otherwise”" (BFSF-485 F2).
 */
const FILTER = { id: 'f1', type: 'filter', arrayRef: 'steps.m.output.messages', expr: 'contains(item.from, "fabrikam")' };
const IF_STEP = { id: 'c1', type: 'condition', expr: 'steps.m.output.count > 1' };
const KEEP_REST = {
    id: 'k1', type: 'switch', arrayRef: 'steps.m.output.messages', routeStyle: 'rules',
    cases: [{ name: 'Output 1', expr: 'contains(item.from, "fabrikam")' }],
};

const radio = (name: string) => screen.getByRole('radio', { name });
const keepRestBox = () => screen.queryByRole('checkbox', { name: /Send what doesn't match to “Otherwise”/ });

afterEach(cleanup);

describe('O1 — the chooser is a radio group', () => {
    it('marks the selected option checked, not merely tinted', async () => {
        renderRoute(FILTER);
        expect(screen.getByRole('radiogroup', { name: 'Number of outputs' })).toBeTruthy();
        expect(radio('One output').getAttribute('aria-checked')).toBe('true');
        expect(radio('Several outputs').getAttribute('aria-checked')).toBe('false');
        await userEvent.click(radio('Several outputs'));
        expect(radio('Several outputs').getAttribute('aria-checked')).toBe('true');
        expect(radio('One output').getAttribute('aria-checked')).toBe('false');
    });
});

describe('O2 — one story about what matches nothing', () => {
    it('one output: the rest stops here', () => {
        renderRoute(FILTER);
        expect(screen.getByText('What matches continues; the rest stops here.')).toBeTruthy();
    });

    it('a whole-run Condition decides for the run: then or Otherwise, never "the rest stops here"', () => {
        renderRoute(IF_STEP);
        expect(screen.queryByText(/the rest stops here/)).toBeNull();
        expect(screen.getByText('When the rule holds, the run continues; when it doesn’t, the run goes to “Otherwise”; leave “Otherwise” unconnected to stop it there.')).toBeTruthy();
        expect(screen.getByText('This node has 1 output plus “Otherwise”.')).toBeTruthy();
    });

    it('explains Output 1, Output 2 only once there are several outputs', async () => {
        renderRoute(FILTER);
        expect(screen.queryByText(/Each output is a filter with its own destination/)).toBeNull();
        await userEvent.click(radio('Several outputs'));
        expect(screen.getByText(/Each output is a filter with its own destination/)).toBeTruthy();
    });

    it('several outputs built here fan out, and say where the rest goes', async () => {
        renderRoute(FILTER);
        await userEvent.click(radio('Several outputs'));
        expect(screen.getByText('Each output is checked on its own, so one item can go down several outputs. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it.')).toBeTruthy();
        expect(screen.queryByText(/counted as rejected/)).toBeNull();
        expect(screen.getByRole('option', { name: 'Use the Otherwise output' })).toBeTruthy();
    });

    it('a stored first-match router says the first match wins', () => {
        renderRoute({
            id: 's1', type: 'switch', arrayRef: 'steps.m.output.messages', routeStyle: 'rules',
            cases: [{ name: 'a', expr: 'contains(item.from, "fabrikam")' }, { name: 'b', expr: 'contains(item.from, "contoso")' }],
        });
        expect(screen.getByText('Each item takes the first output it matches. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it.')).toBeTruthy();
    });
});

describe('O3 — outputs are named Output 1, Output 2, …', () => {
    it('growing from one output names the internal first rule "Output 1"', async () => {
        const { saved } = renderRoute(FILTER);
        await userEvent.click(radio('Several outputs'));
        expect(saved()).toMatchObject({
            type: 'switch',
            cases: [{ name: 'Output 1', expr: FILTER.expr }, { name: 'Output 2', expr: '' }],
        });
        await userEvent.click(screen.getByRole('button', { name: /Add output/ }));
        expect((saved().cases as Array<{ name: string }>).map((c) => c.name)).toEqual(['Output 1', 'Output 2', 'Output 3']);
    });

    it('a name the author chose is kept', async () => {
        const { saved } = renderRoute({
            id: 's1', type: 'switch', arrayRef: 'steps.m.output.messages', routeStyle: 'rules',
            cases: [{ name: 'invoices', expr: 'contains(item.subject, "invoice")' }],
        });
        await userEvent.click(radio('Several outputs'));
        expect((saved().cases as Array<{ name: string }>).map((c) => c.name)).toEqual(['invoices', 'Output 2']);
    });

    it('an If growing to two outputs gets the same names', async () => {
        const { saved } = renderRoute(IF_STEP);
        await userEvent.click(radio('Several outputs'));
        expect((saved().cases as Array<{ name: string }>).map((c) => c.name)).toEqual(['Output 1', 'Output 2']);
    });
});

describe('BFSF-485 F2 — keep what does not match', () => {
    it('ticking the box writes a list switch with one case; Otherwise becomes its second port', async () => {
        const { saved } = renderRoute(FILTER);
        const box = keepRestBox();
        expect(box).toBeTruthy();
        expect((box as HTMLInputElement).checked).toBe(false);
        await userEvent.click(box!);
        expect(saved()).toMatchObject({
            type: 'switch', arrayRef: FILTER.arrayRef, routeStyle: 'rules',
            cases: [{ name: 'Output 1', expr: FILTER.expr }],
        });
        expect(screen.getAllByText('What matches continues; what doesn\'t goes to “Otherwise”; leave “Otherwise” unconnected to drop it.').length).toBeGreaterThan(0);
        expect(screen.getByText('This node has 1 output plus “Otherwise”.')).toBeTruthy();
    });

    it('a stored list switch with one case reopens ticked; unticking makes it a filter again', async () => {
        const { saved } = renderRoute(KEEP_REST);
        expect(radio('One output').getAttribute('aria-checked')).toBe('true');
        expect((keepRestBox() as HTMLInputElement).checked).toBe(true);
        await userEvent.click(keepRestBox()!);
        expect(saved()).toMatchObject({ type: 'filter', arrayRef: KEEP_REST.arrayRef, expr: KEEP_REST.cases[0].expr });
        expect(screen.getByText('What matches continues; the rest stops here.')).toBeTruthy();
    });

    it('counts the live “Otherwise” and does not say the rest stops here (F2 editor half)', async () => {
        renderRoute(KEEP_REST);
        expect(screen.getByText('This node has 1 output plus “Otherwise”.')).toBeTruthy();
        expect(screen.queryByText(/the rest stops here/)).toBeNull();
        await userEvent.click(keepRestBox()!);
        expect(screen.getByText('This node has 1 output.')).toBeTruthy();
    });

    it('is not offered for a whole-run Condition or with several outputs', async () => {
        renderRoute(IF_STEP);
        expect(keepRestBox()).toBeNull();
        cleanup();
        renderRoute(FILTER);
        await userEvent.click(radio('Several outputs'));
        expect(keepRestBox()).toBeNull();
    });
});
