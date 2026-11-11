import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import FilterRowsEditor, { FilterRow } from './FilterRowsEditor';
import { allowedOps } from './FilterRowsEditor.helpers';

/**
 * The operators the query compiler has always taken and the editor did not offer (does not
 * contain, ends with, is not one of), and the per-row "ignore upper and lower case" switch.
 */

const FIELDS = [
    { key: 'title', name: 'Title', type: 'text' },
    { key: 'amount', name: 'Amount', type: 'number' },
    { key: 'done', name: 'Done', type: 'bool' },
];

function renderEditor(filters: FilterRow[], allowIgnoreCase = false) {
    const onChange = vi.fn();
    const utils = render(<FilterRowsEditor fields={FIELDS} filters={filters} onChange={onChange} allowIgnoreCase={allowIgnoreCase} />);
    return { onChange, last: () => onChange.mock.calls.at(-1)?.[0], ...utils };
}

describe('the operators of a text column', () => {
    it('offers does-not-contain, ends-with and is-not-one-of', () => {
        const ops = allowedOps(FIELDS[0]);
        expect(ops).toEqual(expect.arrayContaining(['notContains', 'endsWith', 'notIn']));
        expect(allowedOps(FIELDS[1])).toContain('notIn');
        expect(allowedOps(FIELDS[2])).not.toContain('notContains');
    });

    it('shows a text box for ends-with and a list for is-not-one-of', async () => {
        const user = userEvent.setup();
        const ends = renderEditor([{ field: 'title', op: 'endsWith', value: '' }]);
        await user.type(ends.getByLabelText('Filter value'), 'x');
        expect(ends.last()[0]).toEqual({ field: 'title', op: 'endsWith', value: 'x' });
        ends.unmount();

        const notIn = renderEditor([{ field: 'title', op: 'notIn', value: [] }]);
        await user.type(notIn.getByLabelText('Filter values'), 'a, b');
        expect(Array.isArray(notIn.last()[0].value)).toBe(true);
    });

    it('moves from a scalar to a list when the operator becomes is-not-one-of', async () => {
        const user = userEvent.setup();
        const { last, getByLabelText } = renderEditor([{ field: 'title', op: 'eq', value: 'a' }]);
        await user.selectOptions(getByLabelText('Filter operator'), 'notIn');
        expect(last()[0]).toEqual({ field: 'title', op: 'notIn', value: [] });
    });
});

describe('ignore upper and lower case', () => {
    it('is not offered unless the caller allows it, nor off an is-row or a number column', () => {
        expect(renderEditor([{ field: 'title', op: 'eq', value: 'a' }]).queryByText('Ignore upper and lower case')).toBeNull();
        expect(renderEditor([{ field: 'title', op: 'contains', value: 'a' }], true).queryByText('Ignore upper and lower case')).toBeNull();
        expect(renderEditor([{ field: 'amount', op: 'eq', value: '1' }], true).queryByText('Ignore upper and lower case')).toBeNull();
    });

    it('writes ci only when switched on, and drops it when switched off or the operator changes', async () => {
        const user = userEvent.setup();
        const on = renderEditor([{ field: 'title', op: 'eq', value: 'a' }], true);
        await user.click(on.getByRole('checkbox', { name: /Ignore upper and lower case/ }));
        expect(on.last()[0]).toEqual({ field: 'title', op: 'eq', value: 'a', ci: true });
        on.unmount();

        const off = renderEditor([{ field: 'title', op: 'eq', value: 'a', ci: true }], true);
        await user.click(off.getByRole('checkbox', { name: /Ignore upper and lower case/ }));
        expect(off.last()[0]).toEqual({ field: 'title', op: 'eq', value: 'a' });
        off.unmount();

        const moved = renderEditor([{ field: 'title', op: 'eq', value: 'a', ci: true }], true);
        await user.selectOptions(moved.getByLabelText('Filter operator'), 'neq');
        expect(moved.last()[0]).toEqual({ field: 'title', op: 'neq', value: 'a' });
    });
});
