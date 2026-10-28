import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import scopedStorage from '@/utils/scopedStorage';
import type { DescribedColumn } from '@/api/queries/automation/tablePreview';
import { VariablePickerProvider } from '@/components/automation/Builder/mapping/VariablePickerContext';
import { opHelp, type Translate } from '../opHelp';
import { COLUMNS, GROUPS, SAMPLE, col, op } from '../testKit';
import type { TableOp } from '../tableOpModel';
import BucketForm from './BucketForm';
import DeriveForm from './DeriveForm';
import DescribeForm from './DescribeForm';
import FilterForm from './FilterForm';
import GroupForm from './GroupForm';
import GroupsForm from './GroupsForm';
import JoinForm from './JoinForm';
import type { OpContext } from './opFormTypes';
import PivotForm from './PivotForm';
import PseudonymiseForm from './PseudonymiseForm';
import SampleForm from './SampleForm';
import SelectForm from './SelectForm';

const help = opHelp((_key, fallback, vars) => fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? '')) as string);

const described = (list: Partial<DescribedColumn>[]) => new Map(list.map(d => [d.key as string, {
    label: d.key, kind: 'single', storageType: 'text', filled: 1, empty: 0, distinct: 2, usableAsSplit: true, looksPersonal: false, sampleValues: [], ...d,
} as DescribedColumn]));

const context = (extra: Partial<OpContext> = {}): OpContext => ({
    columns: COLUMNS, described: new Map(), issues: [], help, otherColumns: [col('Id'), col('Team'), col('Lead')], sampleRow: { Region: 'North', Amount: 10, Email: 'a@example.test' }, ...extra,
});

/** A form with the operation it edits, and every state it passed through. */
function mount(Form: (props: { op: never; onChange: (o: never) => void; ctx: OpContext }) => React.ReactElement, start: TableOp, ctx = context(), groups: unknown[] = GROUPS, sample: unknown = SAMPLE) {
    const seen: TableOp[] = [];
    function Host() {
        const [current, setCurrent] = useState(start);
        return (
            <VariablePickerProvider groups={groups as never} previewSample={sample} stepLabelById={new Map([['s1', 'Read table']])}>
                <Form op={current as never} ctx={ctx} onChange={next => { seen.push(next as TableOp); setCurrent(next as TableOp); }} />
            </VariablePickerProvider>
        );
    }
    render(<Host />);
    return { last: () => seen[seen.length - 1] as unknown as Record<string, unknown>, seen };
}

beforeEach(() => {
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* storage blocked */ }
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('join', () => {
    it('picks the second table and the columns that match, from the columns of each table', async () => {
        const user = userEvent.setup();
        const { last } = mount(JoinForm as never, op('join', 'j'));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Second table' }), 'steps.s1.output.table');
        expect(last().with).toEqual({ kind: 'ref', path: 'steps.s1.output.table' });
        await user.selectOptions(screen.getByRole('combobox', { name: 'Column in this table' }), 'Email');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Column in the second table' }), 'Lead');
        expect(last().on).toEqual([{ left: 'Email', right: 'Lead' }]);
        expect(within(screen.getByRole('combobox', { name: 'Column in the second table' })).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['', 'Id', 'Team', 'Lead'].filter(Boolean));
    });

    it('takes other names for the column and a second pair', async () => {
        const user = userEvent.setup();
        const { last } = mount(JoinForm as never, op('join', 'j', { on: [{ left: 'Email', right: 'Lead' }] }));
        await user.type(screen.getByRole('textbox', { name: 'Or one of these names' }), 'mail, e-mail');
        expect((last().on as { alternatives?: string[] }[])[0].alternatives).toEqual(['mail', 'e-mail']);
        await user.click(screen.getByRole('button', { name: 'Add another pair' }));
        expect(last().on).toHaveLength(2);
        expect(screen.getAllByRole('button', { name: 'Remove this pair of columns' })).toHaveLength(2);
    });

    it('chooses between all the columns of the second table and some of them', async () => {
        const user = userEvent.setup();
        const { last } = mount(JoinForm as never, op('join', 'j'));
        await user.click(screen.getByRole('radio', { name: 'Choose columns' }));
        expect(last().columns).toEqual([]);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Add a column to: Columns to bring along' }), 'Team');
        expect(last().columns).toEqual(['Team']);
    });
});

describe('group', () => {
    it('groups by split-friendly columns and totals a numeric one', async () => {
        const user = userEvent.setup();
        const ctx = context({ described: described([{ key: 'Region', kind: 'single', usableAsSplit: true }, { key: 'Amount', kind: 'numeric', usableAsSplit: false }, { key: 'Email', kind: 'identifier', usableAsSplit: false, looksPersonal: true }]) });
        const { last } = mount(GroupForm as never, op('group', 'g'), ctx);
        const by = screen.getByRole('combobox', { name: 'Add a column to: Group by' });
        expect(within(within(by).getByRole('group', { name: 'Suggested' })).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['Region']);
        await user.selectOptions(by, 'Region');
        expect(last().by).toEqual(['Region']);
        await user.selectOptions(screen.getByRole('combobox', { name: 'What to work out' }), 'sum');
        const column = screen.getByRole('combobox', { name: 'Of the column' });
        expect(within(within(column).getByRole('group', { name: 'Suggested' })).getAllByRole('option').map(o => o.getAttribute('value'))).toEqual(['Amount']);
        await user.selectOptions(column, 'Amount');
        await user.clear(screen.getByRole('textbox', { name: 'Name of the result column' }));
        await user.type(screen.getByRole('textbox', { name: 'Name of the result column' }), 'Total');
        expect(last().aggregates).toEqual([{ fn: 'sum', column: 'Amount', as: 'Total' }]);
    });

    it('needs no column to count rows, and hides small groups on request', async () => {
        const user = userEvent.setup();
        const { last } = mount(GroupForm as never, op('group', 'g'));
        expect(screen.queryByRole('combobox', { name: 'Of the column' })).toBeNull();
        await user.clear(screen.getByRole('spinbutton', { name: 'Smallest group to show' }));
        await user.type(screen.getByRole('spinbutton', { name: 'Smallest group to show' }), '5');
        expect(last().minN).toBe(5);
    });
});

describe('pivot', () => {
    it('sets rows, columns and what goes in each cell', async () => {
        const user = userEvent.setup();
        const { last } = mount(PivotForm as never, op('pivot', 'p'));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Down the side' }), 'Region');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Across the top' }), 'Email');
        await user.selectOptions(screen.getByRole('combobox', { name: 'In each cell' }), 'sum');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Column to add up' }), 'Amount');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Show as' }), 'row');
        await user.click(screen.getByRole('checkbox', { name: 'Add totals' }));
        expect(last()).toMatchObject({ rows: 'Region', columns: 'Email', value: { fn: 'sum', column: 'Amount' }, percent: 'row', totals: false });
    });
});

