import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../../../test/queryWrapper';

const { calls, answer } = vi.hoisted(() => ({
    calls: [] as Array<{ url: string; method: string; body: unknown }>,
    answer: { current: null as null | Record<string, unknown>, putStatus: 200, putBody: null as null | Record<string, unknown> },
}));

vi.mock('../../../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string, opts: { method?: string; body?: string } = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
        if (method === 'PUT') {
            return { ok: answer.putStatus < 400, status: answer.putStatus, json: async () => answer.putBody ?? answer.current };
        }
        return { ok: true, status: 200, json: async () => answer.current };
    }),
}));

import AgentBindingsSection from './AgentBindingsSection';

const BASE = {
    bindings: [],
    candidates: [{ id: 'a1', name: 'Invoice agent', description: null }, { id: 'a2', name: 'Support agent', description: null }],
    canManage: true,
    isAgentCall: true,
    toolName: 'send_invoice',
};

describe('AgentBindingsSection', () => {
    beforeEach(() => {
        calls.length = 0;
        answer.current = { ...BASE };
        answer.putStatus = 200;
        answer.putBody = null;
    });

    it('says plainly that no agent can call it yet', async () => {
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        expect(await screen.findByText(/Not linked to any agent yet/)).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Link an agent' })).toBeInTheDocument();
    });

    it('offers only the agents the server says the viewer may link, and saves the choice through its own endpoint', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        const select = await screen.findByRole('combobox', { name: 'Link an agent' });
        expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Link an agent…', 'Invoice agent', 'Support agent']);

        answer.putBody = { ...BASE, bindings: [{ agentId: 'a1', name: 'Invoice agent', canEdit: true, missing: false, usable: true, notGranted: false }] };
        await user.selectOptions(select, 'a1');

        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.url).toBe('/api/automation/auto1/agent-bindings');
        expect(put?.body).toEqual({ agentIds: ['a1'] });
        expect(await screen.findByText('Invoice agent', { selector: 'span' })).toBeInTheDocument();
        expect(screen.queryByText(/Not linked to any agent yet/)).not.toBeInTheDocument();
    });

    it('shows an agent the viewer cannot edit as "Another agent", without a name or a remove button', async () => {
        answer.current = {
            ...BASE,
            bindings: [
                { agentId: null, name: 'Secret agent name', canEdit: false, missing: false, usable: null, notGranted: null },
                { agentId: 'a1', name: 'Invoice agent', canEdit: true, missing: false, usable: true, notGranted: false },
            ],
        };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        expect(await screen.findByText('Another agent')).toBeInTheDocument();
        expect(screen.queryByText('Secret agent name')).not.toBeInTheDocument();
        const rows = screen.getAllByTestId('agent-binding-row');
        expect(within(rows[0]).queryByRole('button')).not.toBeInTheDocument();
        expect(within(rows[1]).getByRole('button', { name: 'Unlink Invoice agent' })).toBeInTheDocument();
    });

    it('unlinks with the remaining editable agents, and keeps the ones it cannot see out of the request', async () => {
        const user = userEvent.setup();
        answer.current = {
            ...BASE,
            bindings: [
                { agentId: null, name: null, canEdit: false, missing: false, usable: null, notGranted: null },
                { agentId: 'a1', name: 'Invoice agent', canEdit: true, missing: false, usable: true, notGranted: false },
                { agentId: 'a2', name: 'Support agent', canEdit: true, missing: false, usable: true, notGranted: false },
            ],
        };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        await user.click(await screen.findByRole('button', { name: 'Unlink Invoice agent' }));
        expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ agentIds: ['a2'] });
    });

});

describe('AgentBindingsSection, what it refuses to offer', () => {
    beforeEach(() => {
        calls.length = 0;
        answer.current = { ...BASE };
        answer.putStatus = 200;
        answer.putBody = null;
    });

    it('warns when the owner of the automation cannot use a linked agent', async () => {
        answer.current = { ...BASE, bindings: [{ agentId: 'a1', name: 'Invoice agent', canEdit: true, missing: false, usable: false, notGranted: false }] };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        expect(await screen.findByText(/cannot use this agent/)).toBeInTheDocument();
    });

    it('warns when the agent\'s own list leaves the automation out, so it is linked but never offered', async () => {
        answer.current = { ...BASE, bindings: [{ agentId: 'a1', name: 'Invoice agent', canEdit: true, missing: false, usable: true, notGranted: true }] };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        expect(await screen.findByText(/leaves this automation out of its list/)).toBeInTheDocument();
    });

    it('says nothing about the list when the agent offers the automation', async () => {
        answer.current = { ...BASE, bindings: [{ agentId: 'a1', name: 'Invoice agent', canEdit: true, missing: false, usable: true, notGranted: false }] };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        await screen.findByText('Invoice agent');
        expect(screen.queryByText(/leaves this automation out of its list/)).not.toBeInTheDocument();
    });

    it('shows a refusal as the server\'s reason, in a sentence', async () => {
        const user = userEvent.setup();
        answer.putStatus = 403;
        answer.putBody = { code: 'agent_owner_cannot_use', error: 'x' };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Link an agent' }), 'a2');
        expect(await screen.findByText(/owner of this automation cannot use that agent/)).toBeInTheDocument();
    });

    it('does not let a reader or an unsaved trigger link anything', async () => {
        answer.current = { ...BASE, canManage: false };
        const { unmount } = render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        expect(await screen.findByText(/Only people who can edit this automation/)).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        unmount();

        answer.current = { ...BASE, isAgentCall: false };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        expect(await screen.findByText(/Set the trigger to "Agent tool" and save it first/)).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });

    it('says the list could not be read instead of saying there are none', async () => {
        answer.current = { ...BASE, candidates: null };
        render(withQueryClient(<AgentBindingsSection automationId="auto1" />));
        expect(await screen.findByText(/Your agents could not be read/)).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    });
});
