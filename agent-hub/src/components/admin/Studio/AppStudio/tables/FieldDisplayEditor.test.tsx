import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FieldDisplayEditor from './FieldDisplayEditor';
import TableDesigner from './TableDesigner';

/**
 * The schema-3 controls of a field: the kind of text, the display block per type, and what
 * choosing an autonumber does to the rest of the field (TableDesigner).
 */

describe('FieldDisplayEditor', () => {
    it('a text field gets a kind-of-text picker that writes field.format', async () => {
        const user = userEvent.setup();
        const update = vi.fn();
        render(<FieldDisplayEditor field={{ id: 'fld_a', key: 'mail', type: 'text' }} update={update} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('Kind of text'), 'email');
        expect(update).toHaveBeenLastCalledWith({ id: 'fld_a', key: 'mail', type: 'text', format: 'email' });
        expect(screen.queryByText('Display')).toBeNull();
    });

    it('a number field gets currency, decimals and unit; a date field a date style; a bool nothing', async () => {
        const user = userEvent.setup();
        const update = vi.fn();
        const { rerender } = render(<FieldDisplayEditor field={{ id: 'fld_p', key: 'price', type: 'number' }} update={update} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
        expect(update).toHaveBeenLastCalledWith({ id: 'fld_p', key: 'price', type: 'number', display: { currency: 'USD' } });
        // The kit's number and text fields do not tie their label to the input (known, predates this).
        expect(screen.getByText('Decimals')).toBeTruthy();
        expect(screen.getByText('Unit')).toBeTruthy();

        rerender(<FieldDisplayEditor field={{ id: 'fld_d', key: 'due', type: 'date' }} update={update} disabled={false} />);
        await user.selectOptions(screen.getByLabelText('Date style'), 'long');
        expect(update).toHaveBeenLastCalledWith({ id: 'fld_d', key: 'due', type: 'date', display: { dateStyle: 'long' } });

        rerender(<FieldDisplayEditor field={{ id: 'fld_b', key: 'ok', type: 'bool' }} update={update} disabled={false} />);
        expect(screen.queryByText('Display')).toBeNull();
    });

    it('choosing an autonumber makes the field unique, not required, without a default, and hides those controls', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const draft = { id: 'fld_n', key: 'no', name: 'No', type: 'text', required: true, default: 'x' };
        const table = { id: 'tbl_a', key: 'orders', name: 'Orders', fields: [draft] };
        const { rerender } = render(<TableDesigner table={table} tables={[table]} onChange={onChange} />);
        await user.click(screen.getAllByRole('button', { expanded: false })[0]);
        await user.selectOptions(screen.getByLabelText('Field type'), 'autonumber');
        const next = onChange.mock.calls.at(-1)?.[0].fields[0];
        expect(next).toEqual({ id: 'fld_n', key: 'no', name: 'No', type: 'autonumber', required: false, unique: true });

        rerender(<TableDesigner table={{ ...table, fields: [next] }} tables={[table]} onChange={onChange} />);
        expect(screen.queryByText('Required')).toBeNull();
        expect(screen.queryByText('Default')).toBeNull();
        expect(screen.getByText(/Numbered by the app/)).toBeTruthy();
    });
});
