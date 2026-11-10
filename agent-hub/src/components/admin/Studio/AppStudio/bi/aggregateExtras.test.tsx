import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { breakdownEntry, groupByColumnName, groupFilterEntries, measureIsNumeric, parseBinWidth } from './aggregateExtras';
import GroupByExtras from './GroupByExtras';
import GroupFilterField from './GroupFilterField';
import { buildDescriptor } from './QueryBuilder';
import type { AppTable } from './useAppTables';
import type { DatasetGroup } from './useDatasets';
import type { GroupFilterRow } from './aggregateExtras';

/**
 * The aggregate vocabulary after schema version 2 in the editors: a breakdown
 * through a relation or in number steps, countDistinct, and the group filter.
 * A breakdown that uses none of it comes out exactly as before.
 */

const ORDER_FIELDS = [
    { key: 'amount', name: 'Amount', type: 'number' },
    { key: 'customer', name: 'Customer', type: 'relation', relation: { table: 'tbl_cust01' } },
    { key: 'placed', name: 'Placed', type: 'date' },
    { key: 'channel', name: 'Channel', type: 'text' },
];
const TABLES: AppTable[] = [
    { id: 'tbl_ord01', key: 'orders', fields: ORDER_FIELDS },
    { id: 'tbl_cust01', key: 'customers', fields: [{ key: 'region', name: 'Region', type: 'text' }, { key: 'since', name: 'Since', type: 'date' }, { key: 'staff', name: 'Staff', type: 'number' }] },
];
const isDate = (type: string | undefined) => type === 'date' || type === 'datetime';
const t = ((_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key)) as never;

describe('aggregate descriptor parts', () => {
    it('a plain breakdown is unchanged; relation and step only when set and when they fit', () => {
        expect(breakdownEntry({ field: 'channel', bucket: '' }, TABLES, ORDER_FIELDS, isDate)).toEqual({ field: 'channel' });
        expect(breakdownEntry({ field: 'placed', bucket: 'month' }, TABLES, ORDER_FIELDS, isDate)).toEqual({ field: 'placed', bucket: 'month' });
        expect(breakdownEntry({ field: 'amount', binWidth: 50 }, TABLES, ORDER_FIELDS, isDate)).toEqual({ field: 'amount', binWidth: 50 });
        expect(breakdownEntry({ field: 'channel', binWidth: 50 }, TABLES, ORDER_FIELDS, isDate)).toEqual({ field: 'channel' });
        expect(breakdownEntry({ field: 'customer', relatedField: 'since', bucket: 'year' }, TABLES, ORDER_FIELDS, isDate)).toEqual({ field: 'customer', relatedField: 'since', bucket: 'year' });
        expect(breakdownEntry({ field: 'customer', relatedField: 'staff', binWidth: 10 }, TABLES, ORDER_FIELDS, isDate)).toEqual({ field: 'customer', relatedField: 'staff', binWidth: 10 });
        expect(breakdownEntry({ field: 'channel', relatedField: 'region' }, TABLES, ORDER_FIELDS, isDate)).toEqual({ field: 'channel' });
    });

    it('names output columns the way the compiler does', () => {
        expect(groupByColumnName({ field: 'placed', bucket: 'month' })).toBe('placed_month');
        expect(groupByColumnName({ field: 'amount', binWidth: 50 })).toBe('amount_bin');
        expect(groupByColumnName({ field: 'customer', relatedField: 'region' })).toBe('customer_region');
        expect(groupByColumnName({ field: 'customer', relatedField: 'region', as: 'r' })).toBe('r');
    });

    it('steps are whole numbers from 1; a group filter needs a number measure and a value', () => {
        expect([parseBinWidth('10'), parseBinWidth(''), parseBinWidth('2.5'), parseBinWidth(0)]).toEqual([10, undefined, undefined, undefined]);
        expect([measureIsNumeric('countDistinct', 'text'), measureIsNumeric('max', 'date'), measureIsNumeric('max', 'number')]).toEqual([true, false, true]);
        const rows: GroupFilterRow[] = [{ measure: 0, op: 'gte', value: '3' }, { measure: 1, op: 'lt', value: '' }, { measure: 2, op: 'gt', value: '1,5' }];
        expect(groupFilterEntries(rows, ['n', 'total', 'avg_amount'])).toEqual([{ field: 'n', op: 'gte', value: 3 }, { field: 'avg_amount', op: 'gt', value: 1.5 }]);
    });

    it('buildDescriptor without the new parts gives the descriptor it always gave', () => {
        const out = buildDescriptor('tbl_ord01', ORDER_FIELDS, [{ field: 'channel', bucket: '' }], [{ agg: 'countDistinct', field: 'customer', label: 'Buyers' }], []);
        expect(out.descriptor).toEqual({ groupBy: [{ field: 'channel' }], aggregates: [{ fn: 'countDistinct', field: 'customer', as: 'buyers' }], filters: [] });
        expect(out.valid).toBe(true);
    });
});

