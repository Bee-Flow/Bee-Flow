import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import RowDetail from './RowDetail';
import { discoverColumns } from './columns';

/**
 * `.length` of a string is the string's length at run time (path.mjs
 * stepInto), never a `length` key of the JSON the text encodes. The large
 * view reads JSON text as what it encodes, so a group read out of text must
 * not list such a key as one of its fields, and the drawer's columns must not
 * offer it as a column.
 */
afterEach(cleanup);

const ROW = { name: 'Box', meta: '{"length":120,"unit":"cm"}', size: { length: 3, width: 2 } };

const group = (label: string) => screen.getByRole('button', { name: new RegExp(label) }).closest('[data-testid="row-detail-field"]') as HTMLElement;

describe('a `length` key inside JSON text', () => {
    it('is not a field of the group the row detail reads out of the text; a record keeps its own', () => {
        render(<RowDetail row={ROW} title="Box" index={0} total={1} canPrev={false} canNext={false} onPrev={vi.fn()} onNext={vi.fn()} onClose={vi.fn()} />);
        const meta = group('Meta');
        expect(within(meta).getByText('Unit')).toBeTruthy();
        expect(within(meta).queryByText('Length')).toBeNull();
        expect(within(group('Size')).getByText('Length')).toBeTruthy();
        // What the run reads there: the text's own length, not 120.
        expect(getPath(ROW, 'meta.length')).toBe(ROW.meta.length);
    });

    it('is never a column of the drawer table, also when the field is split open', () => {
        const keys = discoverColumns([ROW, { ...ROW, name: 'Crate' }], ['meta', 'size']).map(c => c.key);
        expect(keys).toContain('size.length');
        expect(keys.some(k => k.startsWith('meta.'))).toBe(false);
    });
});
