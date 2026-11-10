import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SortLimitFields from './SortLimitFields';

describe('SortLimitFields', () => {
    it('sorts by an output column, highest first by default, and can switch direction', async () => {
        const user = userEvent.setup();
        const onSort = vi.fn();
        const { getByLabelText, rerender } = render(
            <SortLimitFields columns={['region', 'total']} sort={null} limit={null} onSort={onSort} onLimit={vi.fn()} />,
        );
        await user.selectOptions(getByLabelText('Sort by'), 'total');
        expect(onSort).toHaveBeenLastCalledWith({ field: 'total', dir: 'desc' });
        rerender(<SortLimitFields columns={['region', 'total']} sort={{ field: 'total', dir: 'desc' }} limit={null} onSort={onSort} onLimit={vi.fn()} />);
        await user.selectOptions(getByLabelText('Sort direction'), 'asc');
        expect(onSort).toHaveBeenLastCalledWith({ field: 'total', dir: 'asc' });
        await user.selectOptions(getByLabelText('Sort by'), '');
        expect(onSort).toHaveBeenLastCalledWith(null);
    });

    it('a sort on a column the answer lost shows as no sort', () => {
        const { getByLabelText } = render(
            <SortLimitFields columns={['region']} sort={{ field: 'gone', dir: 'asc' }} limit={null} onSort={vi.fn()} onLimit={vi.fn()} />,
        );
        expect((getByLabelText('Sort by') as HTMLSelectElement).value).toBe('');
    });

    it('the limit is a positive whole number or nothing', async () => {
        const user = userEvent.setup();
        const onLimit = vi.fn();
        const { getByLabelText } = render(
            <SortLimitFields columns={[]} sort={null} limit={null} onSort={vi.fn()} onLimit={onLimit} />,
        );
        await user.type(getByLabelText('Show at most'), '7');
        expect(onLimit).toHaveBeenLastCalledWith(7);
        const withLimit = render(
            <SortLimitFields columns={[]} sort={null} limit={7} onSort={vi.fn()} onLimit={onLimit} />,
        );
        await user.clear(withLimit.getAllByLabelText('Show at most')[1]);
        expect(onLimit).toHaveBeenLastCalledWith(null);
    });
});
