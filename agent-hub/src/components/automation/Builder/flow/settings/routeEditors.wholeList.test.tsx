import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIL_GROUP, MAIL_ROOT, renderRoute } from './routeEditors.harness';

/**
 * BFSF-485 F3/F4: "list Google Sheets, add a Condition `name contains
 * Reiskosten`, every sheet is processed". A whole-run Condition that reads a
 * list checks the list once; the editor says so (and names the loop after it
 * that still sees every item) and converts it to a Condition that works
 * through the list, every rule rebased onto `item`, in one edit.
 */
const SHEETS = [{ name: 'Reiskosten 2026' }, { name: 'Budget Contoso' }];
const SHEETS_GROUP = {
    id: 'sheets', label: 'List sheets', kind: 'integration_action', basePath: 'steps.sheets.output',
    sample: { results: SHEETS },
    fields: [{ key: 'results', path: 'steps.sheets.output.results', sample: SHEETS }],
};
const ROOT = { steps: { sheets: { output: { results: SHEETS } } } };
const COND = { id: 'c1', type: 'condition', expr: 'contains(steps.sheets.output.results[*].name, "Reiskosten")' };
const WHOLE_RUN = {
    lists: [{ path: 'steps.sheets.output.results', label: 'List sheets ▸ Results' }],
    loops: [{ stepId: 's3', stepLabel: 'Read sheet' }],
};
const opts = { groups: [SHEETS_GROUP], previewSample: ROOT };

afterEach(cleanup);

describe('WholeListNotice', () => {
    it('says the Condition checks the whole list once, and names the loop after it', () => {
        renderRoute(COND, { ...opts, wholeRun: WHOLE_RUN });
        expect(screen.getByText(/This checks the whole list List sheets ▸ Results once: the run goes one way for all its items\. It does not filter them\./)).toBeTruthy();
        expect(screen.getByText(/“Read sheet” still runs once for every item of that list\./)).toBeTruthy();
    });

    it('names several loops in one sentence', () => {
        renderRoute(COND, { ...opts, wholeRun: { ...WHOLE_RUN, loops: [...WHOLE_RUN.loops, { stepId: 's4', stepLabel: 'Save copy' }] } });
        expect(screen.getByText(/“Read sheet”, “Save copy” still run once for every item of that list\./)).toBeTruthy();
    });

    it('"Check each item instead" makes it work through the list, rules rebased onto the item, in one edit', async () => {
        const { saves, saved } = renderRoute(COND, { ...opts, wholeRun: WHOLE_RUN });
        await userEvent.click(screen.getByRole('button', { name: 'Check each item instead' }));
        expect(saves).toHaveLength(1);
        expect(saved()).toMatchObject({
            type: 'filter',
            arrayRef: 'steps.sheets.output.results',
            expr: 'contains(item.name, "Reiskosten")',
        });
        // Now in list mode the notice is gone and the rule is a row on the item.
        expect(screen.queryByText(/checks the whole list/)).toBeNull();
        expect(screen.getByText('Working through')).toBeTruthy();
    });

    it('hands focus to a place that stays once the notice goes, and says what it did', async () => {
        renderRoute(COND, { ...opts, wholeRun: WHOLE_RUN });
        await userEvent.click(screen.getByRole('button', { name: 'Check each item instead' }));
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement?.textContent).toBe('Done: this Condition now checks each item.');
    });

    it('draws the fix in a colour that reads on the amber notice, not --accent (defect 6)', () => {
        renderRoute(COND, { ...opts, wholeRun: WHOLE_RUN });
        expect(screen.getByRole('button', { name: 'Check each item instead' }).className).not.toContain('--accent');
    });

    it('offers no fix for a list no rule reads the items of, and a click there would change nothing', () => {
        const whole = { id: 'c1', type: 'condition', expr: 'contains(steps.sheets.output.results, "Reiskosten")' };
        renderRoute(whole, { ...opts, wholeRun: { lists: [{ ...WHOLE_RUN.lists[0], convertible: false }], loops: [] } });
        expect(screen.getByText(/checks the whole list/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Check each item instead' })).toBeNull();
    });

    it('a whole-run switch keeps its outputs while it starts working through the list', async () => {
        const { saved } = renderRoute({
            id: 'sw', type: 'switch', routeStyle: 'rules',
            cases: [
                { name: 'travel', expr: 'contains(steps.sheets.output.results[*].name, "Reiskosten")' },
                { name: 'budget', expr: 'contains(steps.sheets.output.results[*].name, "Budget")' },
            ],
        }, { ...opts, wholeRun: { lists: WHOLE_RUN.lists, loops: [] } });
        await userEvent.click(screen.getByRole('button', { name: 'Check each item instead' }));
        expect(saved()).toMatchObject({
            type: 'switch',
            arrayRef: 'steps.sheets.output.results',
            cases: [
                { name: 'travel', expr: 'contains(item.name, "Reiskosten")' },
                { name: 'budget', expr: 'contains(item.name, "Budget")' },
            ],
        });
    });

    it('is not shown without a whole-list read, nor while working through a list', () => {
        renderRoute(COND, { ...opts, wholeRun: null });
        expect(screen.queryByText(/checks the whole list/)).toBeNull();
        cleanup();
        renderRoute(
            { id: 'f1', type: 'filter', arrayRef: 'steps.m.output.messages', expr: '' },
            { groups: [MAIL_GROUP], previewSample: MAIL_ROOT, wholeRun: WHOLE_RUN },
        );
        expect(screen.queryByText(/checks the whole list/)).toBeNull();
    });
});
