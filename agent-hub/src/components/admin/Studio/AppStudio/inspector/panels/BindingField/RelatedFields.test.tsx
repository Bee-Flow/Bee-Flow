import { createRequire } from 'node:module';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    MAX_EXPAND, MAX_EXPAND_PICK, expandAlias, expandedColumnKeys, relationFilterFields, relationLinks, toggleField, togglePick,
} from '@/components/admin/Studio/AppStudio/bi/relationRead';
import type { AppTable } from '@/components/admin/Studio/AppStudio/bi/useAppTables';
import { RelatedFields } from './RelatedFields';
import type { BindingDraft } from '../BindingField.types';
import type { TableColumn } from '../../aiFieldMatching';

/**
 * Reading through a relation in the table binding editor: which fields of a
 * linked record come along (`expand`), which columns are loaded (`fields`),
 * and what the column picker and the filter rows offer because of it. A
 * binding that uses neither comes out exactly as it went in.
 */

const ORDER_FIELDS: Array<TableColumn & { relation?: { table: string; displayField?: string } }> = [
    { key: 'amount', name: 'Amount', type: 'number' },
    { key: 'customer', name: 'Customer', type: 'relation', relation: { table: 'tbl_cust01', displayField: 'name' } },
    { key: 'feed', name: 'Feed', type: 'relation', relation: { table: 'tbl_link01' } },
    { key: 'margin', name: 'Margin', type: 'computed' },
];
const LINKED_FIELDS: typeof ORDER_FIELDS = [{ key: 'label', name: 'Label', type: 'text' }, { key: 'owner', name: 'Owner', type: 'relation', relation: { table: 'tbl_cust01' } }];
const TABLES: AppTable[] = [
    { id: 'tbl_ord01', key: 'orders', name: 'Orders', fields: ORDER_FIELDS },
    { id: 'tbl_cust01', key: 'customers', name: 'Customers', fields: [{ key: 'name', name: 'Name', type: 'text' }, { key: 'city', name: 'City', type: 'text' }, { key: 'tags', name: 'Tags', type: 'multiselect' }, { key: 'score', name: 'Score', type: 'computed' }] },
    { id: 'tbl_link01', key: 'feed', name: 'Feed', linked: true, fields: LINKED_FIELDS },
];

function Harness({ initial, onChange }: { initial: BindingDraft; onChange: (next: BindingDraft) => void }) {
    const [binding, setBinding] = useState<BindingDraft>(initial);
    return (
        <RelatedFields
            binding={binding}
            tables={TABLES}
            fields={ORDER_FIELDS}
            onPatch={(p) => {
                const next = { ...binding, ...p };
                if (next.expand === undefined) delete next.expand;
                if (next.fields === undefined) delete next.fields;
                setBinding(next);
                onChange(next);
            }}
        />
    );
}
const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

