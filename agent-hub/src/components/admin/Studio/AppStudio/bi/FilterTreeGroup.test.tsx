import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import FilterRowsEditor from './FilterRowsEditor';
import { addableGroupKinds } from './FilterTreeGroup';
import { descriptorFilters } from './filterDescriptor';
import type { FilterEntry, FilterRow } from './FilterRowsEditor.types';

/**
 * Filter trees in the filter editor: saved `{ all }` / `{ not }` groups render
 * as groups at any depth and edit in place, the add buttons offer only the
 * kinds that fit where they are, a "none of these" group stores one entry as
 * `{ not: entry }` and several as `{ not: { any: [...] } }`, and a row can
 * compare its field with another field of the same kind.
 */

const FIELDS = [
    { key: 'status', name: 'Status', type: 'text' },
    { key: 'owner', name: 'Owner', type: 'text' },
    { key: 'spent', name: 'Spent', type: 'number' },
    { key: 'budget', name: 'Budget', type: 'number' },
    { key: 'tags', name: 'Tags', type: 'multiselect' },
];

function Harness({ initial, onChange, allowGroups = true }: { initial: FilterEntry[]; onChange: (next: FilterEntry[]) => void; allowGroups?: boolean }) {
    const [filters, setFilters] = useState<FilterEntry[]>(initial);
    return <FilterRowsEditor fields={FIELDS} filters={filters} allowGroups={allowGroups} onChange={(next) => { setFilters(next); onChange(next); }} />;
}

const OPEN: FilterRow = { field: 'status', op: 'eq', value: 'open' };
const MINE: FilterRow = { field: 'owner', op: 'eq', value: 'me' };
const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

describe('filter tree groups', () => {
    it('renders saved all and none groups, nested, with their rows', () => {
        render(<Harness initial={[{ any: [{ all: [OPEN, MINE] }, { not: { field: 'status', op: 'eq', value: 'done' } }] }]} onChange={vi.fn()} />);
        expect(screen.getByText(/A row shows when ONE of these matches/)).toBeTruthy();
        expect(screen.getByText(/A row shows when ALL of these match/)).toBeTruthy();
        expect(screen.getByText(/A row shows when NONE of these matches/)).toBeTruthy();
        for (const value of ['open', 'me', 'done']) expect(screen.getByDisplayValue(value)).toBeTruthy();
    });

    it('editing a row three levels down writes back into the tree', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={[{ any: [{ all: [OPEN, { not: MINE }] }] }]} onChange={onChange} />);
        const box = screen.getByDisplayValue('me');
        await user.clear(box);
        await user.type(box, 'you');
        expect(last(onChange)).toEqual([{ any: [{ all: [OPEN, { not: { field: 'owner', op: 'eq', value: 'you' } }] }] }]);
    });

    it('offers either/or and none-of at the top, all-of and none-of inside an either/or group', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={[]} onChange={onChange} />);
        expect(screen.queryByRole('button', { name: /add an all-of group/i })).toBeNull();
        await user.click(screen.getByRole('button', { name: /add an either\/or group/i }));
        expect(screen.getAllByRole('button', { name: /add an either\/or group/i })).toHaveLength(1);
        await user.click(screen.getByRole('button', { name: /add an all-of group/i }));
        expect(last(onChange)).toEqual([{ any: [{ field: '', op: 'eq', value: '' }, { all: [{ field: '', op: 'eq', value: '' }] }] }]);
    });

    it('offers only what still fits three levels', () => {
        expect(addableGroupKinds(null, 0)).toEqual(['any', 'none']);
        expect(addableGroupKinds('any', 1)).toEqual(['all', 'none']);
        expect(addableGroupKinds('all', 2)).toEqual(['any']);
        expect(addableGroupKinds('none', 2)).toEqual(['all']);
        expect(addableGroupKinds('all', 3)).toEqual([]);
    });

    it('a none-of group stores one entry as { not: entry } and several as { not: { any } }', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={[]} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: /add a none-of group/i }));
        expect(last(onChange)).toEqual([{ not: { field: '', op: 'eq', value: '' } }]);
        const group = screen.getByText(/A row shows when NONE of these matches/).parentElement as HTMLElement;
        await user.click(within(group).getByRole('button', { name: /add filter/i }));
        expect(last(onChange)).toEqual([{ not: { any: [{ field: '', op: 'eq', value: '' }, { field: '', op: 'eq', value: '' }] } }]);
        await user.click(within(group).getAllByRole('button', { name: /^remove$/i })[0]);
        expect(last(onChange)).toEqual([{ not: { field: '', op: 'eq', value: '' } }]);
        await user.click(within(group).getAllByRole('button', { name: /^remove$/i })[0]);
        expect(last(onChange)).toEqual([]);
    });

    it('a none-of group with no level left for a second entry offers no way to add one', () => {
        render(<Harness initial={[{ any: [{ all: [OPEN, { not: MINE }] }] }]} onChange={vi.fn()} />);
        const group = screen.getByText(/A row shows when NONE of these matches/).parentElement as HTMLElement;
        expect(within(group).queryByRole('button', { name: /add filter/i })).toBeNull();
        expect(within(group).queryByRole('button', { name: /group/i })).toBeNull();
    });
});

