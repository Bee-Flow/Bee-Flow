// The server administrator's policy card: what organisation admins may
// install. Pins the stored mode on screen, the host list that appears only
// for the allowlist, what Save sends (hosts parsed from lines and commas),
// and Cancel throwing the edit away.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { OrgMcpPolicy } from '../../../api/queries/mcpLibrary';
import { fakeBackend, POLICY_PATH, policyPayload } from '@/test/mcpLibraryKit';
import { withQueryClient } from '@/test/queryWrapper';
import PolicyCard from './PolicyCard';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

let api: ReturnType<typeof fakeBackend>;
let stored: OrgMcpPolicy;
beforeEach(() => {
    stored = policyPayload().policy;
    api = fakeBackend(fetchMock);
    api.on('GET', POLICY_PATH, () => ({ body: { ...policyPayload(), policy: stored } }));
    api.on('PUT', POLICY_PATH, (body) => { stored = body as OrgMcpPolicy; return { body: { policy: stored } }; });
});

async function renderCard() {
    const user = userEvent.setup();
    render(withQueryClient(<PolicyCard />));
    await screen.findByRole('radiogroup', { name: 'What organisation admins may install' });
    return user;
}

const mode = (label: string) => screen.getByRole('radio', { name: new RegExp(`^${label}`) });
const hostsField = () => screen.queryByRole('textbox', { name: 'Allowed hosts' });
const saveButton = () => screen.queryByRole('button', { name: 'Save policy' });

it('shows the stored mode, the official endpoints, and nothing to save', async () => {
    await renderCard();
    expect(mode('Official servers only')).toHaveAttribute('aria-checked', 'true');
    expect(mode('Official servers only')).toHaveTextContent('Recommended');
    expect(mode('Switched off')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('mcp.linear.app · mcp.stripe.com')).toBeInTheDocument();
    expect(hostsField()).not.toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
});

it('choosing the allowlist reveals the host list, filled with the stored hosts', async () => {
    const user = await renderCard();
    await user.click(mode('Official servers and approved hosts'));
    expect(hostsField()).toHaveValue('mcp.acme.example');
    expect(saveButton()).toBeEnabled();
});

it('Save sends the mode and the hosts parsed from lines and commas, then shows what was stored', async () => {
    const user = await renderCard();
    await user.click(mode('Official servers and approved hosts'));
    const hosts = hostsField() as HTMLElement;
    await user.clear(hosts);
    await user.type(hosts, 'a.example.com{Enter}  b.example.com, c.example.com{Enter}{Enter}*.d.example.com ');
    await user.click(saveButton() as HTMLElement);

    expect(api.bodies('PUT', POLICY_PATH)).toEqual([{
        remote: 'allowlist',
        allowedHosts: ['a.example.com', 'b.example.com', 'c.example.com', '*.d.example.com'],
    }]);
    await waitFor(() => expect(saveButton()).not.toBeInTheDocument());
    expect(mode('Official servers and approved hosts')).toHaveAttribute('aria-checked', 'true');
    expect(hostsField()).toHaveValue('a.example.com\nb.example.com\nc.example.com\n*.d.example.com');
});

it('another mode keeps the stored host list as it is', async () => {
    const user = await renderCard();
    await user.click(mode('Any public server'));
    expect(hostsField()).not.toBeInTheDocument();
    await user.click(saveButton() as HTMLElement);
    expect(api.bodies('PUT', POLICY_PATH)).toEqual([{ remote: 'any', allowedHosts: ['mcp.acme.example'] }]);
});

it('Cancel throws the edit away: the stored mode again, no host list, nothing to save', async () => {
    const user = await renderCard();
    await user.click(mode('Official servers and approved hosts'));
    await user.type(hostsField() as HTMLElement, '{Enter}extra.example.com');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mode('Official servers only')).toHaveAttribute('aria-checked', 'true');
    expect(hostsField()).not.toBeInTheDocument();
    expect(saveButton()).not.toBeInTheDocument();
    expect(api.bodies('PUT', POLICY_PATH)).toEqual([]);
});

it('with the allowlist stored, only a real change to the hosts is something to save', async () => {
    stored = { remote: 'allowlist', allowedHosts: ['a.example.com', 'b.example.com'] };
    const user = await renderCard();
    const hosts = hostsField() as HTMLElement;
    await user.clear(hosts);
    await user.type(hosts, 'a.example.com, b.example.com ');
    expect(saveButton()).not.toBeInTheDocument();

    await user.type(hosts, 'c.example.com');
    expect(saveButton()).toBeInTheDocument();
});

it('a refused save says why and keeps the edit', async () => {
    api.on('PUT', POLICY_PATH, { status: 400, body: { error: 'At most 200 hosts.' } });
    const user = await renderCard();
    await user.click(mode('Switched off'));
    await user.click(saveButton() as HTMLElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 200 hosts.');
    expect(mode('Switched off')).toHaveAttribute('aria-checked', 'true');
});

it('a failed load offers a retry', async () => {
    api.on('GET', POLICY_PATH, { status: 403, body: { error: 'Only a server administrator can see the policy.' } });
    const user = userEvent.setup();
    render(withQueryClient(<PolicyCard />));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Only a server administrator can see the policy.');

    api.on('GET', POLICY_PATH, { body: policyPayload() });
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radiogroup', { name: 'What organisation admins may install' })).toBeInTheDocument();
});
