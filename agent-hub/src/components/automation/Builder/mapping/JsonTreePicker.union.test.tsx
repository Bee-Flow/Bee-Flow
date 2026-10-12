import type { ComponentType } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRelativePath } from '@shared/expr/path.mjs';
import JsonTreePickerJs from './JsonTreePicker';

/**
 * "Each item" means every item: the rows a list picker offers come from the
 * union of the list's elements, so a key only the second element has (or a
 * list that starts with null) is still pickable, and its path resolves.
 */
const JsonTreePicker = JsonTreePickerJs as unknown as ComponentType<Record<string, unknown>>;

afterEach(cleanup);

describe('JsonTreePicker over a list', () => {
    const VALUE = { items: [null, { sku: 'A1' }, { sku: 'B2', discount: { code: 'X' } }] };

    it('offers the keys of every element under "each item"', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<JsonTreePicker value={VALUE} onPick={onPick} />);
        await user.click(screen.getByText('each item'));
        await user.click(screen.getByText('discount'));
        expect(onPick).toHaveBeenLastCalledWith('items[*].discount');
        expect(getRelativePath(VALUE, 'items[*].discount')).toEqual([{ code: 'X' }]);
        await user.click(screen.getByText('sku'));
        expect(onPick).toHaveBeenLastCalledWith('items[*].sku');
    });

    it('a key with both quote kinds is pickable and resolves', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        const key = 'say "hi" & \'bye\'';
        render(<JsonTreePicker value={{ [key]: 1 }} onPick={onPick} />);
        await user.click(screen.getByText(key));
        const path = onPick.mock.calls[0][0];
        expect(getRelativePath({ [key]: 1 }, path)).toBe(1);
    });
});
