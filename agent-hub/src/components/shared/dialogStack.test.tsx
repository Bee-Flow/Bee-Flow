import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

/**
 * Modal as a stack of open dialogs (dialogStack.ts): the one opened last is
 * on top, and only the top one answers the keyboard.
 */

// The backdrop carries the stacking level: inline when set, otherwise the
// z-50 class.
const level = (dialog: HTMLElement) => Number(dialog.parentElement!.style.zIndex || 50);

describe('Modal stack: level', () => {
    it('puts the dialog opened last on top, whatever zIndex the one below asked for', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [second, setSecond] = useState(false);
            return (
                <>
                    <Modal open onClose={() => {}} title="History" zIndex={9999}>
                        <button type="button" onClick={() => setSecond(true)}>Ask</button>
                    </Modal>
                    <Modal open={second} onClose={() => setSecond(false)} title="Sure?">
                        <button type="button">Yes</button>
                    </Modal>
                </>
            );
        }
        render(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Ask' }));
        const history = screen.getByRole('dialog', { name: 'History' });
        const sure = screen.getByRole('dialog', { name: 'Sure?' });
        expect(level(sure)).toBeGreaterThan(level(history));
        // The one below keeps the level it asked for.
        expect(level(history)).toBe(9999);
    });

    it('keeps a nested dialog above its parent when both open in the same render', () => {
        render(
            <Modal open onClose={() => {}} title="Outer" zIndex={1500}>
                <Modal open onClose={() => {}} title="Inner"><p>inner</p></Modal>
            </Modal>,
        );
        const outer = screen.getByRole('dialog', { name: 'Outer' });
        const inner = screen.getByRole('dialog', { name: 'Inner' });
        expect(level(inner)).toBeGreaterThan(level(outer));
    });

    it('leaves the dialog below as it was once the one above closes', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [top, setTop] = useState(true);
            return (
                <>
                    <Modal open onClose={() => {}} title="Base"><p>base</p></Modal>
                    <Modal open={top} onClose={() => {}} title="Top" zIndex={10}>
                        <button type="button" onClick={() => setTop(false)}>Done</button>
                    </Modal>
                </>
            );
        }
        render(<Harness />);
        expect(level(screen.getByRole('dialog', { name: 'Top' }))).toBeGreaterThan(50);
        await user.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.getByRole('dialog', { name: 'Base' }).parentElement!.style.zIndex).toBe('');
    });
});

describe('Modal stack: Escape', () => {
    it('closes the top dialog only', () => {
        const onCloseBelow = vi.fn();
        const onCloseTop = vi.fn();
        render(
            <>
                <Modal open onClose={onCloseBelow} title="Below"><p>below</p></Modal>
                <Modal open onClose={onCloseTop} title="Top"><p>top</p></Modal>
            </>,
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCloseTop).toHaveBeenCalledTimes(1);
        expect(onCloseBelow).not.toHaveBeenCalled();
    });

    it('is held back for the dialogs below too while the top one holds it back', () => {
        const onCloseBelow = vi.fn();
        render(
            <>
                <Modal open onClose={onCloseBelow} title="Below"><p>below</p></Modal>
                <Modal open onClose={() => {}} disableEscapeClose title="Busy"><p>busy</p></Modal>
            </>,
        );
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onCloseBelow).not.toHaveBeenCalled();
    });

    it('stays away from a window listener behind the dialogs, as before', () => {
        // SideDrawer's own Escape listener sits on the window and counts on
        // this when it renders as a Modal.
        const onWindowKey = vi.fn();
        window.addEventListener('keydown', onWindowKey);
        try {
            render(<Modal open onClose={() => {}} title="X"><p>body</p></Modal>);
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(onWindowKey).not.toHaveBeenCalled();
        } finally {
            window.removeEventListener('keydown', onWindowKey);
        }
    });
});

describe('Modal stack: scroll lock', () => {
    function Two() {
        const [base, setBase] = useState(true);
        const [top, setTop] = useState(true);
        return (
            <>
                <Modal open={base} onClose={() => {}} title="Base">
                    <button type="button" onClick={() => setBase(false)}>Close base</button>
                </Modal>
                <Modal open={top} onClose={() => {}} title="Top">
                    <button type="button" onClick={() => setTop(false)}>Close top</button>
                </Modal>
            </>
        );
    }

    it('locks the page behind while any dialog is open, and gives the old value back after the last', async () => {
        const user = userEvent.setup();
        document.body.style.overflow = 'scroll';
        try {
            render(<Two />);
            expect(document.body.style.overflow).toBe('hidden');
            await user.click(screen.getByRole('button', { name: 'Close top' }));
            expect(document.body.style.overflow).toBe('hidden');
            await user.click(screen.getByRole('button', { name: 'Close base' }));
            expect(document.body.style.overflow).toBe('scroll');
        } finally {
            document.body.style.overflow = '';
        }
    });

    it('releases the lock when an open dialog unmounts', () => {
        const { unmount } = render(<Modal open onClose={() => {}} title="X"><p>body</p></Modal>);
        expect(document.body.style.overflow).toBe('hidden');
        unmount();
        expect(document.body.style.overflow).toBe('');
    });

    it('pads the body for the scrollbar the lock takes away, and only while locked', () => {
        // jsdom lays nothing out; give the page a 15px scrollbar.
        const clientWidth = vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(window.innerWidth - 15);
        try {
            const { unmount } = render(<Modal open onClose={() => {}} title="X"><p>body</p></Modal>);
            expect(document.body.style.paddingRight).toBe('15px');
            unmount();
            expect(document.body.style.paddingRight).toBe('');
        } finally {
            clientWidth.mockRestore();
        }
    });
});
