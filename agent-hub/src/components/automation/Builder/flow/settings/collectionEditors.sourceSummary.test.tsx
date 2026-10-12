import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';
import { SourceSummaryRow } from './collectionEditors';

/**
 * R10: "Working through" reads the source list the way the run does
 * (getList), so a list held as JSON text is counted, and it never shows a
 * raw path: a list without a sample is named and says why it has no fields.
 */
const ROWS = [{ name: 'Reiskosten 2026' }, { name: 'Budget Contoso' }, { name: 'Fabrikam' }];
const GROUP = {
    id: 'sheets', label: 'List sheets', kind: 'integration_action', basePath: 'steps.sheets.output',
    sample: { results: ROWS }, fields: [{ key: 'results', path: 'steps.sheets.output.results', sample: ROWS }],
};

// A Condition working through attachments files each output's items under
// `matchesByCase.<name>`; picked as a list, that reads as the output's name.
const BY_CASE = { pdf: ROWS, default: ROWS.slice(0, 1) };
const COND = {
    id: 'cond', label: 'Condition', kind: 'switch', basePath: 'steps.cond.output',
    sample: { matchesByCase: BY_CASE },
    fields: [{
        key: 'matchesByCase', path: 'steps.cond.output.matchesByCase', sample: BY_CASE,
        children: [
            { key: 'pdf', path: 'steps.cond.output.matchesByCase.pdf', sample: ROWS },
            { key: 'default', path: 'steps.cond.output.matchesByCase.default', sample: BY_CASE.default },
        ],
    }],
};

function renderRow(source: string, previewSample: unknown, group: typeof GROUP | typeof COND = GROUP) {
    render(
        <VariablePickerProvider groups={[group]} previewSample={previewSample} stepLabelById={new Map([['sheets', 'List sheets']])} stepTypeById={new Map()}>
            <SourceSummaryRow
                hint="" source={source} maxItems="" onPatch={vi.fn()}
                groups={[group]} onFocusField={null} previewSample={previewSample}
            />
        </VariablePickerProvider>,
    );
}

afterEach(cleanup);

describe('SourceSummaryRow (R10)', () => {
    it('names and counts a list it can read', () => {
        renderRow('steps.sheets.output.results', { steps: { sheets: { output: { results: ROWS } } } });
        expect(screen.getByText('List sheets')).toBeTruthy();
        expect(screen.getByText('Results')).toBeTruthy();
        expect(screen.getByText(/3 items/)).toBeTruthy();
    });

    it('counts a list held as JSON text, like the run', () => {
        renderRow('steps.sheets.output.body', { steps: { sheets: { output: { body: JSON.stringify(ROWS) } } } });
        expect(screen.getByText(/List sheets/)).toBeTruthy();
        expect(screen.getByText(/3 items/)).toBeTruthy();
        expect(screen.queryByText('steps.sheets.output.body')).toBeNull();
    });

    it('names an unreadable list and says there is no sample yet, never the raw path', () => {
        renderRow('steps.sheets.output.archive', null);
        expect(screen.getByText('List sheets ▸ Archive')).toBeTruthy();
        expect(screen.getByText(/no sample yet: run the step above to see its fields/)).toBeTruthy();
        expect(screen.queryByText(/steps\.sheets/)).toBeNull();
    });

    it('names a Condition output by its own name, never by its internal key', () => {
        const sample = { steps: { cond: { output: { matchesByCase: BY_CASE } } } };
        renderRow('steps.cond.output.matchesByCase.default', sample, COND);
        expect(screen.getByText('Otherwise')).toBeTruthy();
        expect(screen.queryByText(/Matches by case/i)).toBeNull();
        cleanup();
        renderRow('steps.cond.output.matchesByCase.pdf', sample, COND);
        expect(screen.getByText('pdf')).toBeTruthy();
    });

    it('asks for a list when none is picked', () => {
        renderRow('', null);
        expect(screen.getByText('No list picked yet')).toBeTruthy();
    });
});
