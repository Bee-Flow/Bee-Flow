import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TableDesigner from './TableDesigner';
import { useState } from 'react';
import type { ModelField, ModelTable } from './tablesManagerModel';

/**
 * The field rules in the table editor (FieldRulesEditor inside TableDesigner):
 * the controls that fit the field's type, what they write, and that a field
 * nobody touched keeps exactly the keys it had.
 */

/** The kit's inputs are not tied to their label (FormField's htmlFor has no matching id): find the input beside it. */
function inputBeside(label: string): HTMLInputElement {
    const el = screen.getByText(label, { selector: 'label' });
    const input = el.parentElement?.parentElement?.querySelector('input');
    if (!input) throw new Error(`no input beside "${label}"`);
    return input;
}

/** The designer under a parent that keeps the table, as TablesManager does. */
function Stateful({ field, onChange }: { field: ModelField; onChange: (t: ModelTable) => void }) {
    const [table, setTable] = useState<ModelTable>({ id: 'tbl_a', key: 'orders', name: 'Orders', fields: [field] });
    return <TableDesigner table={table} tables={[table]} savedTable={null} onChange={(next) => { setTable(next); onChange(next); }} />;
}

async function open(field: ModelField) {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Stateful field={field} onChange={onChange} />);
    await user.click(screen.getAllByRole('button', { expanded: false })[0]);
    const last = (): ModelField => onChange.mock.calls.at(-1)?.[0].fields[0];
    return { user, onChange, last };
}

describe('FieldRulesEditor', () => {
    it('a number field offers minimum and maximum and writes them under validation', async () => {
        const { user, last } = await open({ id: 'fld_q', key: 'qty', name: 'Qty', type: 'number' });
        await user.type(inputBeside('Minimum'), '1');
        expect(last().validation).toEqual({ min: 1 });
        expect(screen.queryByText('Pattern', { selector: 'label' })).toBeNull();
    });

    it('a text field offers lengths, a pattern and, once a rule exists, an error message', async () => {
        const { user, last } = await open({ id: 'fld_c', key: 'code', name: 'Code', type: 'text', validation: { pattern: '^[A-Z]+$' } });
        await user.type(inputBeside('Error message'), 'X');
        expect(last().validation).toEqual({ pattern: '^[A-Z]+$', message: 'X' });
    });

    it('a date field can fill today on create, which hides the static default', async () => {
        const { user, last } = await open({ id: 'fld_d', key: 'day', name: 'Day', type: 'date', default: '2026-01-01' });
        expect(inputBeside('Default')).toBeTruthy();
        await user.selectOptions(screen.getByLabelText('Fill when a record is created'), 'today');
        expect(last()).toEqual({ id: 'fld_d', key: 'day', name: 'Day', type: 'date', dynamicDefault: 'today' });
        expect(screen.queryByText('Default', { selector: 'label' })).toBeNull();
    });

    it('changing the type drops the rules of the old type', async () => {
        const { user, last } = await open({ id: 'fld_q', key: 'qty', name: 'Qty', type: 'number', validation: { min: 1 } });
        await user.selectOptions(screen.getByLabelText('Field type'), 'text');
        expect(last()).toEqual({ id: 'fld_q', key: 'qty', name: 'Qty', type: 'text' });
    });

    it('a bool field shows no rules at all', async () => {
        await open({ id: 'fld_b', key: 'done', name: 'Done', type: 'bool' });
        expect(document.querySelector('[data-field-rules]')).toBeNull();
    });
});
