import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DeleteToTrashDialog from './DeleteToTrashDialog';

describe('DeleteToTrashDialog', () => {
    afterEach(cleanup);

    it('says the automation goes to the trash for 30 days with its runs', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<DeleteToTrashDialog automation={{ title: 'Invoices' }} onConfirm={onConfirm} onCancel={vi.fn()} />);
        expect(screen.getByText('Delete "Invoices"?')).toBeTruthy();
        expect(screen.getByText(/Moves to the trash for 30 days; runs are kept\./)).toBeTruthy();
        expect(screen.queryByText(/cannot be undone/i)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Move to trash' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('renders nothing without an automation', () => {
        const { container } = render(<DeleteToTrashDialog automation={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
        expect(container.textContent).toBe('');
    });
});
