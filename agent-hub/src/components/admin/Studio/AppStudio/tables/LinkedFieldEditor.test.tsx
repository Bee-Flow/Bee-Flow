import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import LinkedFieldEditor from './LinkedFieldEditor';
import TableIndexesEditor from './TableIndexesEditor';
import { withLinkType } from './linkedFieldsModel';
import type { ModelTable } from './tablesManagerModel';

/**
 * The table editor's controls for fields that read through other records (lookup, rollup, the
 * many and onDelete options of a relation) and for a table's indexes.
 */

const CUSTOMERS: ModelTable = { id: 'tbl_cust01', key: 'customers', name: 'Customers', fields: [{ id: 'fld_n', key: 'name', name: 'Name', type: 'text' }] };
const ORDERS: ModelTable = {
    id: 'tbl_ord001', key: 'orders', name: 'Orders',
    fields: [
        { id: 'fld_a', key: 'amount', name: 'Amount', type: 'number' },
        { id: 'fld_c', key: 'customer', name: 'Customer', type: 'relation', relation: { table: 'tbl_cust01' } },
        { id: 'fld_l', key: 'label', name: 'Label', type: 'computed', computed: { expr: 'amount' } },
    ],
};
const TABLES = [CUSTOMERS, ORDERS];

describe('LinkedFieldEditor', () => {
    it('a relation can hold several records or say what a delete does, not both', async () => {
        const user = userEvent.setup();
        const update = vi.fn();
        const field = ORDERS.fields![1];
        const { rerender } = render(<LinkedFieldEditor field={field} update={update} tables={TABLES} table={ORDERS} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('When the linked record is deleted'), 'cascade');
        expect(update).toHaveBeenLastCalledWith({ ...field, relation: { table: 'tbl_cust01', onDelete: 'cascade' } });
        rerender(<LinkedFieldEditor field={{ ...field, relation: { table: 'tbl_cust01', onDelete: 'cascade' } }} update={update} tables={TABLES} table={ORDERS} disabled={false} />);
        await user.click(screen.getByLabelText('Holds several records'));
        expect(update).toHaveBeenLastCalledWith({ ...field, required: false, unique: false, relation: { table: 'tbl_cust01', many: true } });
    });

    it('a lookup picks a relation of its own table, then a stored field of the table it points at', async () => {
        const user = userEvent.setup();
        const update = vi.fn();
        const field = withLinkType({ id: 'fld_x', key: 'customer_name', type: 'lookup', default: 'x' }, 'lookup');
        expect(field).toEqual({ id: 'fld_x', key: 'customer_name', type: 'lookup', required: false, unique: false, lookup: {} });
        const { rerender } = render(<LinkedFieldEditor field={field} update={update} tables={TABLES} table={ORDERS} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('Through relation'), 'customer');
        const chosen = update.mock.lastCall![0];
        expect(chosen.lookup).toEqual({ relation: 'customer', field: '' });
        rerender(<LinkedFieldEditor field={chosen} update={update} tables={TABLES} table={ORDERS} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('Show field'), 'name');
        expect(update.mock.lastCall![0].lookup).toEqual({ relation: 'customer', field: 'name' });
    });

    it('a rollup offers the relations that point here and asks for a number field for a sum', async () => {
        const user = userEvent.setup();
        const update = vi.fn();
        const field = withLinkType({ id: 'fld_r', key: 'total', type: 'rollup' }, 'rollup');
        const { rerender } = render(<LinkedFieldEditor field={field} update={update} tables={TABLES} table={CUSTOMERS} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('Records that point here'), 'tbl_ord001:customer');
        const sourced = update.mock.lastCall![0];
        rerender(<LinkedFieldEditor field={sourced} update={update} tables={TABLES} table={CUSTOMERS} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('Calculate'), 'sum');
        const summed = update.mock.lastCall![0];
        rerender(<LinkedFieldEditor field={summed} update={update} tables={TABLES} table={CUSTOMERS} disabled={false} />);
        expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain('Label');
        await user.selectOptions(screen.getByLabelText('Of field'), 'amount');
        expect(update.mock.lastCall![0].rollup).toMatchObject({ table: 'tbl_ord001', relation: 'customer', fn: 'sum', field: 'amount' });
    });
});

describe('TableIndexesEditor', () => {
    it('adds an index on the first column, ticks more in order, and removing the last one drops the key', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { rerender } = render(<TableIndexesEditor table={ORDERS} onChange={onChange} disabled={false} />);
        await user.click(screen.getByText('Add index'));
        const added = onChange.mock.lastCall![0];
        expect(added.indexes).toEqual([{ fields: ['amount'] }]);
        rerender(<TableIndexesEditor table={added} onChange={onChange} disabled={false} />);
        expect(screen.queryByText('Label')).toBeNull();
        await user.click(screen.getByLabelText('created_at'));
        const two = onChange.mock.lastCall![0];
        expect(two.indexes).toEqual([{ fields: ['amount', 'created_at'] }]);
        rerender(<TableIndexesEditor table={two} onChange={onChange} disabled={false} />);
        await user.click(screen.getByText('Remove index'));
        expect(Object.hasOwn(onChange.mock.lastCall![0], 'indexes')).toBe(false);
    });
});
