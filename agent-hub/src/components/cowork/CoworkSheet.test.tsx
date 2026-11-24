// The Cowork sheet (./CoworkSheet.tsx): a dialog from the right that Escape, the scrim and Close close, with the focus
// moved into it on open and given back to what opened it on close.
import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithClient } from '@/test/render';
import CoworkSheet from './CoworkSheet';

function Harness() {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>Open the task</button>
            <CoworkSheet open={open} label="Weekly digest" onClose={() => setOpen(false)}>
                <p>The task</p>
                <button type="button">Run now</button>
            </CoworkSheet>
        </>
    );
}

async function opened() {
    const user = userEvent.setup();
    renderWithClient(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open the task' });
    await user.click(opener);
    return { user, opener, dialog: await screen.findByRole('dialog', { name: 'Weekly digest' }) };
}

describe('CoworkSheet', () => {
    it('opens as a modal dialog named after what it shows, with the focus on Close', async () => {
        const { dialog } = await opened();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByText('The task')).toBeInTheDocument();
        expect(screen.getByTestId('cowork-sheet-close')).toHaveFocus();
    });

    it('Escape closes it and gives the focus back to what opened it', async () => {
        const { user, opener } = await opened();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(opener).toHaveFocus();
    });

    it('Close closes it, and so does the scrim; a press inside it does not', async () => {
        const { user, dialog } = await opened();
        // The scrim is the dialog's own backdrop: a press that starts on it closes, one inside the panel does not.
        await user.pointer({ keys: '[MouseLeft]', target: screen.getByText('The task') });
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        await user.pointer({ keys: '[MouseLeft]', target: dialog.parentElement as HTMLElement });
        expect(screen.queryByRole('dialog')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Open the task' }));
        await user.click(await screen.findByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('keeps Tab inside while open', async () => {
        const { user } = await opened();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Run now' })).toHaveFocus();
        await user.tab();
        expect(screen.getByTestId('cowork-sheet-close')).toHaveFocus();
    });
});