describe('comparing with another field', () => {
    it('switches a row to { field, op, otherField } and offers only fields of the same kind', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={[{ field: 'spent', op: 'gt', value: 5 }]} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: /compare with another field/i }));
        expect(last(onChange)).toEqual([{ field: 'spent', op: 'gt', otherField: '' }]);
        const picker = screen.getByRole('combobox', { name: /field to compare with/i });
        expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Pick the other field…', 'Budget']);
        await user.selectOptions(picker, 'budget');
        expect(last(onChange)).toEqual([{ field: 'spent', op: 'gt', otherField: 'budget' }]);
        // Only the six comparisons remain as operators.
        const ops = within(screen.getByRole('combobox', { name: /filter operator/i })).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
        expect(ops).toEqual(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
        await user.click(screen.getByRole('button', { name: /compare with a value/i }));
        expect(last(onChange)).toEqual([{ field: 'spent', op: 'gt', value: '' }]);
    });

    it('is not offered for a field nothing can be compared with, nor where groups are off', () => {
        const { unmount } = render(<Harness initial={[{ field: 'tags', op: 'eq', value: 'a' }]} onChange={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /compare with another field/i })).toBeNull();
        unmount();
        render(<Harness initial={[{ field: 'spent', op: 'gt', value: 5 }]} onChange={vi.fn()} allowGroups={false} />);
        expect(screen.queryByRole('button', { name: /compare with another field/i })).toBeNull();
    });

    it('a saved comparison shows its other field and changing the first field asks for it again', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness initial={[{ field: 'spent', op: 'gt', otherField: 'budget' }]} onChange={onChange} />);
        expect((screen.getByRole('combobox', { name: /field to compare with/i }) as HTMLSelectElement).value).toBe('budget');
        await user.selectOptions(screen.getByRole('combobox', { name: /filter field/i }), 'status');
        expect(last(onChange)).toEqual([{ field: 'status', op: 'gt', otherField: '' }]);
    });
});

describe('descriptorFilters', () => {
    const leaf = (f: FilterRow) => ({ field: f.field, op: f.op, ...(typeof f.otherField === 'string' ? { otherField: f.otherField } : { value: f.value }) });
    it('keeps groups and comparisons, leaves unfinished rows and emptied groups out', () => {
        const blank: FilterRow = { field: '', op: 'eq', value: '' };
        expect(descriptorFilters([
            OPEN,
            blank,
            { any: [{ all: [OPEN, blank] }, { field: 'spent', op: 'gt', otherField: 'budget' }, { field: 'spent', op: 'gt', otherField: '' }] },
            { not: { any: [MINE, OPEN] } },
            { not: MINE, required: true },
            { all: [blank] },
            { not: blank },
        ], leaf)).toEqual([
            OPEN,
            { any: [{ all: [OPEN] }, { field: 'spent', op: 'gt', otherField: 'budget' }] },
            { not: { any: [MINE, OPEN] } },
            { not: MINE },
        ]);
    });
});
