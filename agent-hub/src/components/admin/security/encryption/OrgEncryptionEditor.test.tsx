import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/utils/helpers', () => ({ API_BASE: '/api', authFetch }));
vi.mock('@/components/shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The backfill card has its own tests; here it only has to be there or not.
vi.mock('./EncryptExistingData', () => ({ default: () => <div data-testid="encrypt-existing" /> }));

import OrgEncryptionEditor from './OrgEncryptionEditor';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const SETTINGS = {
    tier: 'none',
    tierOptions: [
        { tier: 'none', selectable: true },
        { tier: 'managed', selectable: true },
        { tier: 'zk', selectable: true },
    ],
};

function puts() {
    return authFetch.mock.calls.filter(([, o]) => o?.method === 'PUT').map(([, o]) => JSON.parse(o.body));
}

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockImplementation(async (_u: string, o?: { method?: string }) => (o?.method === 'PUT' ? json({}) : json(SETTINGS)));
});

describe('OrgEncryptionEditor', () => {
    it('heads its tier block itself and leaves the page title to the dashboard frame', async () => {
        render(withQueryClient(<OrgEncryptionEditor orgId="o1" />));
        expect(await screen.findByRole('heading', { level: 3, name: 'Encryption level' })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    });

    it('keeps Save off until another tier is chosen, and Cancel puts the stored tier back', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<OrgEncryptionEditor orgId="o1" />));
        const save = await screen.findByRole('button', { name: 'Save' });
        expect(save).toBeDisabled();
        await user.click(screen.getByRole('radio', { name: /Managed/ }));
        expect(save).toBeEnabled();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByRole('radio', { name: /Off/ })).toHaveAttribute('aria-checked', 'true');
        expect(save).toBeDisabled();
    });

    it('saves the chosen tier', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<OrgEncryptionEditor orgId="o1" />));
        await user.click(await screen.findByRole('radio', { name: /Managed/ }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(puts()).toEqual([{ tier: 'managed' }]));
    });

    it('says a refused save failed and offers a retry, rather than keep showing the last save', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<OrgEncryptionEditor orgId="o1" />));
        await user.click(await screen.findByRole('radio', { name: /Managed/ }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText(/Saved/)).toBeInTheDocument();

        authFetch.mockImplementation(async (_u: string, o?: { method?: string }) => (o?.method === 'PUT'
            ? json({ error: 'not_allowed', message: 'Not allowed' }, 403)
            : json(SETTINGS)));
        await user.click(screen.getByRole('radio', { name: /Zero-knowledge/ }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
        expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();
    });

    it('warns before a switch to zero-knowledge signs everyone out', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<OrgEncryptionEditor orgId="o1" />));
        await user.click(await screen.findByRole('radio', { name: /Zero-knowledge/ }));
        expect(screen.getByRole('alert')).toHaveTextContent(/sign out everyone/);
    });
});
