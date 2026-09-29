import React, { useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

describe('Modal', () => {
    it('renders nothing when closed', () => {
        render(
            <Modal open={false} onClose={() => {}} title="X">
                <p>body</p>
            </Modal>,
        );
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('renders into a portal and labels itself via the title', () => {
        render(
            <Modal open onClose={() => {}} title="Edit Plan">
                <p>body</p>
            </Modal>,
        );
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-labelledby');
        expect(screen.getByText('Edit Plan')).toBeInTheDocument();
        expect(screen.getByText('body')).toBeInTheDocument();
    });

    it('closes on ESC', () => {
        const onClose = vi.fn();
        render(<Modal open onClose={onClose} title="X"><p>body</p></Modal>);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close on ESC when disableEscapeClose is set', () => {
        const onClose = vi.fn();
        render(<Modal open onClose={onClose} disableEscapeClose title="X"><p>body</p></Modal>);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('closes when the backdrop is clicked', async () => {
        const onClose = vi.fn();
        render(<Modal open onClose={onClose} title="X"><button>inside</button></Modal>);
        const dialog = screen.getByRole('dialog');
        const backdrop = dialog.parentElement!;
        // mousedown on the backdrop element itself, not the dialog.
        fireEvent.mouseDown(backdrop, { target: backdrop, bubbles: true });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close when clicking inside the panel', async () => {
        const onClose = vi.fn();
        render(<Modal open onClose={onClose} title="X"><button>inside</button></Modal>);
        await userEvent.click(screen.getByRole('button', { name: 'inside' }));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('placement defaults to the centered dialog — identity for every existing caller', () => {
        render(<Modal open onClose={() => {}} title="X"><p>body</p></Modal>);
        const dialog = screen.getByRole('dialog');
        expect(dialog.parentElement!.className).toContain('items-center justify-center');
        expect(dialog.className).toContain('rounded-xl');
        expect(dialog.className).toContain('max-h-[90vh]');
        expect(dialog.className).not.toContain('modal-slide-in');
    });

    it("placement 'left'/'right' render full-height edge panels with a slide-in class", () => {
        for (const [placement, justify, slide] of [
            ['left', 'justify-start', 'modal-slide-in-left'],
            ['right', 'justify-end', 'modal-slide-in-right'],
        ] as const) {
            const { unmount } = render(
                <Modal open onClose={() => {}} title="X" placement={placement}><p>body</p></Modal>,
            );
            const dialog = screen.getByRole('dialog');
            expect(dialog.parentElement!.className).toContain(justify);
            expect(dialog.className).toContain('h-full');
            expect(dialog.className).toContain(slide);
            expect(dialog.className).not.toContain('rounded-xl');
            unmount();
        }
    });

    it("placement 'bottom' renders a sheet pinned to the bottom edge", () => {
        render(<Modal open onClose={() => {}} title="X" placement="bottom"><p>body</p></Modal>);
        const dialog = screen.getByRole('dialog');
        expect(dialog.parentElement!.className).toContain('flex-col justify-end');
        expect(dialog.className).toContain('rounded-t-2xl');
        expect(dialog.className).toContain('modal-slide-in-up');
    });

    it('renders header actions and a footer slot when provided', () => {
        render(
            <Modal
                open
                onClose={() => {}}
                title="With slots"
                headerActions={<button>Close</button>}
                footer={<button>Save</button>}
            >
                <p>body</p>
            </Modal>,
        );
        expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    });

    it("placement 'top' hangs the panel below the top edge, where a palette belongs", () => {
        render(<Modal open onClose={() => {}} title="X" placement="top"><p>body</p></Modal>);
        const dialog = screen.getByRole('dialog');
        expect(dialog.parentElement!.className).toContain('items-start justify-center');
        expect(dialog.parentElement!.className).toContain('pt-[15vh]');
        expect(dialog.className).toContain('rounded-xl');
    });

    it("variant 'bare' drops the surface but keeps the dialog", () => {
        const onClose = vi.fn();
        render(
            <Modal open onClose={onClose} variant="bare" label="Photo" size="full">
                <img alt="a photo" src="x.png" />
            </Modal>,
        );
        const dialog = screen.getByRole('dialog');
        expect(dialog.className).not.toContain('bg-[var(--bg-secondary)]');
        expect(dialog.className).not.toContain('shadow-2xl');
        // The point of routing a lightbox through Modal: it is still a named
        // dialog and ESC still gets you out of it.
        expect(dialog).toHaveAttribute('aria-label', 'Photo');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('zIndex is an inline style, so it wins over the default z-50 class', () => {
        render(<Modal open onClose={() => {}} title="X" zIndex={1200}><p>body</p></Modal>);
        const backdrop = screen.getByRole('dialog').parentElement!;
        expect(backdrop.style.zIndex).toBe('1200');
    });

    it('leaves zIndex unset when the caller does not ask for one', () => {
        render(<Modal open onClose={() => {}} title="X"><p>body</p></Modal>);
        expect(screen.getByRole('dialog').parentElement!.style.zIndex).toBe('');
    });

    it('forwards data-testid to the panel', () => {
        render(<Modal open onClose={() => {}} title="X" data-testid="thing-dialog"><p>body</p></Modal>);
        expect(screen.getByTestId('thing-dialog')).toHaveAttribute('role', 'dialog');
    });

    it("role 'alertdialog' survives the move off a hand-rolled overlay", () => {
        render(<Modal open onClose={() => {}} role="alertdialog" title="Delete?"><p>body</p></Modal>);
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it("size 'auto' leaves the width to the caller, instead of stacking two max-w utilities", () => {
        render(<Modal open onClose={() => {}} title="X" size="auto" className="max-w-3xl"><p>body</p></Modal>);
        const dialog = screen.getByRole('dialog');
        expect(dialog.className).toContain('max-w-3xl');
        expect(dialog.className).not.toContain('max-w-md');
    });

    it('prefers a visible title over the label prop for the accessible name', () => {
        render(<Modal open onClose={() => {}} title="Visible" label="Fallback"><p>body</p></Modal>);
        const dialog = screen.getByRole('dialog');
        expect(dialog).not.toHaveAttribute('aria-label');
        expect(dialog).toHaveAttribute('aria-labelledby');
    });
});

describe('Modal focus', () => {
    // A field inside that takes the focus itself, as it mounts. React moves
    // the focus during the commit, before any effect of the Modal runs.
    function Rename({ mountWhenOpen = false }: { mountWhenOpen?: boolean }) {
        const [open, setOpen] = useState(false);
        const dialog = (
            <Modal open={open} onClose={() => setOpen(false)} title="Rename">
                <input aria-label="Name" autoFocus />
            </Modal>
        );
        return (
            <>
                <button type="button" onClick={() => setOpen(true)}>Rename</button>
                {mountWhenOpen ? open && dialog : dialog}
            </>
        );
    }

    it('gives the focus back to the opener when a field inside took it with autoFocus', async () => {
        const user = userEvent.setup();
        render(<Rename />);
        const opener = screen.getByRole('button', { name: 'Rename' });
        await user.click(opener);
        expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(opener).toHaveFocus();
    });

    it('does the same for a dialog that mounts already open', async () => {
        const user = userEvent.setup();
        render(<Rename mountWhenOpen />);
        const opener = screen.getByRole('button', { name: 'Rename' });
        await user.click(opener);
        expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(opener).toHaveFocus();
    });
});

describe('Modal initial focus', () => {
    const close = <button type="button">Close</button>;

    it('focuses the first control when nothing inside asks for the focus', () => {
        render(<Modal open onClose={() => {}} title="X" headerActions={close}><input aria-label="Name" /></Modal>);
        expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    it('focuses the element named by initialFocus instead', () => {
        function ModelPicker() {
            const searchRef = useRef<HTMLInputElement>(null);
            return (
                <Modal open onClose={() => {}} title="Pick a model" headerActions={close} initialFocus={searchRef}>
                    <input ref={searchRef} aria-label="Search" />
                </Modal>
            );
        }
        render(<ModelPicker />);
        expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus();
    });

    it('leaves the focus on a later field that took it with autoFocus', () => {
        render(
            <Modal open onClose={() => {}} title="New skill" headerActions={close}>
                <button type="button">Pick an icon</button>
                <input aria-label="Name" autoFocus />
            </Modal>,
        );
        expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    });
});
