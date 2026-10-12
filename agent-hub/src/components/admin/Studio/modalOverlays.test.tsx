import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { MoveToFolderDialog } from './AutomationsStudio/FolderedAutomationList';
import QuickSwitcher from './AutomationsStudio/QuickSwitcher';

/**
 * The studio's overlays, now that they are dialogs.
 *
 * The move-to-folder dialog is the clearest case in this tree: it opens from
 * a context menu that the very same click dismisses, so the keyboard user who
 * reaches it has nowhere to go back to unless the dialog itself keeps and
 * returns focus. It did neither before.
 */
describe('admin/Studio overlays, once they are dialogs', () => {
    beforeEach(() => cleanup());

    const AUTOMATION = { id: 'r1', title: 'Nightly digest', folderId: null };
    const FOLDERS = [{ id: 'f1', name: 'Klanten', icon: '📁' }];

    it('ESC closes the move-to-folder dialog, which had no ESC at all', () => {
        const onClose = vi.fn();
        render(<MoveToFolderDialog automation={AUTOMATION} folders={FOLDERS} onPick={vi.fn()} onClose={onClose} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Tab off the last folder comes back to the first control, not to the page behind', () => {
        render(<MoveToFolderDialog automation={AUTOMATION} folders={FOLDERS} onPick={vi.fn()} onClose={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: 'Move to folder' });
        const buttons = within(dialog).getAllByRole('button');
        const last = buttons[buttons.length - 1];
        last.focus();
        fireEvent.keyDown(last, { key: 'Tab' });
        expect(document.activeElement).toBe(buttons[0]);
    });

    it('the move dialog gives focus back to the row menu that opened it', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button onClick={() => setOpen(true)}>Move to folder…</button>
                    {open && <MoveToFolderDialog automation={AUTOMATION} folders={FOLDERS} onPick={vi.fn()} onClose={() => setOpen(false)} />}
                </>
            );
        }
        render(<Harness />);
        const trigger = screen.getByRole('button', { name: 'Move to folder…' });
        await user.click(trigger);
        expect(screen.getByRole('dialog', { name: 'Move to folder' })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Move to folder' })).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('the quick switcher is a named dialog hung below the top edge', () => {
        render(<QuickSwitcher open items={[{ id: 'r1', title: 'Nightly digest', kind: 'automation' }]} onPick={vi.fn()} onClose={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: 'Jump to an automation' });
        expect(dialog.parentElement!.className).toContain('items-start');
        expect(dialog.parentElement!.style.zIndex).toBe('2000');
    });
});