function ExtrasHarness({ initial, onChange }: { initial: DatasetGroup; onChange: (g: DatasetGroup) => void }) {
    const [group, setGroup] = useState(initial);
    return <GroupByExtras t={t} group={group} update={(g) => { setGroup(g); onChange(g); }} fields={ORDER_FIELDS} tables={TABLES} inputClass="" />;
}

describe('GroupByExtras', () => {
    it('renders nothing for a text breakdown', () => {
        const { container } = render(<ExtrasHarness initial={{ field: 'channel' }} onChange={vi.fn()} />);
        expect(container.textContent).toBe('');
    });

    it('a relation breakdown picks a field of the linked record, then its date grouping', async () => {
        const onChange = vi.fn();
        render(<ExtrasHarness initial={{ field: 'customer' }} onChange={onChange} />);
        await userEvent.selectOptions(screen.getByLabelText('Which field of the linked record'), 'since');
        expect(onChange).toHaveBeenLastCalledWith({ field: 'customer', relatedField: 'since' });
        await userEvent.selectOptions(screen.getByLabelText('Group dates'), 'year');
        expect(onChange).toHaveBeenLastCalledWith({ field: 'customer', relatedField: 'since', bucket: 'year' });
        await userEvent.selectOptions(screen.getByLabelText('Which field of the linked record'), '');
        expect(onChange).toHaveBeenLastCalledWith({ field: 'customer' });
    });

    it('a number breakdown takes a step, and an empty step removes it', async () => {
        const onChange = vi.fn();
        render(<ExtrasHarness initial={{ field: 'amount' }} onChange={onChange} />);
        await userEvent.type(screen.getByPlaceholderText('Exact values'), '25');
        expect(onChange).toHaveBeenLastCalledWith({ field: 'amount', binWidth: 25 });
        await userEvent.clear(screen.getByPlaceholderText('Exact values'));
        expect(onChange).toHaveBeenLastCalledWith({ field: 'amount' });
    });
});

function FilterHarness({ onChange }: { onChange: (rows: GroupFilterRow[]) => void }) {
    const [rows, setRows] = useState<GroupFilterRow[]>([]);
    const measures = [{ label: 'Last placed', numeric: false }, { label: 'Count', numeric: true }];
    return <GroupFilterField t={t} rows={rows} setRows={(r) => { setRows(r); onChange(r); }} measures={measures} inputClass="" />;
}

describe('GroupFilterField', () => {
    it('adds a condition on a number measure only', async () => {
        const onChange = vi.fn();
        render(<FilterHarness onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: /Add a condition/ }));
        expect(onChange).toHaveBeenLastCalledWith([{ measure: 1, op: 'gte', value: '' }]);
        expect(screen.queryByRole('option', { name: 'Last placed' })).toBeNull();
        await userEvent.selectOptions(screen.getByLabelText('Comparison'), 'gt');
        await userEvent.type(screen.getByLabelText('Value'), '4');
        expect(onChange).toHaveBeenLastCalledWith([{ measure: 1, op: 'gt', value: '4' }]);
    });

    it('says what to add first when no measure yields a number', () => {
        render(<GroupFilterField t={t} rows={[]} setRows={vi.fn()} measures={[{ label: 'Last', numeric: false }]} inputClass="" />);
        expect(screen.getByText('Add a count, sum or average first.')).toBeTruthy();
    });
});
