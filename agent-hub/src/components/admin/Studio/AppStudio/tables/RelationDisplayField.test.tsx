import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import RelationDisplayField from './RelationDisplayField';
import type { ModelField, ModelTable } from './tablesManagerModel';

const TABLES: ModelTable[] = [{
    id: 'tbl_cust', key: 'customers', name: 'Customers',
    fields: [
        { id: 'f1', key: 'name', name: 'Name', type: 'text' },
        { id: 'f2', key: 'code', name: 'Code', type: 'text' },
        { id: 'f3', key: 'parent', name: 'Parent', type: 'relation', relation: { table: 'tbl_cust' } },
    ],
}];

describe('relation display column', () => {
    it('lists the plain columns of the related table and writes the chosen key, keeping other relation keys', async () => {
        const user = userEvent.setup();
        const set = vi.fn();
        const field: ModelField = { id: 'f9', key: 'customer', type: 'relation', relation: { table: 'tbl_cust', fk: false } };
        const { getByLabelText } = render(<RelationDisplayField field={field} set={set} tables={TABLES} />);
        const select = getByLabelText('Show this column for each record') as HTMLSelectElement;
        expect([...select.options].map((o) => o.value)).toEqual(['', 'name', 'code']);
        await user.selectOptions(select, 'code');
        expect(set).toHaveBeenCalledWith({ relation: { table: 'tbl_cust', fk: false, displayField: 'code' } });
    });

    it('choosing Automatic removes the key, so a model that never used it is unchanged', async () => {
        const user = userEvent.setup();
        const set = vi.fn();
        const field: ModelField = { id: 'f9', key: 'customer', type: 'relation', relation: { table: 'tbl_cust', displayField: 'code' } };
        const { getByLabelText } = render(<RelationDisplayField field={field} set={set} tables={TABLES} />);
        await user.selectOptions(getByLabelText('Show this column for each record'), '');
        expect(set).toHaveBeenCalledWith({ relation: { table: 'tbl_cust' } });
    });

    it('shows nothing until a related table is chosen', () => {
        const { container } = render(<RelationDisplayField field={{ type: 'relation', relation: { table: '' } }} set={vi.fn()} tables={TABLES} />);
        expect(container.firstChild).toBeNull();
    });
});