describe('reading through a relation: the pure parts', () => {
    it('keeps the server limits', () => {
        const require = createRequire(import.meta.url);
        const { RELATION_READ_LIMITS } = require('../../../../../../../../../server/core/dataEngine/dataModel/vocabulary.js');
        expect(MAX_EXPAND).toBe(RELATION_READ_LIMITS.MAX_EXPAND);
        expect(MAX_EXPAND_PICK).toBe(RELATION_READ_LIMITS.MAX_EXPAND_PICK);
    });

    it('follows a relation only to a table of the app with its own rows, and never from a linked table', () => {
        expect(relationLinks(TABLES, 'tbl_ord01').map((l) => [l.field.key, l.target.key])).toEqual([['customer', 'customers']]);
        expect(relationLinks(TABLES, 'orders')).toHaveLength(1);
        expect(relationLinks(TABLES, 'tbl_link01')).toEqual([]);
        expect(relationLinks(TABLES, 'nope')).toEqual([]);
    });

    it('ticks a field of a linked record in and out; the last one out removes the entry and then the key', () => {
        const one = togglePick(undefined, 'customer', 'name');
        expect(one).toEqual([{ field: 'customer', pick: ['name'] }]);
        const two = togglePick(one, 'customer', 'city');
        expect(two).toEqual([{ field: 'customer', pick: ['name', 'city'] }]);
        expect(togglePick(two, 'customer', 'name')).toEqual([{ field: 'customer', pick: ['city'] }]);
        expect(togglePick(one, 'customer', 'name')).toBeUndefined();
        // An entry written elsewhere keeps what the editor does not manage.
        expect(togglePick([{ field: 'customer', pick: ['name'], as: 'buyer' }, 'junk'], 'customer', 'city')).toEqual([{ field: 'customer', pick: ['name', 'city'], as: 'buyer' }]);
        const full = Array.from({ length: MAX_EXPAND }, (_, i) => ({ field: `r${i}`, pick: ['x'] }));
        expect(togglePick(full, 'customer', 'name')).toEqual(full);
    });

    it('ticks a column to load in and out', () => {
        expect(toggleField(undefined, 'amount')).toEqual(['amount']);
        expect(toggleField(['amount'], 'customer')).toEqual(['amount', 'customer']);
        expect(toggleField(['amount'], 'amount')).toBeUndefined();
    });

    it('names the columns an expansion offers the way the server delivers them', () => {
        expect(expandAlias({ field: 'customer' })).toBe('customer_record');
        expect(expandedColumnKeys(TABLES, 'tbl_ord01', [{ field: 'customer', pick: ['name', 'city'] }])).toEqual(['customer_record.name', 'customer_record.city']);
        expect(expandedColumnKeys(TABLES, 'tbl_ord01', [{ field: 'customer', as: 'buyer' }])).toEqual(['buyer.name']);
        expect(expandedColumnKeys(TABLES, 'tbl_ord01', [{ field: 'feed', pick: ['label'] }])).toEqual([]);
        expect(expandedColumnKeys(TABLES, 'tbl_ord01', undefined)).toEqual([]);
    });

    it('offers the fields of a linked record as filter fields, without the ones a filter cannot read', () => {
        expect(relationFilterFields(TABLES, 'tbl_ord01').map((f) => [f.key, f.name])).toEqual([['customer.name', 'Customer › Name'], ['customer.city', 'Customer › City']]);
        expect(relationFilterFields(TABLES, 'tbl_link01')).toEqual([]);
    });
});

describe('RelatedFields', () => {
    it('is closed for a binding that uses neither, and changes nothing until something is ticked', () => {
        const onChange = vi.fn();
        const { container } = render(<Harness initial={{ kind: 'records', tableId: 'tbl_ord01' }} onChange={onChange} />);
        expect(container.querySelector('details')?.open).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('writes expand per linked table and removes it again; a linked Studio table is not offered', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { container } = render(<Harness initial={{ kind: 'records', tableId: 'tbl_ord01', expand: [{ field: 'customer', pick: ['name'] }] }} onChange={onChange} />);
        expect(container.querySelector('details')?.open).toBe(true);
        const group = screen.getByRole('group', { name: 'Customer: fields of Customers' });
        expect(within(group).getByRole('checkbox', { name: 'Name' })).toBeChecked();
        expect(within(group).queryByRole('checkbox', { name: 'Score' })).toBeNull();
        expect(screen.queryByRole('group', { name: /Feed/ })).toBeNull();
        expect(within(group).getByText('Use them in a column as customer_record.name.')).toBeInTheDocument();

        await user.click(within(group).getByRole('checkbox', { name: 'City' }));
        expect(last(onChange)).toEqual({ kind: 'records', tableId: 'tbl_ord01', expand: [{ field: 'customer', pick: ['name', 'city'] }] });
        await user.click(within(group).getByRole('checkbox', { name: 'City' }));
        await user.click(within(group).getByRole('checkbox', { name: 'Name' }));
        expect(last(onChange)).toEqual({ kind: 'records', tableId: 'tbl_ord01' });
    });

    it('writes the columns to load, and drops the key when none is ticked', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={{ kind: 'records', tableId: 'tbl_ord01', fields: ['amount'] }} onChange={onChange} />);
        const group = screen.getByRole('group', { name: 'Columns to load' });
        expect(within(group).queryByRole('checkbox', { name: 'Margin' })).toBeNull();
        await user.click(within(group).getByRole('checkbox', { name: 'Customer' }));
        expect(last(onChange)).toEqual({ kind: 'records', tableId: 'tbl_ord01', fields: ['amount', 'customer'] });
        await user.click(within(group).getByRole('checkbox', { name: 'Customer' }));
        await user.click(within(group).getByRole('checkbox', { name: 'Amount' }));
        expect(last(onChange)).toEqual({ kind: 'records', tableId: 'tbl_ord01' });
    });

    it('says so when the table links to nothing', () => {
        render(<Harness initial={{ kind: 'records', tableId: 'tbl_cust01', fields: ['name'] }} onChange={vi.fn()} />);
        expect(screen.getByText('This table has no field that links to another table of the app.')).toBeInTheDocument();
    });
});
