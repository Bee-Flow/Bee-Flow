import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import AgentConflictModal from './AgentWizard/AgentConflictModal';
import EnableEmbedConfirmModal from './AgentWizard/builderSplit/EnableEmbedConfirmModal';

const t = (_key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _key);

/**
 * The agent editor's dialogs, now that they are dialogs.
 *
 * Every overlay in this tree hand-rolled its own ESC listener on `document`
 * and nothing else: Tab left the dialog on the first press, and closing
 * dropped focus on <body>, which puts a keyboard user back at the top of a
 * 1,500-line editor. The conflict dialog is the sharpest case — it appears
 * *because* a save failed, so it is exactly the moment focus must not
 * wander.
 */
describe('agents overlays, once they are dialogs', () => {
    beforeEach(() => cleanup());

    it('the save-conflict dialog is an alertdialog and ESC dismisses it', () => {
        const onDismiss = vi.fn();
        render(<AgentConflictModal t={t} busy={false} onLoadLatest={vi.fn()} onOverwrite={vi.fn()} onDismiss={onDismiss} />);
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('a save in flight makes the conflict dialog refuse both ways out', () => {
        const onDismiss = vi.fn();
        render(<AgentConflictModal t={t} busy onLoadLatest={vi.fn()} onOverwrite={vi.fn()} onDismiss={onDismiss} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        const backdrop = screen.getByRole('alertdialog').parentElement!;
        fireEvent.mouseDown(backdrop, { target: backdrop });
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('Tab cycles inside the embed confirmation instead of walking out of it', () => {
        render(<EnableEmbedConfirmModal t={t} agent={{ id: 'a1' }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
        const dialog = screen.getByRole('alertdialog');
        const buttons = within(dialog).getAllByRole('button');
        expect(buttons.length).toBeGreaterThan(1);

        buttons[buttons.length - 1].focus();
        fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Tab' });
        expect(document.activeElement).toBe(buttons[0]);
    });

    it('closing the embed confirmation returns focus to the toggle that opened it', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button onClick={() => setOpen(true)}>make public</button>
                    {open && <EnableEmbedConfirmModal t={t} agent={{ id: 'a1' }} onConfirm={vi.fn()} onCancel={() => setOpen(false)} />}
                </>
            );
        }
        render(<Harness />);
        const trigger = screen.getByRole('button', { name: 'make public' });
        await user.click(trigger);
        expect(screen.getByRole('alertdialog')).toContainElement(document.activeElement as HTMLElement);

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });
});
