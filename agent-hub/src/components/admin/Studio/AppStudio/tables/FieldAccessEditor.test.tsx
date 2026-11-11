import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import FieldAccessEditor from './FieldAccessEditor';
import TableDesigner from './TableDesigner';
import { accessOf, roleKeysOf, withAccessForType, withAccessList, withRole } from './fieldAccess';
import type { ModelField, ModelTable } from './tablesManagerModel';

/**
 * Column rights in the table editor (FieldAccessEditor): a list exists only once its switch is
 * on, what the controls write is what the server's model check accepts, and a field nobody
 * limited keeps exactly the keys it had.
 */

const require = createRequire(import.meta.url);
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../../server');
const { fieldAccessErrors } = require(path.join(SERVER, 'core/dataEngine/columnRights.mts'));

const ROLES = roleKeysOf([{ key: 'manager' }, { key: 'member' }, { key: 'public' }, null, { key: 'member' }]);
const BASE: ModelField = { id: 'fld_pay001', key: 'salary', name: 'Salary', type: 'number' };

function Stateful({ field, onChange }: { field: ModelField; onChange: (f: ModelField) => void }) {
    const [current, setCurrent] = useState(field);
    return <FieldAccessEditor field={current} roles={ROLES} disabled={false} update={(next) => { setCurrent(next); onChange(next); }} />;
}

function open(field: ModelField) {
    const onChange = vi.fn();
    render(<Stateful field={field} onChange={onChange} />);
    return { user: userEvent.setup(), last: (): ModelField => onChange.mock.calls.at(-1)?.[0] };
}

describe('FieldAccessEditor', () => {
    it('lists the app roles once, with the public role last', () => {
        expect(ROLES).toEqual(['manager', 'member', 'public']);
    });

    it('limiting who sees a field starts with the owner only, and each tick names a role', async () => {
        const { user, last } = open(BASE);
        expect(screen.queryByLabelText('manager')).toBeNull();
        await user.click(screen.getByLabelText('Only some roles can see it'));
        expect(last()).toEqual({ ...BASE, access: { read: [] } });
        await user.click(screen.getByLabelText('manager'));
        await user.click(screen.getByLabelText('Visitors of public pages'));
        expect(last().access).toEqual({ read: ['manager', 'public'] });
        expect(fieldAccessErrors(last(), 'f')).toEqual([]);
        await user.click(screen.getByLabelText('manager'));
        expect(last().access).toEqual({ read: ['public'] });
    });

    it('switching both lists off again leaves the field as it was', async () => {
        const { user, last } = open({ ...BASE, access: { read: ['manager'], write: [] } });
        await user.click(screen.getByLabelText('Only some roles can change it'));
        expect(last()).toEqual({ ...BASE, access: { read: ['manager'] } });
        await user.click(screen.getByLabelText('Only some roles can see it'));
        expect(last()).toEqual(BASE);
        expect(Object.keys(last())).toEqual(Object.keys(BASE));
    });

    it('a role the app no longer has stays listed so it can be unticked', async () => {
        const { user, last } = open({ ...BASE, access: { write: ['former'] } });
        await user.click(screen.getByLabelText('former'));
        expect(last().access).toEqual({ write: [] });
    });

    it('a computed field has no write list', () => {
        open({ ...BASE, type: 'computed', computed: { expr: 'a + b' } });
        expect(screen.getByLabelText('Only some roles can see it')).toBeTruthy();
        expect(screen.queryByLabelText('Only some roles can change it')).toBeNull();
    });

    it('the helpers never write an empty access, and read what is stored', () => {
        expect(withAccessList(BASE, 'read', null)).toEqual(BASE);
        expect(withRole(BASE, 'write', 'member', true)).toEqual({ ...BASE, access: { write: ['member'] } });
        expect(withRole({ ...BASE, access: { read: ['a', 'a'] } }, 'read', 'a', true).access).toEqual({ read: ['a'] });
        // A type that is never written loses its write list; any other field is the same object.
        const both = { ...BASE, access: { read: ['a'], write: ['a'] } };
        expect(withAccessForType(both)).toBe(both);
        expect(withAccessForType({ ...both, type: 'computed' }).access).toEqual({ read: ['a'] });
        expect(accessOf({ ...BASE, access: 'manager' })).toEqual({});
        expect(accessOf({ ...BASE, access: { read: ['a', 3], other: true } })).toEqual({ read: ['a'] });
    });
});

describe('TableDesigner and column rights', () => {
    const table = (extra: Partial<ModelTable>): ModelTable => ({ id: 'tbl_a', key: 'staff', name: 'Staff', fields: [BASE], ...extra });

    async function openField(t: ModelTable, roles: string[] | null) {
        render(<TableDesigner table={t} tables={[t]} savedTable={null} onChange={() => {}} roles={roles} />);
        await userEvent.setup().click(screen.getAllByRole('button', { expanded: false })[0]);
    }

    it('offers them on a table of the app', async () => {
        await openField(table({}), ROLES);
        expect(screen.getByText('Who can see and change this field')).toBeTruthy();
    });

    it('does not offer them on a linked table: its rights live on the Studio table', async () => {
        await openField(table({ source: { kind: 'datatable', datatableId: 'tbl_abcd', mode: 'read' } }), ROLES);
        expect(screen.queryByText('Who can see and change this field')).toBeNull();
    });
});
