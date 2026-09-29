import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { ent, calls, list } = vi.hoisted(() => ({
    ent: { current: { loading: false, error: null as string | null, lockReason: (_id: string): string | null => null } },
    calls: [] as Array<{ url: string; method: string; body: unknown }>,
    list: { current: null as null | unknown[] },
}));

const SHARES = {
    owner: { userId: 'u1', name: 'admin' },
    runsAs: { userId: 'u1', name: 'admin' },
    shares: [
        { principalType: 'group', principalId: 'g1', name: 'Finance', memberCount: 8, role: 'run' },
        { principalType: 'user', principalId: 'u2', name: 'S. de Boer', role: 'edit' },
    ],
};

vi.mock('../../../licensing/EntitlementsContext', () => ({ useEntitlements: () => ent.current }));
vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
        if (url.endsWith('/shares') && method === 'PUT') {
            const sent = JSON.parse(opts.body as string).shares;
            return { ok: true, status: 200, json: async () => ({ ...SHARES, shares: sent.map((s: object) => ({ name: 'x', ...s })) }) };
        }
        if (url.endsWith('/shares')) return { ok: true, status: 200, json: async () => ({ ...SHARES, shares: list.current ?? SHARES.shares }) };
        if (url.endsWith('/transfer-owner')) {
            return { ok: true, status: 200, json: async () => ({ automation: { id: 'a1', userId: 'u2', myRole: 'edit' }, owner: { userId: 'u2', name: 'S. de Boer' }, warnings: [] }) };
        }
        if (url === '/api/automation/a1/principals') {
            return { ok: true, status: 200, json: async () => ({ users: [{ id: 'u3', name: 'Piet' }], groups: [] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    }),
}));

import SharingSection from './SharingSection';

const automation = { id: 'a1', title: 'Collect files', definition: {}, myRole: 'owner' };

describe('SharingSection', () => {
    beforeEach(() => {
        calls.length = 0;
        list.current = null;
        ent.current = { loading: false, error: null, lockReason: () => null };
    });

    it('shows owner, editors and starters as pills', async () => {
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} />));
        expect(await screen.findByText('everyone in Finance')).toBeInTheDocument();
        expect(screen.getByText('S. de Boer')).toBeInTheDocument();
        expect(screen.getByText('admin')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    });

    it('is locked without automation_sharing in the plan: owner only, no Change', async () => {
        list.current = [];
        ent.current = { loading: false, error: null, lockReason: (id: string) => (id === 'automation_sharing' ? 'ceiling' : null) };
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} />));
        expect(await screen.findByText('admin')).toBeInTheDocument();
        expect(screen.getByTestId('sharing-locked')).toHaveTextContent('Until then only you can see');
        expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
        expect(screen.queryByText('Can edit')).not.toBeInTheDocument();
    });

    it('keeps existing shares visible and removable after the plan lapses, without adding', async () => {
        const user = userEvent.setup();
        ent.current = { loading: false, error: null, lockReason: (id: string) => (id === 'automation_sharing' ? 'ceiling' : null) };
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} />));
        expect(await screen.findByText('everyone in Finance')).toBeInTheDocument();
        expect(screen.getByTestId('sharing-locked')).toHaveTextContent('keep it');
        await user.click(screen.getByRole('button', { name: 'Change' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).queryByRole('combobox', { name: 'Add a person or group' })).not.toBeInTheDocument();
        await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role of Finance' }), '');
        expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ shares: [{ principalType: 'user', principalId: 'u2', role: 'edit' }] });
    });

    it('leaves a person who no longer exists out of the next save', async () => {
        const user = userEvent.setup();
        list.current = [...SHARES.shares, { principalType: 'user', principalId: 'gone', name: null, role: 'run', missing: true }];
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} />));
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = await screen.findByRole('dialog');
        await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role of Finance' }), 'view');
        const sent = (calls.find(c => c.method === 'PUT')?.body as { shares: Array<{ principalId: string }> }).shares;
        expect(sent.map(x => x.principalId)).toEqual(['g1', 'u2']);
    });

    it('does not lock while the entitlements are still loading', () => {
        ent.current = { loading: true, error: null, lockReason: () => 'ceiling' };
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} />));
        expect(screen.queryByTestId('sharing-locked')).not.toBeInTheDocument();
    });

    it('changes a role and removes access from the dialog, saving the whole list', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} />));
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = await screen.findByRole('dialog', { name: 'Who can do what with "Collect files"' });
        expect(within(dialog).getByText('group · 8 people')).toBeInTheDocument();
        expect(within(dialog).getByText('(you)')).toBeInTheDocument();
        expect(within(dialog).getByText('Use the button, see their own runs')).toBeInTheDocument();
        await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role of Finance' }), 'view');
        const put = calls.find(c => c.method === 'PUT');
        expect(put?.body).toEqual({ shares: [
            { principalType: 'group', principalId: 'g1', role: 'view' },
            { principalType: 'user', principalId: 'u2', role: 'edit' },
        ] });
    });

    it('adds a person with the chosen role', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} />));
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = await screen.findByRole('dialog');
        await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Role for the new person or group' }), 'edit');
        await user.type(within(dialog).getByRole('combobox', { name: 'Add a person or group' }), 'pie');
        await user.click(await within(dialog).findByRole('button', { name: /Piet/ }));
        const put = calls.filter(c => c.method === 'PUT').at(-1);
        expect((put?.body as { shares: unknown[] }).shares).toContainEqual({ principalType: 'user', principalId: 'u3', role: 'edit' });
    });

    it('hands the automation over to an editor: steps then run as them', async () => {
        const user = userEvent.setup();
        const onAutomationChange = vi.fn();
        render(withQueryClient(<SharingSection automation={automation} onSave={vi.fn()} onAutomationChange={onAutomationChange} />));
        await user.click(await screen.findByRole('button', { name: 'Change' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('not as whoever starts it')).toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'change' }));
        await user.selectOptions(within(dialog).getByRole('combobox', { name: 'New owner' }), 'u2');
        await user.click(within(dialog).getByRole('button', { name: 'Make owner' }));
        expect(calls.find(c => c.url.endsWith('/transfer-owner'))?.body).toEqual({ userId: 'u2' });
        // The builder's row follows: the old owner is an editor now.
        await vi.waitFor(() => expect(onAutomationChange).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', myRole: 'edit' })));
    });

    it('is read-only for someone who is not the owner', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<SharingSection automation={{ ...automation, myRole: 'edit' }} onSave={vi.fn()} />));
        await user.click(await screen.findByRole('button', { name: 'View' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
        expect(within(dialog).queryByRole('button', { name: 'change' })).not.toBeInTheDocument();
    });
});

describe('sharing errors', () => {
    it('reads the licence gate and the server\'s own sentence', async () => {
        const { sharingErrorText } = await import('./SharingDialog');
        const t = ((_k: string, f: string) => f) as never;
        expect(sharingErrorText({ status: 403, code: 'feature_locked' }, t)).toBe('Sharing with colleagues is not part of your plan.');
        expect(sharingErrorText({ status: 400, code: 'share_with_owner', serverMessage: 'The owner already has full access; leave them off the list.' }, t))
            .toBe('The owner already has full access; leave them off the list.');
        expect(sharingErrorText({ status: 500, code: null }, t)).toBe('Could not save who has access. Try again.');
    });
});
