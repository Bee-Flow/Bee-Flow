import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import SideDrawer, { DrawerId, DrawerSection } from './SideDrawer';

/**
 * The register pages' 380px editing lade (artboards 1c/1d). What must hold:
 *   - it is a card, not a dialog: no aria-modal, no focus trap, the page
 *     beside it stays reachable;
 *   - Escape closes it, the X closes it, in overlay mode the scrim closes it;
 *   - focus goes to the header on open and BACK to the opener on close;
 *   - the visual recipe (rounded-xl, hairline, popover shadow, header row,
 *     scrolling body, footer sunk to the bottom) is the artboard's.
 */

vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), locale: 'en' });
    return { default: useTranslation, useTranslation };
});

function Host({ open: initial = true, mode = 'inline', onClose = () => {}, footer = null, children = 'body' }) {
    const [open, setOpen] = React.useState(initial);
    return (
        <div>
            <button type="button" data-testid="opener" onClick={() => setOpen(true)}>open</button>
            <SideDrawer
                open={open}
                mode={mode}
                onClose={() => { setOpen(false); onClose(); }}
                header={<span>Header</span>}
                footer={footer}
                ariaLabel="Request #2038"
                testId="d"
            >
                {children}
            </SideDrawer>
        </div>
    );
}

describe('SideDrawer', () => {
    it('renders nothing when closed and the card when open', () => {
        const { rerender } = render(<SideDrawer open={false} onClose={() => {}} testId="d">x</SideDrawer>);
        expect(screen.queryByTestId('d')).toBeNull();
        rerender(<SideDrawer open onClose={() => {}} header="H" testId="d">x</SideDrawer>);
        expect(screen.getByTestId('d')).toBeInTheDocument();
    });

    it('inline: the artboard card — rounded-xl, hairline, card bg, popover shadow, 380 wide, column flex', () => {
        render(<SideDrawer open onClose={() => {}} header="H" ariaLabel="Request" testId="d">x</SideDrawer>);
        const card = screen.getByTestId('d');
        expect(card.tagName).toBe('SECTION');
        expect(card.getAttribute('role')).toBe('complementary');
        expect(card.getAttribute('aria-label')).toBe('Request');
        expect(card.dataset.mode).toBe('inline');
        expect(card.className).toMatch(/\brounded-xl\b/);
        expect(card.className).toMatch(/border-\[var\(--border-default\)\]/);
        expect(card.className).toMatch(/bg-\[var\(--bg-card\)\]/);
        expect(card.className).toMatch(/\bflex flex-col min-h-0 overflow-hidden\b/);
        expect(card.className).toMatch(/\bh-full\b/);
        expect(card.className).not.toMatch(/\babsolute\b/);
        expect(card.style.boxShadow).toBe('var(--shadow-popover)');
        expect(card.style.width).toBe('380px');
    });

    it('is not a dialog: no aria-modal, no role=dialog, no focus trap', () => {
        render(<Host />);
        const card = screen.getByTestId('d');
        expect(card.getAttribute('aria-modal')).toBeNull();
        expect(card.getAttribute('role')).not.toBe('dialog');
        // The page beside it stays focusable.
        screen.getByTestId('opener').focus();
        expect(document.activeElement).toBe(screen.getByTestId('opener'));
    });

    it('header row: the header node, then the X with the common close label', () => {
        render(<SideDrawer open onClose={() => {}} header={<span data-testid="hdr">#2038 Erasure</span>} testId="d">x</SideDrawer>);
        const row = screen.getByTestId('d-header');
        expect(row.className).toMatch(/\bpx-3\.5 py-3 border-b\b/);
        expect(row.contains(screen.getByTestId('hdr'))).toBe(true);
        const close = screen.getByRole('button', { name: 'Close' });
        expect(row.contains(close)).toBe(true);
        expect(row.querySelector('.flex-1')).not.toBeNull();
    });

    it('body scrolls and stacks; the footer sinks to the bottom with mt-auto', () => {
        render(<SideDrawer open onClose={() => {}} header="H" footer={<button type="button">Fulfil</button>} testId="d"><p>content</p></SideDrawer>);
        const body = screen.getByText('content').parentElement;
        expect(body.className).toMatch(/\bp-3\.5\b/);
        expect(body.className).toMatch(/\bflex-1 min-h-0 overflow-y-auto flex flex-col gap-3\.5\b/);
        const footer = screen.getByTestId('d-footer');
        expect(footer.className).toMatch(/\bmt-auto\b/);
        expect(body.contains(footer)).toBe(true);
        expect(footer.contains(screen.getByRole('button', { name: 'Fulfil' }))).toBe(true);
    });

    it('renders no footer slot when no footer is given', () => {
        render(<SideDrawer open onClose={() => {}} header="H" testId="d">x</SideDrawer>);
        expect(screen.queryByTestId('d-footer')).toBeNull();
    });

    it('Escape closes while open — from the window, not only from inside the card', () => {
        const onClose = vi.fn();
        render(<Host onClose={onClose} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('d')).toBeNull();
        // Closed: Escape does nothing more.
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the X closes', () => {
        const onClose = vi.fn();
        render(<Host onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('moves focus to the header on open and back to the opener on close', () => {
        render(<Host open={false} />);
        const opener = screen.getByTestId('opener');
        opener.focus();
        expect(document.activeElement).toBe(opener);
        fireEvent.click(opener);
        const header = screen.getByTestId('d-header');
        expect(document.activeElement).toBe(header);
        expect(header.getAttribute('tabindex')).toBe('-1');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('d')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('does not fight over focus when nothing had it (body) on open', () => {
        // Mounted open with nothing focused: the header takes focus, and on
        // close there is no opener to hand it back to — the body keeps it.
        expect(document.activeElement).toBe(document.body);
        render(<Host open />);
        expect(document.activeElement).toBe(screen.getByTestId('d-header'));
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('d')).toBeNull();
        expect(document.activeElement).toBe(document.body);
    });

    it('overlay: the same card floats absolute inset-y-3 right-3 z-30 behind a scrim that closes on click', () => {
        const onClose = vi.fn();
        render(<Host mode="overlay" onClose={onClose} />);
        const card = screen.getByTestId('d');
        expect(card.dataset.mode).toBe('overlay');
        expect(card.className).toMatch(/\babsolute inset-y-3 right-3 z-30\b/);
        expect(card.style.boxShadow).toBe('var(--shadow-popover)');
        const scrim = screen.getByTestId('d-scrim');
        expect(scrim.className).toMatch(/\babsolute inset-0\b/);
        expect(scrim.style.background).toBe('rgba(0, 0, 0, 0.25)');
        expect(scrim.getAttribute('aria-hidden')).toBe('true');
        fireEvent.click(scrim);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('inline has no scrim', () => {
        render(<Host mode="inline" />);
        expect(screen.queryByTestId('d-scrim')).toBeNull();
    });

    it('modal (phone, 1h): a portalled right-side dialog, not a card pinned right-3', () => {
        render(<Host mode="modal" />);
        const body = screen.getByTestId('d');
        expect(body.dataset.mode).toBe('modal');
        // It is the shared Modal: portalled to the body, role=dialog, aria-modal.
        const dialog = document.body.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.contains(body)).toBe(true);
        // placement="right": the overlay pins the panel to the right edge and
        // the panel is full height with the left corners rounded.
        expect(dialog.parentElement.className).toMatch(/\bfixed inset-0\b/);
        expect(dialog.parentElement.className).toMatch(/\bjustify-end\b/);
        expect(dialog.className).toMatch(/\bh-full\b/);
        expect(dialog.className).toMatch(/\brounded-l-xl\b/);
        // No 380px card overhanging a 390px viewport, and no overlay scrim div.
        expect(body.style.width).toBe('');
        expect(screen.queryByTestId('d-scrim')).toBeNull();
    });

    it('modal: header, X and footer keep their slots', () => {
        const onClose = vi.fn();
        render(<Host mode="modal" onClose={onClose} footer={<button type="button">Fulfil</button>} />);
        expect(screen.getByTestId('d-header').textContent).toBe('Header');
        const footer = screen.getByTestId('d-footer');
        expect(footer.className).toMatch(/\bmt-auto\b/);
        expect(footer.contains(screen.getByRole('button', { name: 'Fulfil' }))).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    });

    it('modal: Escape closes exactly once (the Modal owns it, the window listener does not double-fire)', () => {
        const onClose = vi.fn();
        render(<Host mode="modal" onClose={onClose} />);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('d')).toBeNull();
    });

    it('honours a custom width', () => {
        render(<SideDrawer open onClose={() => {}} header="H" width={420} testId="d">x</SideDrawer>);
        expect(screen.getByTestId('d').style.width).toBe('420px');
    });
});

describe('DrawerSection / DrawerId', () => {
    it('DrawerSection: 10px uppercase tracked label, optional hint in normal case, content below', () => {
        render(
            <DrawerSection label="Justification" hint="required when excluded" testId="s">
                <textarea aria-label="why" />
            </DrawerSection>,
        );
        const section = screen.getByTestId('s');
        const label = section.firstElementChild;
        expect(label.className).toMatch(/text-\[10px\] uppercase tracking-\[\.08em\] font-semibold text-\[var\(--text-tertiary\)\]/);
        expect(label.textContent).toBe('Justification · required when excluded');
        const hint = label.querySelector('span');
        expect(hint.className).toMatch(/\bnormal-case\b/);
        expect(hint.className).toMatch(/\bfont-normal\b/);
        expect(section.contains(screen.getByLabelText('why'))).toBe(true);
    });

    it('DrawerSection without a label renders only the content', () => {
        render(<DrawerSection testId="s"><p>only</p></DrawerSection>);
        const section = screen.getByTestId('s');
        expect(section.children.length).toBe(1);
        expect(section.textContent).toBe('only');
    });

    it('DrawerId is the mono 11px secondary id', () => {
        render(<DrawerId testId="id">#2038</DrawerId>);
        const id = screen.getByTestId('id');
        expect(id.textContent).toBe('#2038');
        expect(id.className).toMatch(/\bfont-mono\b/);
        expect(id.className).toMatch(/text-\[11px\]/);
        expect(id.className).toMatch(/text-\[var\(--text-secondary\)\]/);
    });
});
