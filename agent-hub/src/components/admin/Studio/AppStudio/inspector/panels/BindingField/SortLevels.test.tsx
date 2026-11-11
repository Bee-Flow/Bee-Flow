import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SortLevels, sortLevelsOf, sortPatchFor } from './SortLevels';
import type { BindingDraft } from '../BindingField.types';

/**
 * The sort of a table binding on up to three columns: one column stays the
 * `sort` it always was, more become `orderBy`, and a column sorts once.
 */

const FIELDS = [
    { key: 'status', name: 'Status' },
    { key: 'due', name: 'Due' },
    { key: 'title', name: 'Title' },
    { key: 'owner', name: 'Owner' },
];

function Harness({ initial, onPatch }: { initial: BindingDraft; onPatch: (patch: { sort: unknown; orderBy: unknown }) => void }) {
    const [binding, setBinding] = useState<BindingDraft>(initial);
    return <SortLevels binding={binding} fields={FIELDS} onPatch={(patch) => { setBinding({ ...binding, ...patch }); onPatch(patch); }} />;
}
const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

describe('SortLevels', () => {
    it('reads orderBy first, else the first entry of sort', () => {
        expect(sortLevelsOf({ sort: [{ field: 'a', dir: 'desc' }, { field: 'b', dir: 'asc' }] })).toEqual([{ field: 'a', dir: 'desc' }]);
        expect(sortLevelsOf({ sort: { field: 'a' } })).toEqual([{ field: 'a', dir: 'asc' }]);
        expect(sortLevelsOf({ sort: [{ field: 'a' }], orderBy: [{ field: 'b', direction: 'ASC' }, { field: 'c' }] })).toEqual([{ field: 'b', dir: 'asc' }, { field: 'c', dir: 'desc' }]);
        expect(sortLevelsOf({ sort: undefined })).toEqual([]);
    });

    it('writes one level as sort and several as orderBy', () => {
        expect(sortPatchFor([])).toEqual({ sort: undefined, orderBy: undefined });
        expect(sortPatchFor([{ field: 'a', dir: 'asc' }])).toEqual({ sort: [{ field: 'a', dir: 'asc' }], orderBy: undefined });
        expect(sortPatchFor([{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'desc' }])).toEqual({ sort: undefined, orderBy: [{ field: 'a', dir: 'asc' }, { field: 'b', dir: 'desc' }] });
    });

    it('adds a second and third level, each offering the fields not taken, and stops at three', async () => {
        const user = userEvent.setup();
        const onPatch = vi.fn();
        render(<Harness initial={{ kind: 'records', tableId: 't' }} onPatch={onPatch} />);
        expect(screen.queryByRole('button', { name: /then sort by another field/i })).toBeNull();
        await user.selectOptions(screen.getByRole('combobox', { name: 'Sort field' }), 'status');
        expect(last(onPatch)).toEqual({ sort: [{ field: 'status', dir: 'asc' }], orderBy: undefined });
        await user.click(screen.getByRole('button', { name: /then sort by another field/i }));
        expect(last(onPatch)).toEqual({ sort: undefined, orderBy: [{ field: 'status', dir: 'asc' }, { field: 'due', dir: 'asc' }] });
        const second = screen.getByRole('combobox', { name: /then sort by, level 2/i });
        expect(within(second).getAllByRole('option').map((o) => o.textContent)).toEqual(['Due', 'Title', 'Owner']);
        await user.selectOptions(screen.getByRole('combobox', { name: /direction of sort level 2/i }), 'desc');
        await user.click(screen.getByRole('button', { name: /then sort by another field/i }));
        expect(last(onPatch)).toEqual({ sort: undefined, orderBy: [{ field: 'status', dir: 'asc' }, { field: 'due', dir: 'desc' }, { field: 'title', dir: 'asc' }] });
        expect(screen.queryByRole('button', { name: /then sort by another field/i })).toBeNull();
        expect(screen.getByText(/empty value come last/i)).toBeTruthy();
    });

    it('removing levels goes back to a plain sort, and "No sort" clears everything', async () => {
        const user = userEvent.setup();
        const onPatch = vi.fn();
        render(<Harness initial={{ kind: 'records', tableId: 't', orderBy: [{ field: 'status', dir: 'asc' }, { field: 'due', dir: 'desc' }] }} onPatch={onPatch} />);
        await user.click(screen.getByRole('button', { name: /remove sort level 2/i }));
        expect(last(onPatch)).toEqual({ sort: [{ field: 'status', dir: 'asc' }], orderBy: undefined });
        await user.selectOptions(screen.getByRole('combobox', { name: 'Sort field' }), '');
        expect(last(onPatch)).toEqual({ sort: undefined, orderBy: undefined });
    });
});
