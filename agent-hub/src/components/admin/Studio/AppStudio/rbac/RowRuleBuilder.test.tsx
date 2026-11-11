import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import RowRuleBuilder from './RowRuleBuilder';
import { buildRowRule } from './rowRuleModel';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

const table = {
    id: 't1',
    key: 'salaries',
    name: 'Salaries',
    fields: [
        { key: 'owner_id', name: 'Owner', type: 'text' },
        { key: 'status', name: 'Status', type: 'select', options: ['open', 'closed'] },
        { key: 'amount', name: 'Amount', type: 'number' },
        { key: 'approved', name: 'Approved', type: 'bool' },
        { key: 'starts_on', name: 'Starts on', type: 'date' },
    ],
};

function setup(state: { join?: unknown; conditions?: unknown } = {}, props = {}) {
    const onChange = vi.fn();
    const utils = render(
        <RowRuleBuilder
            table={table}
            join={stub<ComponentProps<typeof RowRuleBuilder>['join']>(state.join || 'and')}
            conditions={stub<ComponentProps<typeof RowRuleBuilder>['conditions']>(state.conditions || [])}
            onChange={onChange}
            {...props}
        />,
    );
    return { ...utils, onChange };
}

const cond = (patch: Record<string, unknown>) => ({ id: 'c1', field: 'owner_id', op: '==', source: 'value', value: '', valueType: 'string', ...patch });

describe('RowRuleBuilder — starting a rule', () => {
    it('offers the two starting points and no conditions yet', () => {
        const { getByText, queryByTestId } = setup();
        expect(queryByTestId('row-rule-builder')).toBeNull();
        expect(getByText('Only rows they added themselves')).toBeTruthy();
        expect(getByText('Add a condition')).toBeTruthy();
    });

    it('turns the "rows they added" shortcut into a picker condition, not typed text', async () => {
        const user = userEvent.setup();
        const { getByText, onChange } = setup();
        await user.click(getByText('Only rows they added themselves'));
        const next = onChange.mock.calls[0][0];
        expect(buildRowRule(next)).toBe('record.created_by == viewer.id');
    });
});

