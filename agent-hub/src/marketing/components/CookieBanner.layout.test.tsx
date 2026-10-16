import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import CookieBanner from './CookieBanner';
import { CONSENT_STORAGE_KEY } from './consent';

function dialogStyle() {
    return screen.getByRole('dialog').style;
}

describe('CookieBanner layouts', () => {
    beforeEach(() => { window.localStorage.clear(); document.body.style.paddingBottom = ''; });
    afterEach(() => cleanup());

    it('keeps the floating card when no layout is set', async () => {
        render(<CookieBanner />);
        const s = dialogStyle();
        expect(s.position).toBe('fixed');
        expect(s.maxWidth).toBe('720px');
        expect(s.bottom).toBe('1rem');
    });

    it('treats an unknown layout as the card', () => {
        render(<CookieBanner layout={'fullscreen' as never} />);
        expect(dialogStyle().maxWidth).toBe('720px');
    });

    it('draws the bar edge to edge along the bottom, without rounded corners', () => {
        render(<CookieBanner layout="bar" />);
        const s = dialogStyle();
        expect(s.left).toBe('0px');
        expect(s.right).toBe('0px');
        expect(s.bottom).toBe('0px');
        expect(s.maxWidth).toBe('none');
        expect(s.borderRadius).toBe('0px');
    });

    it('draws the corner variant as a narrow card at the bottom left', () => {
        render(<CookieBanner layout="corner" />);
        const s = dialogStyle();
        expect(s.left).toBe('1rem');
        expect(s.right).toBe('auto');
        expect(s.maxWidth).toBe('360px');
    });

    it.each(['card', 'bar', 'corner'] as const)('%s: stores nothing before a choice, and the buttons work by keyboard', async (layout) => {
        const user = userEvent.setup();
        const heard = vi.fn();
        window.addEventListener('bf-cookie-consent', heard);
        render(<CookieBanner layout={layout} />);

        expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
        expect(heard).not.toHaveBeenCalled();

        await user.tab(); // privacy link
        await user.tab();
        expect(screen.getByRole('button', { name: 'Decline' })).toHaveFocus();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Accept' })).toHaveFocus();
        await user.keyboard('{Enter}');

        expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('accepted');
        expect(heard).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).toBeNull();
        window.removeEventListener('bf-cookie-consent', heard);
    });

    it('keeps the bottom of the page clear while the banner is open, and releases it after a choice', async () => {
        const user = userEvent.setup();
        render(<CookieBanner layout="bar" />);
        expect(document.body.style.paddingBottom).not.toBe('');
        await user.click(screen.getByRole('button', { name: 'Decline' }));
        expect(document.body.style.paddingBottom).toBe('');
    });

    it('releases the space when the banner unmounts', () => {
        const { unmount } = render(<CookieBanner layout="card" />);
        expect(document.body.style.paddingBottom).not.toBe('');
        unmount();
        expect(document.body.style.paddingBottom).toBe('');
    });
});