describe('filter', () => {
    it('builds rules from a column, a test and a value, and drops the value when the test needs none', async () => {
        const user = userEvent.setup();
        const { last } = mount(FilterForm as never, op('filter', 'f'));
        await user.click(screen.getByRole('button', { name: 'Add a rule' }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Column' }), 'Region');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Test' }), 'in');
        await user.type(screen.getByRole('textbox', { name: 'Values' }), 'North{Enter}South');
        expect(last().rules).toEqual([{ column: 'Region', test: 'in', value: ['North', 'South'] }]);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Test' }), 'is_empty');
        expect(last().rules).toEqual([{ column: 'Region', test: 'is_empty' }]);
        expect(screen.queryByRole('textbox', { name: 'Values' })).toBeNull();
    });

    it('asks for a lowest and a highest value for "between"', async () => {
        const user = userEvent.setup();
        const { last } = mount(FilterForm as never, op('filter', 'f', { rules: [{ column: 'Amount', test: 'between' }] }));
        await user.type(screen.getByRole('textbox', { name: 'Lowest value' }), '5');
        await user.type(screen.getByRole('textbox', { name: 'Highest value' }), '9');
        expect(last().rules).toEqual([{ column: 'Amount', test: 'between', value: ['5', '9'] }]);
    });

    it('takes rules from the run, and says they are not applied in the preview', async () => {
        const user = userEvent.setup();
        const { last } = mount(FilterForm as never, op('filter', 'f', { rules: [{ column: 'Region', test: 'equals', value: { kind: 'literal', value: 'North' } }] }));
        expect(screen.queryByText('Where the rules come from')).toBeNull();
        await user.click(screen.getByRole('checkbox', { name: 'Also use rules from the run' }));
        expect(last().rulesFrom).toEqual({ kind: 'ref', path: '' });
        expect(screen.getByText(/applied when the automation runs, not in this preview/)).toBeTruthy();
        expect(screen.getByRole('radio', { name: 'Any one of them is enough' })).toBeTruthy();
        await user.click(screen.getByRole('radio', { name: 'Any one of them is enough' }));
        expect(last().rulesFromMatch).toBe('any');
        await user.click(screen.getByRole('checkbox', { name: 'Also use rules from the run' }));
        expect(last().rulesFrom).toBeNull();
    });

    it('lets a rule match all or any when there are several', () => {
        mount(FilterForm as never, op('filter', 'f', { rules: [{ column: 'Region', test: 'equals' }, { column: 'Amount', test: 'gt' }] }));
        expect(screen.getByRole('radio', { name: 'Any one of the rules is true' })).toBeTruthy();
    });
});

