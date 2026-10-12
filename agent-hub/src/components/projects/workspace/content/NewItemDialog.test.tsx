import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import NewItemDialog from './NewItemDialog';

const props = (over = {}) => ({
    open: true, onClose: vi.fn(), title: 'New document', nameLabel: 'Name', submitLabel: 'Create', busy: false, error: null, onSubmit: vi.fn(), ...over,
});

describe('NewItemDialog', () => {
    it('cancels when nothing is being made', async () => {
        const p = props();
        render(<NewItemDialog {...p} />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
        expect(p.onClose).toHaveBeenCalled();
    });

    it('cannot be cancelled while the item is being made, since it opens as soon as it exists', async () => {
        const p = props({ busy: true });
        render(<NewItemDialog {...p} />);
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        await userEvent.setup().keyboard('{Escape}');
        expect(p.onClose).not.toHaveBeenCalled();
    });
});
