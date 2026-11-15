// How the dashboard mounts a tab's panel: the address segments it hands over
// and the page frame around it (AdminPage). The panels are the real ones,
// reading from a stubbed server.
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testQueryClient, withQueryClient } from '@/test/queryWrapper';
import AdminAccessDenied from './AdminAccessDenied';
import AdminPage from './AdminPage';
import AdminTabContent, { type AdminTabContentProps } from './AdminTabContent';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

class SilentEventSource {
    addEventListener() { /* no events in these tests */ }
    close() { /* nothing to close */ }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn(async (url: unknown) => {
        const address = String(url);
        if (address.includes('/api/support/threads?')) return json({ threads: [], counts: {} });
        return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', SilentEventSource);
});
afterEach(() => { vi.unstubAllGlobals(); });

const asked = () => fetchMock.mock.calls.map(([url]) => String(url));

function props(over: Partial<AdminTabContentProps>): AdminTabContentProps {
    return { activeTab: 'support', hasPermission: () => true, agentSection: '', adminPath: {}, title: 'Page', description: 'What the page is for.', ...over };
}

describe('AdminTabContent: the support inbox at its address', () => {
    // The server's ticket link is admin/support/<threadId>; a click on another
    // ticket writes admin/support/inbox/<id>. The second address must open that ticket.
    it('opens the ticket of admin/support/inbox/<id> after the server\'s link admin/support/<threadId>', async () => {
        const client = testQueryClient();
        const { rerender } = render(withQueryClient(<AdminTabContent {...props({ adminPath: { seg1: 'support', seg2: 't1', seg3: '' } })} />, client));
        await waitFor(() => expect(asked().some(u => u.endsWith('/api/support/threads/t1'))).toBe(true));
        rerender(withQueryClient(<AdminTabContent {...props({ adminPath: { seg1: 'support', seg2: 'inbox', seg3: 't2' } })} />, client));
        await waitFor(() => expect(asked().some(u => u.endsWith('/api/support/threads/t2'))).toBe(true));
    });

    it('heads the inbox and lets it fill the pane under the header', () => {
        render(withQueryClient(<AdminTabContent {...props({ adminPath: { seg1: 'support', seg2: '', seg3: '' } })} />));
        const tab = screen.getByTestId('admin-tab-support');
        expect(within(tab).getByTestId('admin-page-header')).toHaveTextContent('Page');
        expect(tab.querySelector('[data-admin-page-width]')).toHaveAttribute('data-admin-page-width', 'fill');
    });
});

describe('AdminTabContent: the frames', () => {
    it('Usage & monitoring: a wide page that scrolls in the frame, headed by the name only (the panel shows the description)', () => {
        render(withQueryClient(<AdminTabContent {...props({ activeTab: 'monitoring', adminPath: { seg1: 'monitoring', seg2: 'overview', seg3: '' } })} />));
        const tab = screen.getByTestId('admin-tab-monitoring');
        const header = within(tab).getByTestId('admin-page-header');
        expect(within(header).getByRole('heading', { level: 2, name: 'Page' })).toBeInTheDocument();
        expect(header).not.toHaveTextContent('What the page is for.');
        expect(tab.querySelector('[data-admin-page-width]')).toHaveAttribute('data-admin-page-width', 'wide');
        expect(tab).toHaveClass('overflow-auto');
    });

    it('Feature switches: the frame names the page once, the panel draws the list only', () => {
        render(withQueryClient(<AdminTabContent {...props({ activeTab: 'licenses', title: 'Feature switches', adminPath: { seg1: 'licenses', seg2: 'features', seg3: '' } })} />));
        expect(screen.getAllByRole('heading', { name: 'Feature switches' })).toHaveLength(1);
        expect(screen.getByTestId('feature-switches')).toBeInTheDocument();
    });
});

describe('AdminPage: a notice that fills its place', () => {
    it('fills the content area under the header, never the header', () => {
        render(<AdminPage title="Sign-in & SSO" width="settings"><AdminAccessDenied scope="section" inSection /></AdminPage>);
        const denied = screen.getByTestId('admin-access-denied-section');
        const content = screen.getByTestId('admin-page-content');
        // The notice is absolute inset-0: its box is the content area, which holds no header.
        expect(denied.parentElement).toBe(content);
        expect(content).toHaveClass('relative');
        expect(within(content).queryByTestId('admin-page-header')).toBeNull();
        expect(screen.getByTestId('admin-page-header')).toHaveTextContent('Sign-in & SSO');
    });
});
