import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import SupportImapMailboxSection from './SupportImapMailboxSection';
import { bodyFromForm, formFromMailbox, portAfterSecurityChange, suggestHosts } from './SupportImapMailbox.helpers';
import type { CompanyImapMailbox } from './SupportInboxPanel.types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn();

const STORED: CompanyImapMailbox = {
    emailAddress: 'support@example.test',
    displayName: 'Support',
    imap: { host: 'imap.example.test', port: 993, security: 'tls', folder: 'INBOX' },
    smtp: { host: 'smtp.example.test', port: 587, security: 'starttls' },
    username: 'support@example.test',
    smtpUsername: null,
    aiAutoReply: false,
    active: true,
    syncStatus: 'idle',
    syncError: null,
    lastSyncAt: null,
};

let mailbox: CompanyImapMailbox | null = null;

beforeEach(() => {
    mailbox = null;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/support/mailbox') && !init?.method) return json({ mailbox: { connected: false, count: 0, imap: mailbox } });
        if (u.endsWith('/mailbox/imap') && init?.method === 'PUT') {
            mailbox = STORED;
            return json({ mailbox: STORED, test: { ok: true, imap: { ok: true }, smtp: { ok: true } } });
        }
        if (u.endsWith('/mailbox/imap/test')) return json({ test: { ok: false, imap: { ok: true }, smtp: { ok: false, error: 'SMTP: the server refused the user name or password.' } } });
        return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const callTo = (suffix: string, method: string) => fetchMock.mock.calls.find(([u, init]) => String(u).endsWith(suffix) && (init as RequestInit | undefined)?.method === method);

describe('SupportImapMailboxSection', () => {
    it('connects a new mailbox: guesses the servers from the address and saves what was typed', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportImapMailboxSection />);
        expect(await screen.findByText(/No mailbox connected/)).toBeInTheDocument();
        await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'support@example.test');
        await user.tab();
        expect(screen.getAllByRole('textbox', { name: 'Server' })[0]).toHaveValue('imap.example.test');
        await user.type(screen.getByLabelText('Password'), 'app-password');
        await user.click(screen.getByRole('button', { name: 'Save mailbox' }));
        await waitFor(() => expect(callTo('/mailbox/imap', 'PUT')).toBeTruthy());
        expect(JSON.parse(String((callTo('/mailbox/imap', 'PUT')![1] as RequestInit).body))).toEqual({
            emailAddress: 'support@example.test',
            displayName: '',
            imap: { host: 'imap.example.test', port: 993, security: 'tls', folder: 'INBOX' },
            smtp: { host: 'smtp.example.test', port: 587, security: 'starttls' },
            username: 'support@example.test',
            password: 'app-password',
            smtpUsername: null,
            aiAutoReply: false,
        });
        expect(await screen.findByText('Connected to support@example.test.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Read now' })).toBeEnabled();
    });

    it('shows which server refused the test, in words', async () => {
        mailbox = STORED;
        const user = userEvent.setup();
        renderWithClient(<SupportImapMailboxSection />);
        await screen.findByText('Connected to support@example.test.');
        await user.click(screen.getByRole('button', { name: 'Test connection' }));
        expect(await screen.findByText(/SMTP: the server refused the user name or password\./)).toBeInTheDocument();
        const body = JSON.parse(String((callTo('/mailbox/imap/test', 'POST')![1] as RequestInit).body));
        expect(body).not.toHaveProperty('password');
    });
});

describe('mailbox form helpers', () => {
    it('moves a default port along with the security setting and keeps a typed one', () => {
        expect(portAfterSecurityChange('imap', 'tls', 'starttls', '993')).toBe('143');
        expect(portAfterSecurityChange('smtp', 'starttls', 'tls', '587')).toBe('465');
        expect(portAfterSecurityChange('smtp', 'starttls', 'tls', '2525')).toBe('2525');
    });

    it('guesses hosts only for a real domain', () => {
        expect(suggestHosts('a@example.test')).toEqual({ imapHost: 'imap.example.test', smtpHost: 'smtp.example.test' });
        expect(suggestHosts('nodomain')).toBeNull();
    });

    it('sends an SMTP login only when it is a separate one', () => {
        const f = { ...formFromMailbox(STORED), smtpUsername: 'relay', smtpPassword: 'x' };
        expect(bodyFromForm(f)).toMatchObject({ smtpUsername: null });
        expect(bodyFromForm(f)).not.toHaveProperty('smtpPassword');
        expect(bodyFromForm({ ...f, separateSmtpLogin: true })).toMatchObject({ smtpUsername: 'relay', smtpPassword: 'x' });
    });
});
