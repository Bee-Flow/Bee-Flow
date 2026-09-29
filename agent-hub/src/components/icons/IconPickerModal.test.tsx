import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import IconPickerModal from './IconPickerModal';

/**
 * The icon picker, now that it goes through the shared Modal.
 *
 * The emoji tab's search box used to have the focus the moment the picker
 * opened (emoji-picker-react autofocuses it). Modal leaves the focus where an
 * autoFocus field put it, instead of moving it to the first control (the
 * close button). And the backdrop, which never closed it, still does not.
 */
describe('IconPickerModal', () => {
    beforeEach(() => cleanup());

    const props = {
        isOpen: true,
        iconKey: 'rocket',
        iconLabel: 'Rocket',
        defaultEmoji: '🚀',
        currentCustom: null,
        onApply: vi.fn(),
        nanoBananaSettings: null,
    };

    it('opens as a named dialog with the emoji search focused', () => {
        render(<IconPickerModal {...props} onClose={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: /Change emoji/ });
        expect(dialog).toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Type to search for an emoji' }));
    });

    it('closes on Escape but not on a press on the backdrop', () => {
        const onClose = vi.fn();
        render(<IconPickerModal {...props} onClose={onClose} />);
        const dialog = screen.getByRole('dialog', { name: /Change emoji/ });

        fireEvent.mouseDown(dialog.parentElement!);
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
