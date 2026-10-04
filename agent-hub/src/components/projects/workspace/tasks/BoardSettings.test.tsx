import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectBoard } from '../../../../api/queries/projectBoard';

const save = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, error: null as unknown }));
vi.mock('../../../../api/queries/projectBoard', async original => ({
    ...await original<typeof import('../../../../api/queries/projectBoard')>(),
    useBoardActions: () => ({ save }),
}));
import BoardSettings from './BoardSettings';

const board: ProjectBoard = {
    columns: [
        { id: 'todo', title: '', status: 'todo', wipLimit: null },
        { id: 'doing', title: 'Busy', status: 'doing', wipLimit: 3 },
        { id: 'done', title: '', status: 'done', wipLimit: null },
    ],
    assignments: {}, version: 7,
};

describe('BoardSettings', () => {
    it('edits the columns in a dialog and saves them in the new order', async () => {
        const user = userEvent.setup();
        save.mutate.mockClear();
        const onClose = vi.fn();
        render(<BoardSettings projectId="p1" board={board} onClose={onClose} />);
        const dialog = screen.getByRole('dialog', { name: /Board columns/ });
        const names = within(dialog).getAllByRole('textbox', { name: 'Column name' });
        expect(names.map(n => (n as HTMLInputElement).value)).toEqual(['To do', 'Busy', 'Done']);
        expect(within(dialog).getAllByRole('spinbutton', { name: 'Work in progress limit' })[1]).toHaveValue(3);
        expect(within(dialog).getAllByRole('button', { name: 'Move column left' })[0]).toBeDisabled();
        // The only column of a status cannot go.
        for (const remove of within(dialog).getAllByRole('button', { name: 'Remove column' })) expect(remove).toBeDisabled();

        await user.click(within(dialog).getAllByRole('button', { name: 'Move column right' })[0]);
        await user.click(within(dialog).getByRole('button', { name: 'Add column' }));
        expect(within(dialog).getAllByRole('textbox', { name: 'Column name' })[3]).toHaveFocus();
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        const [body] = save.mutate.mock.calls[0];
        expect(body.version).toBe(7);
        expect(body.columns.map((c: { title: string }) => c.title)).toEqual(['Busy', 'To do', 'Done', 'New column']);

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalled();
    });

    it('opens at the field a lane asked for, and explains the rules on demand', async () => {
        const user = userEvent.setup();
        render(<BoardSettings projectId="p1" board={board} onClose={vi.fn()} focus={{ columnId: 'done', field: 'wip' }} />);
        expect(screen.getAllByRole('spinbutton', { name: 'Work in progress limit' })[2]).toHaveFocus();
        await user.click(screen.getByRole('button', { name: 'About board columns' }));
        expect(screen.getByRole('note')).toHaveTextContent('Columns are shared with everyone.');
    });
});
