import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import SidebarFooter from './SidebarFooter';

/**
 * The account footer: the avatar row and the profile menu it opens.
 *
 * Pins three things a click alone does not show:
 *  - the menu's links carry the addresses the app routes on (/app/admin,
 *    /app/settings). A bare /settings fell through to the app home when opened
 *    in a new tab, because pageFromPath knows no such path.
 *  - the name falls back to the username before the internal id, as Settings
 *    does, so the two places never name one person differently.
 *  - the trigger is a disclosure (aria-expanded + aria-controls on the popup),
 *    not a menu button promising arrow-key menu behaviour that is not there.
 */

type FooterUser = {
    id?: string;
    username?: string;
    displayName?: string;
    isAdmin?: boolean;
    permissions?: string[];
};

const t = (key: string, fallback?: string) => fallback ?? key;

function Harness({ user, onNavigate = vi.fn() }: { user: FooterUser; onNavigate?: (page: string) => void }) {
    const profileRef = useRef<HTMLDivElement>(null);
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    return (
        <SidebarFooter
            isOpen
            isMobile={false}
            user={user}
            t={t}
            profileRef={profileRef}
            showProfileMenu={showProfileMenu}
            setShowProfileMenu={setShowProfileMenu}
            _simpleMode={false}
            currentPage="agents"
            showSettings={false}
            onNavigate={onNavigate}
            onLogout={vi.fn()}
        />
    );
}

describe('SidebarFooter', () => {
    it('links the profile menu to the /app addresses', async () => {
        render(<Harness user={{ id: 'u1', displayName: 'Jan', isAdmin: true, permissions: ['all'] }} />);
        await userEvent.click(screen.getByTestId('sidebar-profile'));
        expect(screen.getByTestId('profile-menu-admin')).toHaveAttribute('href', '/app/admin');
        expect(screen.getByTestId('profile-menu-settings')).toHaveAttribute('href', '/app/settings');
    });

    it('still navigates in-app on a plain click', async () => {
        const onNavigate = vi.fn();
        render(<Harness user={{ id: 'u1', displayName: 'Jan' }} onNavigate={onNavigate} />);
        await userEvent.click(screen.getByTestId('sidebar-profile'));
        await userEvent.click(screen.getByTestId('profile-menu-settings'));
        expect(onNavigate).toHaveBeenCalledWith('settings');
        expect(screen.queryByTestId('profile-menu')).not.toBeInTheDocument();
    });

    it('names the person by display name, then username, then id', () => {
        const { unmount } = render(<Harness user={{ id: 'u1', username: 'jan', displayName: 'Jan de Vries' }} />);
        expect(screen.getByText('Jan de Vries')).toBeInTheDocument();
        unmount();

        const second = render(<Harness user={{ id: 'u1', username: 'jan' }} />);
        expect(screen.getByText('jan')).toBeInTheDocument();
        expect(screen.queryByText('u1')).not.toBeInTheDocument();
        second.unmount();

        render(<Harness user={{ id: 'u1' }} />);
        expect(screen.getByText('u1')).toBeInTheDocument();
    });

    it('is a disclosure: aria-expanded, and aria-controls naming the open popup', async () => {
        render(<Harness user={{ id: 'u1', displayName: 'Jan' }} />);
        const trigger = screen.getByRole('button', { name: 'Open profile menu' });
        expect(trigger).not.toHaveAttribute('aria-haspopup');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).not.toHaveAttribute('aria-controls');

        await userEvent.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        const popupId = trigger.getAttribute('aria-controls');
        expect(popupId).toBeTruthy();
        expect(screen.getByTestId('profile-menu')).toHaveAttribute('id', popupId);
    });
});
