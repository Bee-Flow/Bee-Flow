import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PopupModal from './PopupModal';

function renderModal() {
    return render(
        <>
            <button type="button">Behind the overlay</button>
            <PopupModal title="Tour" onClose={vi.fn()}>
                <button type="button">Play</button>
                <a href="/more">More</a>
            </PopupModal>
        </>,
    );
}

describe('PopupModal focus', () => {
    it('moves focus onto the close button when it opens', () => {
        renderModal();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    });

    it('Tab after the last control comes back to the first, Shift+Tab goes the other way', async () => {
        renderModal();
        const close = screen.getByRole('button', { name: 'Close' });
        const more = screen.getByRole('link', { name: 'More' });
        await userEvent.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play' }));
        await userEvent.tab();
        expect(document.activeElement).toBe(more);
        await userEvent.tab();
        expect(document.activeElement).toBe(close);
        await userEvent.tab({ shift: true });
        expect(document.activeElement).toBe(more);
        expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Behind the overlay' }));
    });
});
