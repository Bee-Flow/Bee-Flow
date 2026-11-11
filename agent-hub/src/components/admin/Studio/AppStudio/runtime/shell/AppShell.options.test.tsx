import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppShell from '../AppShell';
import { safeLinkUrl, shellOptions } from './shellOptions';

/**
 * The shell options of definition.nav (schema 3, shellOptions.ts): style none, a hidden top
 * bar, the app's own links, a footer line and the brand. An app without them renders the
 * shell it always had (AppShell.nav.test.tsx and the compat DOM snapshots hold that).
 */

const scr = (id: string, name: string, extra = {}) => ({ id, name, icon: null, showInNav: true, sections: [], ...extra });

const BASE = {
    schemaVersion: 3,
    meta: { name: 'Desk', description: '', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', appearance: 'auto' },
    screens: [scr('scr_home01', 'Home'), scr('scr_req001', 'Requests'), scr('scr_help01', 'Help', { showInNav: false })],
};

const VIEWER = { id: 'u1', name: 'Vera Viewer', email: 'vera@example.test', isOwner: false, roleKey: 'member' };

function renderShell(nav: Record<string, unknown>, onNavigate = vi.fn()) {
    render(
        <AppShell definition={{ ...BASE, nav } as never} screenId="scr_home01" onNavigate={onNavigate} viewer={VIEWER}>
            <div>content</div>
        </AppShell>,
    );
    return onNavigate;
}

describe('the app shell options', () => {
    it('reads only well-formed links, and only http or https addresses', () => {
        expect(safeLinkUrl('javascript:alert(1)')).toBeNull();
        expect(safeLinkUrl('//example.org')).toBeNull();
        expect(safeLinkUrl('https://example.org/x')).toBe('https://example.org/x');
        const opts = shellOptions({
            ...BASE,
            nav: { items: [{ id: 'nvi_a1b2', label: 'Bad', url: 'javascript:alert(1)' }, { id: 'nvi_c3d4', label: 'Gone', screenId: 'scr_nope' }, { id: 'nvi_e5f6', label: 'Help', screenId: 'scr_help01' }] },
        });
        expect(opts.items.map((i) => i.label)).toEqual(['Help']);
        expect(shellOptions(BASE)).toEqual({ none: false, headerHidden: false, items: [], footerText: null, brand: null });
    });

    it('style none draws no navigation, only the viewer menu in a corner', () => {
        renderShell({ style: 'none', footerText: 'Facilities' });
        expect(screen.queryByRole('banner')).toBeNull();
        expect(screen.queryByRole('navigation')).toBeNull();
        expect(screen.queryByText('Desk')).toBeNull();
        expect(screen.getByRole('button', { name: 'Account: Vera Viewer' })).toBeInTheDocument();
        expect(screen.getByText('Facilities')).toBeInTheDocument();
        expect(screen.getByText('content')).toBeInTheDocument();
    });

    it('a hidden header keeps a screen menu that lists the links, at every width', async () => {
        const onNavigate = renderShell({ header: 'hidden', items: [{ id: 'nvi_help01', label: 'Get help', icon: null, screenId: 'scr_help01' }] });
        expect(screen.queryByRole('banner')).toBeNull();
        const corner = document.querySelector('[data-app-shell-corner]');
        expect(corner).not.toBeNull();
        await userEvent.click(screen.getByRole('button', { name: /Home/ }));
        await userEvent.click(await screen.findByRole('button', { name: 'Get help' }));
        expect(onNavigate).toHaveBeenCalledWith('scr_help01');
    });

    it('links sit in the top bar; an address opens in a new tab without the referrer', () => {
        renderShell({ items: [{ id: 'nvi_hand01', label: 'Handbook', icon: null, url: 'https://example.org/handbook' }], brand: { name: 'Front desk', logo: 'https://example.org/logo.png', showName: false } });
        const link = screen.getByRole('link', { name: /Handbook/ });
        expect(link).toHaveAttribute('href', 'https://example.org/handbook');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(screen.getByRole('img', { name: 'Front desk' })).toHaveAttribute('src', 'https://example.org/logo.png');
        expect(screen.queryByText('Desk')).toBeNull();
    });
});