describe('RowRuleBuilder — the three picker columns', () => {
    it('lists the table fields by name and the built-in columns', () => {
        const { getByLabelText } = setup({ conditions: [cond({})] });
        const labels = [...(getByLabelText('Column, condition 1') as HTMLSelectElement).options].map((o) => o.textContent);
        expect(labels).toContain('Owner');
        expect(labels).toContain('Who added the row');
    });

    it('names the runtime values in plain words', () => {
        const { getByLabelText } = setup({ conditions: [cond({})] });
        const labels = [...(getByLabelText('Compare with, condition 1') as HTMLSelectElement).options].map((o) => o.textContent);
        expect(labels).toEqual([
            'a value I type',
            'the person opening the app',
            'their e-mail address',
            'one of their groups',
            'the organisation of their account',
            'their role',
        ]);
    });

    it('still shows viewer.organizationId on a rule that uses it, and only there', () => {
        const { getByLabelText } = setup({ conditions: [cond({ source: 'viewer.organizationId' }), cond({ id: 'c2' })] });
        const labelsOf = (n: number) => [...(getByLabelText(`Compare with, condition ${n}`) as HTMLSelectElement).options].map((o) => o.textContent);
        expect(labelsOf(1)).toContain('their organisation');
        expect(labelsOf(2)).not.toContain('their organisation');
    });

    it('picking their groups turns the test into membership, and picking something else turns it back', async () => {
        const user = userEvent.setup();
        const first = setup({ conditions: [cond({})] });
        await user.selectOptions(first.getByLabelText('Compare with, condition 1'), 'viewer.groups');
        const picked = first.onChange.mock.calls.at(-1)![0].conditions[0];
        expect(picked).toMatchObject({ op: 'in', source: 'viewer.groups' });
        expect(buildRowRule({ conditions: [picked] })).toBe('record.owner_id in viewer.groups');
        first.unmount();

        const { getByLabelText, onChange } = setup({ conditions: [picked] });
        const tests = [...(getByLabelText('Test, condition 1') as HTMLSelectElement).options].map((o) => o.value);
        expect(tests).toEqual(['in']);
        await user.selectOptions(getByLabelText('Compare with, condition 1'), 'viewer.id');
        expect(onChange.mock.calls.at(-1)![0].conditions[0]).toMatchObject({ op: '==', source: 'viewer.id' });
    });

    it('says so when the column cannot be compared with their groups', () => {
        const { getByText } = setup({ conditions: [cond({ field: 'amount', op: 'in', source: 'viewer.groups' })] });
        expect(getByText('Only a text or choice column can be compared with their groups.')).toBeTruthy();
    });

    it('types the value control off the picked column', () => {
        // One render per field type, queried inside its own container — they all
        // share the same document body.
        const valueControl = (field: string, patch: Record<string, unknown>) => setup({ conditions: [cond({ field, ...patch })] })
            .container.querySelector('[aria-label="Value, condition 1"]');

        expect((valueControl('amount', { valueType: 'number', value: '5' })! as HTMLInputElement).type).toBe('number');
        expect((valueControl('starts_on', {})! as HTMLInputElement).type).toBe('date');
        expect([...(valueControl('approved', { valueType: 'bool', value: 'true' })! as HTMLSelectElement).options].map((o) => o.textContent))
            .toEqual(['yes', 'no']);
        expect([...(valueControl('status', {})! as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', 'open', 'closed']);
    });

    it('keeps a saved choice that is no longer one of the options', () => {
        const { getByLabelText } = setup({ conditions: [cond({ field: 'status', value: 'archived' })] });
        expect((getByLabelText('Value, condition 1') as HTMLInputElement).value).toBe('archived');
    });

    it('drops the value control for "is blank"', () => {
        const { queryByLabelText } = setup({ conditions: [cond({ op: 'empty' })] });
        expect(queryByLabelText('Value, condition 1')).toBeNull();
        expect(queryByLabelText('Compare with, condition 1')).toBeNull();
    });

    it('re-types the value when the column changes underneath it', async () => {
        const user = userEvent.setup();
        const { getByLabelText, onChange } = setup({ conditions: [cond({ value: 'abc' })] });
        await user.selectOptions(getByLabelText('Column, condition 1'), 'amount');
        expect(onChange.mock.calls[0][0].conditions[0]).toMatchObject({ field: 'amount', valueType: 'number', value: '' });
    });

    it('says in words what a condition is still missing', () => {
        const { getByText } = setup({ conditions: [cond({ value: '' })] });
        expect(getByText('Fill in the value.')).toBeTruthy();
    });
});

describe('RowRuleBuilder — several conditions', () => {
    const two = [cond({ id: 'c1', source: 'viewer.id' }), cond({ id: 'c2', field: 'status', value: 'open' })];

    it('only asks about all/any once there is something to join', () => {
        expect(setup({ conditions: [cond({})] }).container.querySelector('[aria-label="Match all or any"]')).toBeNull();
        expect(setup({ conditions: two }).container.querySelector('[aria-label="Match all or any"]')).toBeTruthy();
    });

    it('warns that "any" widens what the role sees', () => {
        const { getByText } = setup({ join: 'or', conditions: two });
        expect(getByText(/each extra condition shows them more rows, not fewer/)).toBeTruthy();
    });

    it('adds and removes conditions', async () => {
        const user = userEvent.setup();
        const { getByText, getByLabelText, onChange } = setup({ conditions: two });
        await user.click(getByText('Add a condition'));
        expect(onChange.mock.calls[0][0].conditions).toHaveLength(3);

        await user.click(getByLabelText('Remove condition 1'));
        expect(onChange.mock.calls[1][0].conditions.map((c: { field: unknown }) => c.field)).toEqual(['status']);
    });

    it('explains what a blank check really matches', () => {
        const { getByText } = setup({ conditions: [cond({ op: 'notEmpty' })] });
        expect(getByText(/never filled in at all stay out either way/)).toBeTruthy();
    });
});

describe('RowRuleBuilder — no access selected', () => {
    it('disables every control', () => {
        const { getByLabelText } = setup({ conditions: [cond({})] }, { disabled: true });
        expect((getByLabelText('Column, condition 1') as HTMLInputElement).disabled).toBe(true);
        expect((getByLabelText('Test, condition 1') as HTMLInputElement).disabled).toBe(true);
        expect((getByLabelText('Remove condition 1') as HTMLInputElement).disabled).toBe(true);
    });
});

/**
 * A select column's options may be plain strings OR {value,label} objects —
 * the shape optionPairs exists to normalise, and the one the table designer
 * writes as soon as a choice is given a display name. Rendering the raw entries
 * put an OBJECT in a React child slot, which throws: opening the row-rule
 * builder on such a column took the whole Roles & access panel down.
 */
describe('RowRuleBuilder — a choice column with {value,label} options', () => {
    const labelled = {
        ...table,
        fields: table.fields.map((f) => (f.key === 'status'
            ? { ...f, options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] }
            : f)),
    };
    const statusCond = (value: unknown) => cond({ field: 'status', op: '==', source: 'value', value, valueType: 'string' });

    it('renders the choices by their label instead of crashing', () => {
        const { getByLabelText } = setup(
            { conditions: [statusCond('open')] },
            { table: labelled },
        );
        const select = getByLabelText('Value, condition 1');
        expect([...(select as HTMLSelectElement).options].map((o) => o.textContent))
            .toEqual(expect.arrayContaining(['Open', 'Done']));
        // The value written is the option's VALUE, not its label.
        expect((select as HTMLInputElement).value).toBe('open');
    });

    it('keeps a saved value that is no longer one of the choices', () => {
        const { getByLabelText } = setup(
            { conditions: [statusCond('archived')] },
            { table: labelled },
        );
        expect((getByLabelText('Value, condition 1') as HTMLInputElement).value).toBe('archived');
    });
});