describe('segments', () => {
    it('starts at a smallest group of 30 and warns about a lower one', async () => {
        const user = userEvent.setup();
        const { last } = mount(GroupsForm as never, op('groups', 'g'));
        const min = screen.getByRole('spinbutton', { name: 'Smallest group to show' }) as HTMLInputElement;
        expect(min.value).toBe('30');
        expect(screen.getByText(/Your organisation can set a higher minimum/)).toBeTruthy();
        expect(screen.queryByText(/easier to trace back to a person/)).toBeNull();
        await user.clear(min);
        await user.type(min, '10');
        expect(last().minN).toBe(10);
        expect(screen.getByText('Groups of fewer than 30 people are easier to trace back to a person.')).toBeTruthy();
    });

    it('splits by columns that have a few options, each with its own values', async () => {
        const user = userEvent.setup();
        const { last } = mount(GroupsForm as never, op('groups', 'g'));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Column' }), 'Region');
        await user.type(screen.getByRole('textbox', { name: 'Only these values' }), 'North, South');
        expect(last().splits).toEqual([{ column: 'Region', values: ['North', 'South'], separator: null, label: null }]);
    });
});

describe('pseudonymise', () => {
    it('suggests the columns that look personal and takes the name of the secret variable', async () => {
        const user = userEvent.setup();
        const ctx = context({ described: described([{ key: 'Email', kind: 'identifier', looksPersonal: true, usableAsSplit: false }]) });
        const { last } = mount(PseudonymiseForm as never, op('pseudonymise', 'p'), ctx);
        expect(screen.getByText(/These columns look like personal data: Email/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Use them' }));
        expect(last().columns).toEqual(['Email']);
        await user.type(screen.getByRole('textbox', { name: 'Variable with the secret phrase' }), 'pseudonym_secret');
        expect(last().saltVar).toBe('pseudonym_secret');
        expect(screen.getByText(/at least 16 characters/)).toBeTruthy();
    });
});

describe('add calculated columns', () => {
    it('builds the value of a new column from the columns of the row', async () => {
        const user = userEvent.setup();
        const focus: { label: string; insert: (path: string) => void }[] = [];
        const ctx = context({ onFocusField: (h: { label: string; insert: (path: string) => void }) => { focus.push(h); } });
        const { last } = mount(DeriveForm as never, op('derive', 'd'), ctx);
        await user.type(screen.getByRole('textbox', { name: 'Name of the new column' }), 'Amount copy');
        expect(last().columns).toMatchObject([{ name: 'Amount copy', value: null }]);
        const box = screen.getByLabelText('Value');
        await user.click(box);
        await waitFor(() => expect(focus.length).toBeGreaterThan(0));
        act(() => { focus[focus.length - 1].insert('row.Amount'); });
        // An ordinary binding on the shared expression language, with the row's column in it.
        await waitFor(() => expect((last().columns as { value: unknown }[])[0].value).toEqual({ kind: 'template', value: '{{row.Amount}}' }));
    });
});

describe('sort into bands', () => {
    it('sets the limits of a band, with the end open when left empty', async () => {
        const user = userEvent.setup();
        const { last } = mount(BucketForm as never, op('bucket', 'b'));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Column' }), 'Amount');
        await user.type(screen.getByRole('textbox', { name: 'Name of the band' }), 'Small');
        await user.type(screen.getByRole('spinbutton', { name: 'Up to (not including)' }), '100');
        expect(last()).toMatchObject({ column: 'Amount', bands: [{ label: 'Small', min: null, max: 100 }] });
        await user.click(screen.getByRole('radio', { name: 'Equal parts' }));
        expect(last().mode).toBe('quantiles');
        expect(screen.getByRole('spinbutton', { name: 'Number of parts' })).toBeTruthy();
    });
});

describe('choose columns', () => {
    it('keeps some columns, or drops some, and renames one', async () => {
        const user = userEvent.setup();
        const { last } = mount(SelectForm as never, op('select', 's'));
        await user.click(screen.getByRole('radio', { name: 'Only the columns I choose' }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Add a column to: Columns to keep' }), 'Region');
        expect(last()).toMatchObject({ keep: ['Region'], drop: null });
        await user.click(screen.getByRole('radio', { name: 'All except the columns I choose' }));
        expect(last()).toMatchObject({ keep: null, drop: [] });
        await user.click(screen.getByRole('button', { name: 'Rename a column' }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Column' }), 'Amount');
        await user.type(screen.getByRole('textbox', { name: 'New name' }), 'Total');
        expect(last().rename).toEqual([{ from: 'Amount', to: 'Total' }]);
    });
});

describe('take a sample', () => {
    it('takes a number of rows or a percentage, never both', async () => {
        const user = userEvent.setup();
        const { last } = mount(SampleForm as never, op('sample', 's'));
        expect(last()).toBeUndefined();
        await user.click(screen.getByRole('radio', { name: 'A percentage of the rows' }));
        expect(last()).toMatchObject({ n: null, percent: 10 });
        await user.click(screen.getByRole('radio', { name: 'A random selection' }));
        expect(last().mode).toBe('random');
        expect(screen.getByRole('textbox', { name: 'Seed' })).toBeTruthy();
    });
});

describe('describe the columns', () => {
    it('describes all columns, or the ones chosen', async () => {
        const user = userEvent.setup();
        const { last } = mount(DescribeForm as never, op('describe', 'd'));
        await user.click(screen.getByRole('radio', { name: 'Choose columns' }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Add a column to: Which columns' }), 'Region');
        expect(last().columns).toEqual(['Region']);
    });
});
