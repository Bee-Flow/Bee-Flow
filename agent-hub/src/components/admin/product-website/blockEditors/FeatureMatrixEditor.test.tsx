/**
 * Feature matrix editor (issue #529): add / remove / reorder columns, groups
 * and rows, keep every row's cells in step with the columns, one highlight.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import { FeatureMatrixEditor } from './FeatureMatrixEditor';

const cell = (id: string, kind = 'excluded', text = '') => ({ id, kind, text });
const data = () => ({
    columns: [{ id: 'a', label: 'Free', highlight: false }, { id: 'b', label: 'Pro', highlight: true }],
    groups: [{
        id: 'g1', title: 'Core',
        rows: [{ id: 'r1', label: 'Agents', cells: [cell('a', 'included'), cell('b', 'text', 'Many')] }],
    }],
});

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0];

describe('FeatureMatrixEditor columns', () => {
    it('adds a column with a fresh id and gives every row a "not included" cell for it', async () => {
        const onChange = vi.fn();
        render(<FeatureMatrixEditor data={data()} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: /Add column/ }));
        const next = last(onChange);
        expect(next.columns).toHaveLength(3);
        const added = next.columns[2];
        expect(added.id).toMatch(/^col-/);
        expect(added.highlight).toBe(false);
        expect(next.groups[0].rows[0].cells.map((c: { id: string }) => c.id)).toEqual(['a', 'b', added.id]);
        expect(next.groups[0].rows[0].cells[2]).toMatchObject({ kind: 'excluded' });
        expect(next.groups[0].rows[0].cells[0]).toMatchObject({ kind: 'included' });
    });

    it('removes a column together with its cells', async () => {
        const onChange = vi.fn();
        render(<FeatureMatrixEditor data={data()} onChange={onChange} />);
        const first = screen.getByText('Columns (licences)').parentElement!;
        await userEvent.click(within(first).getAllByRole('button', { name: 'Remove' })[0]);
        const next = last(onChange);
        expect(next.columns.map((c: { id: string }) => c.id)).toEqual(['b']);
        expect(next.groups[0].rows[0].cells.map((c: { id: string }) => c.id)).toEqual(['b']);
    });

    it('stops offering "Add column" at six columns', () => {
        const six = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, label: `P${i}` }));
        render(<FeatureMatrixEditor data={{ columns: six, groups: [] }} onChange={() => {}} />);
        expect(screen.queryByRole('button', { name: /Add column/ })).toBeNull();
    });

    it('asks for a second column while there is only one', () => {
        render(<FeatureMatrixEditor data={{ columns: [{ id: 'a', label: 'Free' }], groups: [] }} onChange={() => {}} />);
        expect(screen.getByText(/at least two columns/)).toBeInTheDocument();
    });

    it('highlights at most one column', async () => {
        const onChange = vi.fn();
        render(<FeatureMatrixEditor data={data()} onChange={onChange} />);
        // switch the highlight of the first column (Free) on: the track is the label's second span
        const columnsList = screen.getByText('Columns (licences)').parentElement!;
        const track = within(columnsList).getAllByText('Highlight this column')[0].parentElement!.children[1];
        await userEvent.click(track);
        expect(last(onChange).columns.map((c: { highlight: boolean }) => c.highlight)).toEqual([true, false]);
    });
});

describe('FeatureMatrixEditor groups and rows', () => {
    it('adds a group with an id and one blank row covering every column', async () => {
        const onChange = vi.fn();
        render(<FeatureMatrixEditor data={data()} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: /Add group/ }));
        const groups = last(onChange).groups;
        expect(groups).toHaveLength(2);
        expect(groups[1].id).toMatch(/^grp-/);
        expect(groups[1].rows[0].id).toMatch(/^row-/);
        expect(groups[1].rows[0].cells.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
    });

    it('adds a row with a cell per column inside a group', async () => {
        const onChange = vi.fn();
        render(<FeatureMatrixEditor data={data()} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: /Add row/ }));
        const rows = last(onChange).groups[0].rows;
        expect(rows).toHaveLength(2);
        expect(rows[1].id).toMatch(/^row-/);
        expect(rows[1].cells.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
    });

    it('removes a row and a group', async () => {
        const onChange = vi.fn();
        const { unmount } = render(<FeatureMatrixEditor data={data()} onChange={onChange} />);
        const rowsList = screen.getByText('Rows').parentElement!;
        await userEvent.click(within(rowsList).getByRole('button', { name: 'Remove' }));
        expect(last(onChange).groups[0].rows).toEqual([]);
        unmount();

        const onChange2 = vi.fn();
        render(<FeatureMatrixEditor data={data()} onChange={onChange2} />);
        const groupsList = screen.getByText('Groups (categories)').parentElement!;
        // the group's own Remove is the first one in its list
        await userEvent.click(within(groupsList).getAllByRole('button', { name: 'Remove' })[0]);
        expect(last(onChange2).groups).toEqual([]);
    });

    it('edits a cell: kind and short text land on the cell of that column', async () => {
        const onChange = vi.fn();
        render(<FeatureMatrixEditor data={data()} onChange={onChange} />);
        // the "Pro" cell is a text cell: its text field shows "Many"
        const text = screen.getByDisplayValue('Many');
        await userEvent.type(text, '!');
        const cells = last(onChange).groups[0].rows[0].cells;
        expect(cells[1]).toEqual({ id: 'b', kind: 'text', text: 'Many!' });
        expect(cells[0]).toEqual({ id: 'a', kind: 'included', text: '' });

        // switch the Free cell to "Short text"
        const select = screen.getByText('Free', { selector: 'label' }).parentElement!.querySelector('select')!;
        await userEvent.selectOptions(select, 'text');
        expect(last(onChange).groups[0].rows[0].cells[0]).toMatchObject({ id: 'a', kind: 'text' });
    });
});
