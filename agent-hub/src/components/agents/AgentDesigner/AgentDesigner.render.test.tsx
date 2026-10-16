import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentDesigner from './index';

/**
 * The Agent Designer's layout, pinned when the 730-line component was split
 * into AgentListSidebar, PublishMenu and DesignerPanels. The real state hook
 * runs; the API hook is replaced by one that seeds that state the way the
 * real one does after its first fetch, and records the calls.
 */
type Seed = Record<string, unknown>;
let seed: Seed = {};
const api = {
    selectAgent: vi.fn(), createNewAgent: vi.fn(), saveAgent: vi.fn(), deleteAgent: vi.fn(),
    duplicateAgent: vi.fn(), togglePublish: vi.fn(), setPublishState: vi.fn(), toggleTool: vi.fn(),
    confirmDialog: null,
};

vi.mock('./hooks/useAgentApi', () => ({
    default: (state: Record<string, (v: unknown) => void>) => {
        // Seeded once, like the real hook's mount fetch.
        const seeded = useRef(false);
        useEffect(() => {
            if (seeded.current) return;
            seeded.current = true;
            state.setLoading(false);
            for (const [k, v] of Object.entries(seed)) state[`set${k[0].toUpperCase()}${k.slice(1)}`](v);
        }, [state]);
        return api;
    },
}));
vi.mock('./hooks/useAgentChat', () => ({ default: () => ({ sendMessage: vi.fn(), clearHistory: vi.fn() }) }));
vi.mock('./sections/IdentitySection', () => ({ IdentitySection: () => <div data-testid="identity-section" /> }));
vi.mock('./sections/ToolsSection', () => ({ ToolsSection: () => <div data-testid="tools-section" /> }));
vi.mock('./sections/BehaviorSection', () => ({ BehaviorSection: () => <div data-testid="behavior-section" /> }));

const AGENTS = [
    { id: 'a1', name: 'Alpha', owner_id: 'u1', is_published: false },
    { id: 'a2', name: 'Beta', owner_id: 'u2', is_published: false },
];

beforeEach(() => {
    seed = {};
    for (const fn of Object.values(api)) if (typeof fn === 'function') fn.mockClear();
});

describe('AgentDesigner', () => {
    it('lists the agents and opens one on click', async () => {
        seed = { agents: AGENTS };
        render(<AgentDesigner />);
        await userEvent.click(await screen.findByText('Alpha'));
        expect(api.selectAgent).toHaveBeenCalledWith(AGENTS[0]);
        expect(screen.getByText('Agent Designer')).toBeInTheDocument();
    });

    it('locks duplicate and delete on someone else\'s unpublished agent for an agent editor', async () => {
        seed = { agents: AGENTS };
        render(<AgentDesigner user={{ id: 'u1', orgRole: 'agent_editor' }} />);
        const beta = (await screen.findByText('Beta')).closest('[role="button"]') as HTMLElement;
        expect(within(beta).getByTitle('Delete agent')).toBeDisabled();
        const alpha = screen.getByText('Alpha').closest('[role="button"]') as HTMLElement;
        await userEvent.click(within(alpha).getByTitle('Duplicate agent'));
        expect(api.duplicateAgent).toHaveBeenCalledWith(AGENTS[0]);
        expect(api.selectAgent).not.toHaveBeenCalled();
    });

    it('shows the open agent with its sections and the publish menu', async () => {
        seed = { agents: AGENTS, selectedAgent: AGENTS[0], name: 'Alpha', orgGroups: [{ id: 'g1', name: 'Sales' }] };
        render(<AgentDesigner />);
        expect(await screen.findByText('Edit Agent')).toBeInTheDocument();
        expect(screen.getByTestId('identity-section')).toBeInTheDocument();
        // No integration status yet: no Integrations section.
        expect(screen.queryByRole('button', { name: 'Integrations' })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: /Personal/ }));
        await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.click(screen.getByRole('button', { name: /Publish to 1 group/ }));
        expect(api.togglePublish).toHaveBeenCalledWith(['g1']);
        await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
        expect(api.saveAgent).toHaveBeenCalled();
    });

    it('says so when there are no agents, and creates one from there', async () => {
        seed = { agents: [] };
        render(<AgentDesigner />);
        expect(await screen.findByText('No agents found')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Create New Agent' }));
        expect(api.createNewAgent).toHaveBeenCalled();
    });
});
