import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ModalShell from './product-website/dialogs/ModalShell';
import SearchableModelSelect from './shared/SearchableModelSelect';
import { ConfirmModal } from './subscriptions/ui/Modal';

/**
 * Admin overlays, now that they are dialogs.
 *
 * ModalShell and the subscriptions `Modal` are both local dialog SHELLS with
 * many callers each, so what is pinned here is the contract their callers
 * lean on: Escape fires onClose once (their own listeners are gone, Modal's is
 * the only one), a caller that focuses a later field from its own effect still
 * gets that focus, and a busy confirmation cannot be dismissed.
 */
describe('admin overlays, once they are dialogs', () => {
    beforeEach(() => cleanup());

    it('ModalShell: Escape closes once, and a caller that focuses its search field keeps that focus', () => {
        const onClose = vi.fn();
        // The AddBlockDialog shape: a close button BEFORE the field, and the
        // field focused from the caller's own effect.
        function AddBlockLike() {
            const searchRef = useRef<HTMLInputElement>(null);
            useEffect(() => { searchRef.current?.focus(); }, []);
            return (
                <ModalShell onClose={onClose} labelledBy="add-block-title" width="lg">
                    <span id="add-block-title">Add block</span>
                    <button type="button">Close</button>
                    <input ref={searchRef} aria-label="Search blocks" />
                </ModalShell>
            );
        }
        render(<AddBlockLike />);
        expect(screen.getByRole('dialog', { name: 'Add block' })).toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search blocks' }));

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a busy subscriptions confirmation ignores Escape and the backdrop; an idle one closes on Escape', () => {
        const onClose = vi.fn();
        const props = { open: true, onClose, onConfirm: vi.fn(), title: 'Delete plan?', message: 'This cannot be undone.' };
        const { rerender } = render(<ConfirmModal {...props} busy />);
        const dialog = screen.getByRole('dialog', { name: 'Delete plan?' });

        fireEvent.keyDown(document, { key: 'Escape' });
        fireEvent.mouseDown(dialog.parentElement!);
        expect(onClose).not.toHaveBeenCalled();

        rerender(<ConfirmModal {...props} busy={false} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the model picker is a named dialog that gives focus back to its trigger', async () => {
        const user = userEvent.setup();
        render(
            <SearchableModelSelect
                value=""
                label="Pick a model"
                groups={{ Anthropic: [{ id: 'claude-x', providerId: 'p1', name: 'Claude X' }] }}
                onChange={vi.fn()}
                onToggleHidden={undefined}
            />,
        );
        const trigger = screen.getByRole('button', { name: /Pick a model/ });
        await user.click(trigger);
        expect(screen.getByRole('dialog', { name: 'Select Model' })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Select Model' })).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });
});
