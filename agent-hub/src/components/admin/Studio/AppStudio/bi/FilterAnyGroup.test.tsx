import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import FilterRowsEditor from './FilterRowsEditor';
import type { FilterEntry } from './FilterRowsEditor.types';

/**
 * Either/or groups in the filter editor: a saved `{ any: [...] }` entry renders
 * as a group (never as a blank row that the next edit would clobber), its
 * clauses edit in place, the last clause removed removes the group, and the
 * "Add an either/or group" button only shows where groups are allowed.
 */

const FIELDS = [
    { key: 'status', name: 'Status', type: 'text' },
    { key: 'priority', name: 'Priority', type: 'text' },
];

function Harness({ initial, onChange, allowGroups = true }: { initial: FilterEntry[]; onChange: (next: FilterEntry[]) => void; allowGroups?: boolean }) {
    const [filters, setFilters] = useState<FilterEntry[]>(initial);
    return <FilterRowsEditor fields={FIELDS} filters={filters} allowGroups={allowGroups} onChange={(next) => { setFilters(next); onChange(next); }} />;
}

const GROUP: FilterEntry = { any: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'priority', op: 'eq', value: 'high' }] };

describe('FilterAnyGroup', () => {
    it('renders a saved group with its clauses', () => {
        render(<Harness initial={[GROUP]} onChange={vi.fn()} />);
        expect(screen.getByText(/A row shows when ONE of these matches/)).toBeTruthy();
        expect(screen.getByDisplayValue('open')).toBeTruthy();
        expect(screen.getByDisplayValue('high')).toBeTruthy();
    });

    it('editing a clause writes back into the group', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={[GROUP]} onChange={onChange} />);
        const box = screen.getByDisplayValue('high');
        await user.clear(box);
        await user.type(box, 'low');
        expect(onChange.mock.calls.at(-1)?.[0]).toEqual([{ any: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'priority', op: 'eq', value: 'low' }] }]);
    });

    it('adds a group with the button, and removing its last clause removes the group', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={[]} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: /add an either\/or group/i }));
        expect(onChange.mock.calls.at(-1)?.[0]).toEqual([{ any: [{ field: '', op: 'eq', value: '' }] }]);
        const removes = screen.getAllByRole('button', { name: /remove/i });
        await user.click(removes[removes.length - 1]);
        expect(onChange.mock.calls.at(-1)?.[0]).toEqual([]);
    });

    it('offers no group button where groups are not allowed', () => {
        render(<Harness initial={[]} onChange={vi.fn()} allowGroups={false} />);
        expect(screen.queryByRole('button', { name: /add an either\/or group/i })).toBeNull();
    });
});
