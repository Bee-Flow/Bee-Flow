import React from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';
import useConfirm from './useConfirm';

// The backdrop carries the stacking level: inline when set, otherwise the
// z-50 class every confirmation used to get.
const level = (dialog: HTMLElement) => Number(dialog.parentElement!.style.zIndex || 50);

/**
 * The shape of the routines list: one `useConfirm()` mounted at the shell
 * root, asked from inside a dialog that sits high above the page (the
 * automation flyout at z-1500).
 */
function Shell({ onAnswer }: { onAnswer: (ok: boolean) => void }) {
    const { confirm, confirmDialog } = useConfirm();
    const ask = async () => onAnswer(await confirm({ title: 'Delete this routine?', confirmLabel: 'Delete', destructive: true }));
    return (
        <>
            {confirmDialog}
            <Modal open onClose={() => {}} title="Automations" zIndex={1500}>
                <button type="button" onClick={ask}>Delete routine</button>
            </Modal>
        </>
    );
}

describe('useConfirm', () => {
    it('opens its confirmation on top of the dialog that asked for it, and it answers', async () => {
        const user = userEvent.setup();
        const answers: boolean[] = [];
        render(<Shell onAnswer={(ok) => answers.push(ok)} />);

        await user.click(screen.getByRole('button', { name: 'Delete routine' }));
        const flyout = screen.getByRole('dialog', { name: 'Automations' });
        const confirmation = screen.getByRole('dialog', { name: 'Delete this routine?' });
        expect(level(confirmation)).toBeGreaterThan(level(flyout));

        await user.click(within(confirmation).getByRole('button', { name: 'Delete' }));
        expect(answers).toEqual([true]);
        expect(screen.queryByRole('dialog', { name: 'Delete this routine?' })).toBeNull();
    });

    it('Escape on a "close while recording?" confirmation cancels it, and leaves the dialog behind alone', async () => {
        // CaptureModal's shape: closing the dialog asks first. One Escape used
        // to reach both dialogs, so cancelling the question asked it again.
        const closed: string[] = [];
        let asked = 0;
        function Capture() {
            const { confirm, confirmDialog } = useConfirm();
            const close = async () => {
                asked += 1;
                if (await confirm({ title: 'Close while recording?', confirmLabel: 'Keep recording' })) closed.push('capture');
            };
            return (
                <>
                    <Modal open onClose={close} title="New transcription"><p>recording…</p></Modal>
                    {confirmDialog}
                </>
            );
        }
        render(<Capture />);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(await screen.findByRole('dialog', { name: 'Close while recording?' })).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Close while recording?' })).toBeNull());
        expect(screen.getByRole('dialog', { name: 'New transcription' })).toBeInTheDocument();
        expect(asked).toBe(1);
        expect(closed).toEqual([]);
    });
});
