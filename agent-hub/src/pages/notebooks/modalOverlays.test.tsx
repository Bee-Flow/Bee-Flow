import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CitationOverlay from './CitationOverlay';
import SendForSigningModal from './SendForSigningModal';
import CommandPalette from './shell/CommandPalette';

vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    authFetch: vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.endsWith('/versions')
            ? { versions: [{ id: 'v1', summary: 'Manual snapshot', createdAt: '2026-09-01T10:00:00Z', contentLength: 12 }] }
            : { version: { content: 'older text' } }),
    })),
}));

/**
 * The notebook overlays, now that they are dialogs.
 *
 * The one to watch is the version history: it opens its own confirmations on
 * top of itself, and Modal listens for Escape on the document. Only the top
 * dialog of the stack may answer it, or one Escape on "Delete version?" would
 * close the confirmation AND the whole history behind it.
 */
describe('notebook overlays, once they are dialogs', () => {
    beforeEach(() => cleanup());

    const SOURCE = { title: 'Q3 report', content: 'Revenue grew.', index: 1 };

    it('the citation is a named dialog that Escape closes', () => {
        const onClose = vi.fn();
        render(<CitationOverlay source={SOURCE} onClose={onClose} />);
        expect(screen.getByRole('dialog', { name: 'Q3 report' })).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closing the citation gives focus back to the chip that opened it', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button onClick={() => setOpen(true)}>[1]</button>
                    <CitationOverlay source={open ? SOURCE : null} onClose={() => setOpen(false)} />
                </>
            );
        }
        render(<Harness />);
        const chip = screen.getByRole('button', { name: '[1]' });
        await user.click(chip);
        expect(screen.getByRole('dialog', { name: 'Q3 report' })).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Q3 report' })).toBeNull();
        expect(document.activeElement).toBe(chip);
    });

    it('send-for-signing keeps ignoring Escape while it is sending', () => {
        const onClose = vi.fn();
        const props = { open: true, onClose, onSend: vi.fn(), notebookTitle: 'Contract', error: null, onClearError: vi.fn() };
        const { rerender } = render(<SendForSigningModal {...props} sending />);
        expect(screen.getByRole('dialog', { name: 'Send for signing' })).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();

        rerender(<SendForSigningModal {...props} sending={false} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the command palette hangs from the top, above the editor chrome', () => {
        // `commands = []` in the JS signature infers as never[]; say what it takes.
        const Palette = CommandPalette as unknown as React.ComponentType<{
            open: boolean;
            onClose: () => void;
            commands: Array<{ id: string; label: string; run: () => void }>;
        }>;
        const onClose = vi.fn();
        render(<Palette open onClose={onClose} commands={[{ id: 'bold', label: 'Bold', run: vi.fn() }]} />);
        const dialog = screen.getByRole('dialog', { name: 'Type a command…' });
        expect(dialog.parentElement!.className).toContain('items-start');
        expect(dialog.parentElement!.style.zIndex).toBe('10000');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
