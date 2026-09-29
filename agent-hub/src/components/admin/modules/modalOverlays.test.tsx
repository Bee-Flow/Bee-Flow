import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key), locale: 'en' }),
}));

import MediaGallery from './MediaGallery';
import RemoveModuleDialog from './RemoveModuleDialog';

/**
 * What the seven hand-rolled overlays in this map did NOT do.
 *
 * Every one of them was a `fixed inset-0` div with a click-away handler:
 * ESC did nothing, Tab walked straight out of the dialog into the page
 * behind it, and closing left focus on <body> — which for a keyboard or
 * screen-reader user means the dialog is a one-way door. Routing them
 * through the shared Modal is what these three assertions are about; the
 * copy and the wiring are covered by each component's own test.
 */
describe('admin/modules overlays, once they are dialogs', () => {
    beforeEach(() => cleanup());

    it('ESC closes the remove confirmation', () => {
        const onCancel = vi.fn();
        render(<RemoveModuleDialog module={{ id: 'a', name: 'A' }} busy={false} onCancel={onCancel} onConfirm={vi.fn()} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('opening it moves focus inside, and Tab off the last control comes back to the first', () => {
        render(<RemoveModuleDialog module={{ id: 'a', name: 'A' }} busy={false} onCancel={vi.fn()} onConfirm={vi.fn()} />);
        const dialog = screen.getByRole('dialog');
        const buttons = within(dialog).getAllByRole('button');
        expect(dialog).toContainElement(document.activeElement as HTMLElement);

        const last = buttons[buttons.length - 1];
        last.focus();
        fireEvent.keyDown(last, { key: 'Tab' });
        expect(document.activeElement).toBe(buttons[0]);

        fireEvent.keyDown(buttons[0], { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);
    });

    it('the screenshot lightbox hands focus back to the thumbnail that opened it', async () => {
        const user = userEvent.setup();
        render(<MediaGallery moduleId="m1" media={[{ media_id: 'shot-1', content_type: 'image/png' }]} />);

        const thumbnail = within(screen.getByTestId('media-gallery')).getByRole('button');
        await user.click(thumbnail);
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(thumbnail);
    });

    it('a dialog that is not the last thing opened still restores the focus it took', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button onClick={() => setOpen(true)}>open</button>
                    {open && (
                        <RemoveModuleDialog module={{ id: 'a', name: 'A' }} busy={false} onCancel={() => setOpen(false)} onConfirm={vi.fn()} />
                    )}
                </>
            );
        }
        render(<Harness />);
        const trigger = screen.getByRole('button', { name: 'open' });
        await user.click(trigger);
        expect(document.activeElement).not.toBe(trigger);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });
});
