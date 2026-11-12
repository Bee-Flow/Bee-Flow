import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LinkNextcloudAccount, { readLinkTicket } from './LinkNextcloudAccount';

const b64url = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TICKET = `${b64url({ p: 'nc_link', u: 'u1', o: 'org1', n: 'ann', h: 'cloud.example.org' })}.sig`;
const fetchMock = vi.fn();

function answer(status: number, body: object) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
}

describe('LinkNextcloudAccount', () => {
    afterEach(() => { window.history.replaceState({}, '', '/'); vi.unstubAllGlobals(); fetchMock.mockReset(); });

    it('reads the Nextcloud account and host from the ticket in the address', () => {
        expect(readLinkTicket(`#nc_link=${encodeURIComponent(TICKET)}`)).toEqual({ ticket: TICKET, uid: 'ann', host: 'cloud.example.org' });
        expect(readLinkTicket('#other=1')).toBeNull();
        expect(readLinkTicket('#nc_link=not-a-ticket')).toBeNull();
    });

    it('renders nothing without a ticket', () => {
        const { container } = render(<LinkNextcloudAccount />);
        expect(container).toBeEmptyDOMElement();
    });

    it('names the account, links on confirmation and clears the ticket from the address', async () => {
        window.history.replaceState({}, '', `/app/settings/security#nc_link=${encodeURIComponent(TICKET)}`);
        answer(200, { linked: true });
        render(<LinkNextcloudAccount />);
        expect(screen.getByText(/Nextcloud account ann on cloud\.example\.org/)).toBeTruthy();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Link Nextcloud account' }));
        expect(await screen.findByRole('status')).toHaveTextContent('Your Nextcloud account is linked');
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toMatch(/\/auth\/connector\/link$/);
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({ ticket: TICKET });
        expect(window.location.hash).toBe('');
    });

    it('asks for a fresh sign-in when the server wants one, and keeps the ticket', async () => {
        window.history.replaceState({}, '', `/app/settings/security#nc_link=${encodeURIComponent(TICKET)}`);
        answer(403, { error: 'Sign in again.', code: 'reauth_required' });
        render(<LinkNextcloudAccount />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Link Nextcloud account' }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(window.location.hash).toContain('nc_link=');
    });

    it('says when the link is for another account', async () => {
        window.history.replaceState({}, '', `/app/settings/security#nc_link=${encodeURIComponent(TICKET)}`);
        answer(403, { error: 'x', code: 'nc_link_other_account' });
        render(<LinkNextcloudAccount />);
        await userEvent.setup().click(screen.getByRole('button', { name: 'Link Nextcloud account' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('This link is for another Bee Flow account');
    });
});
