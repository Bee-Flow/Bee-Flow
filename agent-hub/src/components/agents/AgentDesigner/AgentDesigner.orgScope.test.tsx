// The admin dashboard's organisation reaches the agents list: one organisation
// chosen asks for that organisation only, and what is created there belongs to
// it; all organisations name each agent's.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentDesigner from './index';
import { withQueryClient } from '@/test/queryWrapper';

const AGENTS = [
    { id: 'a1', name: 'Alpha', owner_id: 'u1', is_published: true, organizationId: 'org-a', organizationName: 'Org A' },
    { id: 'a2', name: 'Beta', owner_id: 'u1', is_published: true, organizationId: null, organizationName: null },
];

let asked: string[];
let sent: { url: string; method: string; body: unknown }[];
let agentsAnswer: { status: number; body: unknown };

beforeEach(() => {
    asked = [];
    sent = [];
    agentsAnswer = { status: 200, body: AGENTS };
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
        const address = String(url);
        const method = (init?.method || 'GET').toUpperCase();
        asked.push(address);
        if (method !== 'GET') sent.push({ url: address, method, body: init?.body ? JSON.parse(String(init.body)) : null });
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (address.includes('/agents/all')) return json(agentsAnswer.status, agentsAnswer.body);
        if (address.includes('/agents/categories') && method === 'POST') return json(200, { id: 'cat-new', name: 'Sales' });
        if (address.includes('/agents/categories')) return json(200, []);
        if (method === 'POST' && /\/agents(\?|$)/.test(address)) return json(200, { id: 'new-agent', name: 'Helper' });
        return json(200, {});
    }));
});

describe('AgentDesigner and the dashboard organisation', () => {
    it('sends the chosen organisation as orgId with the list and the categories', async () => {
        render(withQueryClient(<AgentDesigner orgId="org-b" />));
        await waitFor(() => expect(asked.some(u => u.includes('/agents/all?orgId=org-b'))).toBe(true));
        await waitFor(() => expect(asked.some(u => u.includes('/agents/categories?orgId=org-b'))).toBe(true));
        expect(screen.queryByTestId('agent-row-org')).not.toBeInTheDocument();
    });

    it('under all organisations names the organisation on every row, and sends no orgId', async () => {
        render(withQueryClient(<AgentDesigner showOrgNames />));
        expect(await screen.findByText('Alpha')).toBeInTheDocument();
        expect(screen.getAllByTestId('agent-row-org').map(el => el.textContent)).toEqual(['Org A', 'No organisation']);
        expect(asked.some(u => u.includes('orgId='))).toBe(false);
    });

    it('creates an agent and a category in the chosen organisation', async () => {
        const user = userEvent.setup();
        agentsAnswer = { status: 200, body: [] };
        render(withQueryClient(<AgentDesigner orgId="org-b" />));
        await user.click(await screen.findByRole('button', { name: 'Create First Agent' }));
        await user.type(screen.getByLabelText('Name'), 'Helper');
        await user.click(screen.getByRole('button', { name: 'Add to category' }));
        await user.type(screen.getByPlaceholderText('Category name...'), 'Sales');
        await user.click(screen.getByRole('button', { name: 'Create' }));
        await waitFor(() => expect(sent.some(s => s.url.includes('/agents/categories'))).toBe(true));
        expect(sent.find(s => s.url.includes('/agents/categories'))?.url).toContain('/agents/categories?orgId=org-b');
        await user.click(screen.getByRole('button', { name: 'Save Changes' }));
        await waitFor(() => expect(sent.some(s => /\/agents$/.test(s.url))).toBe(true));
        expect(sent.find(s => /\/agents$/.test(s.url))?.body).toMatchObject({ name: 'Helper', organizationId: 'org-b', categoryId: 'cat-new' });
    });

    it('creates without an organisation when none is chosen', async () => {
        const user = userEvent.setup();
        agentsAnswer = { status: 200, body: [] };
        render(withQueryClient(<AgentDesigner showOrgNames />));
        await user.click(await screen.findByRole('button', { name: 'Create First Agent' }));
        await user.type(screen.getByLabelText('Name'), 'Helper');
        await user.click(screen.getByRole('button', { name: 'Save Changes' }));
        await waitFor(() => expect(sent.some(s => /\/agents$/.test(s.url))).toBe(true));
        expect(sent.find(s => /\/agents$/.test(s.url))?.body).not.toHaveProperty('organizationId');
    });

    it('an error answer for the list is an empty list, not a crash', async () => {
        agentsAnswer = { status: 404, body: { error: 'Organisation not found', code: 'organization_not_found' } };
        render(withQueryClient(<AgentDesigner orgId="gone" />));
        expect(await screen.findByText('No agents found')).toBeInTheDocument();
    });
});
