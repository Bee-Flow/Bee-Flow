import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MatchMode, SearchOption } from './ReadOptions';
import { searchableFields, searchExpr, withSearchFields } from './readOptions.helpers';
import type { AppDefinition } from '../../appDefinition';

/** How filters join and the free search of a table binding: written only when the author sets them. */

const FIELDS = [
    { key: 'title', name: 'Title', type: 'text' },
    { key: 'note', name: 'Note', type: 'long_text' },
    { key: 'amount', name: 'Amount', type: 'number' },
];
const DEFINITION = { screens: [] } as unknown as AppDefinition;
const FORMULA = { kind: 'formula', expr: 'vars.q' };

describe('MatchMode', () => {
    it('writes any, and nothing at all for the default', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { getByRole } = render(<MatchMode match={undefined} onChange={onChange} disabled={false} />);
        await user.selectOptions(getByRole('combobox'), 'any');
        expect(onChange).toHaveBeenLastCalledWith('any');
        await user.selectOptions(getByRole('combobox'), 'all');
        expect(onChange).toHaveBeenLastCalledWith(undefined);
    });
});

describe('SearchOption', () => {
    it('switches on with the first text column and a search-box formula, off with no search at all', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const view = render(<SearchOption search={undefined} fields={FIELDS} onChange={onChange} disabled={false} definition={DEFINITION} node={null} />);
        await user.click(view.getByRole('checkbox', { name: 'Search in some columns' }));
        expect(onChange).toHaveBeenLastCalledWith({ value: { kind: 'formula', expr: 'vars.filters.q' }, fields: ['title'] });
        view.unmount();

        const on = render(<SearchOption search={{ value: FORMULA, fields: ['title'] }} fields={FIELDS} onChange={onChange} disabled={false} definition={DEFINITION} node={null} />);
        await user.click(on.getByRole('checkbox', { name: 'Search in some columns' }));
        expect(onChange).toHaveBeenLastCalledWith(undefined);
    });

    it('offers text columns only and toggles columns in and out', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const { getByLabelText, queryByLabelText } = render(
            <SearchOption search={{ value: FORMULA, fields: ['title'] }} fields={FIELDS} onChange={onChange} disabled={false} definition={DEFINITION} node={null} />,
        );
        expect(queryByLabelText('Amount')).toBeNull();
        await user.click(getByLabelText('Note'));
        expect(onChange).toHaveBeenLastCalledWith({ value: FORMULA, fields: ['title', 'note'] });
    });

    it('renders nothing for a table without a text column', () => {
        const { container } = render(<SearchOption search={undefined} fields={[FIELDS[2]]} onChange={vi.fn()} disabled={false} definition={DEFINITION} node={null} />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('readOptions.helpers', () => {
    it('shows a literal search text as the quoted expression and a formula as it is', () => {
        expect(searchExpr({ value: 'abc', fields: [] })).toBe('"abc"');
        expect(searchExpr({ value: FORMULA, fields: [] })).toBe('vars.q');
        expect(searchExpr({ fields: [] })).toBe('');
    });

    it('keeps the last column and filters the searchable ones', () => {
        const one = { value: 'x', fields: ['title'] };
        expect(withSearchFields(one, 'title', false)).toBe(one);
        expect(searchableFields(FIELDS).map((f) => f.key)).toEqual(['title', 'note']);
    });
});
