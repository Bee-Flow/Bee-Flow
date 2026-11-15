import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { ToolsSection, type ToolsSectionProps } from './ToolsSection';
import type { DesignerIntegrationAccess } from '../useDesignerIntegrationAccess';
import type { OrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';

function props(over: Partial<ToolsSectionProps> = {}): ToolsSectionProps {
    const base: Partial<ToolsSectionProps> = {
        selectedAgent: null,
        enabledIntegrations: null,
        setEnabledIntegrations: vi.fn(),
        disableExternalTools: false,
        setDisableExternalTools: vi.fn(),
        integrationStatus: { orgEnabledIntegrations: ['github', 'n8n', 'fireflies'], hasN8nConfig: true },
    };
    return { ...base, ...over } as ToolsSectionProps;
}

describe('ToolsSection', () => {
    it('lists what this person can attach, with the count of selected ones', () => {
        renderWithClient(<ToolsSection {...props({ enabledIntegrations: ['github'] })} />);
        // Web Search is a built-in: offered whatever the org list says, as in Agent Studio.
        expect(screen.getByText('Agent Integrations (1/3)')).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: 'Agent Search' })).not.toBeChecked();
        expect(screen.getByRole('switch', { name: 'GitHub' })).toBeChecked();
        expect(screen.getByRole('switch', { name: 'n8n' })).not.toBeChecked();
        // Fireflies needs a key this person does not have.
        expect(screen.queryByRole('switch', { name: 'Fireflies' })).toBeNull();
    });

    it('a click on the tile or on the switch toggles the integration once', async () => {
        const p = props();
        renderWithClient(<ToolsSection {...p} />);
        await userEvent.click(screen.getByText('n8n'));
        await userEvent.click(screen.getByRole('switch', { name: 'GitHub' }));
        const updates = vi.mocked(p.setEnabledIntegrations).mock.calls.map(([fn]) => (fn as (prev: string[] | null) => string[])(null));
        expect(updates).toEqual([['agent-search', 'github'], ['agent-search', 'n8n']]);
    });

    it('says so when nothing is available', () => {
        renderWithClient(<ToolsSection {...props({ integrationStatus: null })} />);
        expect(screen.getByText('No integrations available')).toBeInTheDocument();
    });

    it('the master switch on top turns integrations and web search off, and locks the tiles', async () => {
        const p = props({ disableExternalTools: true });
        renderWithClient(<ToolsSection {...p} />);
        const master = screen.getByRole('switch', { name: 'Integrations and web search' });
        expect(master).not.toBeChecked();
        expect(screen.getByRole('switch', { name: 'GitHub' })).toBeDisabled();
        await userEvent.click(screen.getByText('n8n'));
        expect(p.setEnabledIntegrations).not.toHaveBeenCalled();
        await userEvent.click(master);
        expect(p.setDisableExternalTools).toHaveBeenCalledWith(false);
    });

    describe('in the admin dashboard', () => {
        function admin(available: string[], platformAdmin = false): DesignerIntegrationAccess {
            const integrations = Object.fromEntries(available.map(id => [id, { serverConfigured: true, inCeiling: true, available: true }]));
            const data = { orgId: 'org-b', homeOrg: false, degraded: false, integrations } as Partial<OrgIntegrationAvailability> as OrgIntegrationAvailability;
            return { how: { mode: 'admin', availability: { data }, platformAdmin }, adminMode: true, pending: false, unknown: false };
        }

        it("lists what the organisation has, not what the admin can use personally, and badges per-person apps", () => {
            // The admin has no Google login and no keys; the organisation has Gmail and Fireflies.
            renderWithClient(<ToolsSection {...props({ integrationStatus: { isGoogleUser: false }, access: admin(['gmail', 'fireflies']) })} />);
            expect(screen.getByRole('switch', { name: 'Gmail' })).toBeInTheDocument();
            expect(screen.getByRole('switch', { name: 'Fireflies' })).toBeInTheDocument();
            expect(screen.queryByRole('switch', { name: 'GitHub' })).toBeNull();
            expect(screen.getAllByText('Own account per person')).toHaveLength(2);
        });

        it("a first toggle on 'every integration' keeps the organisation's other integrations", async () => {
            const p = props({ enabledIntegrations: null, integrationStatus: null, access: admin(['gmail', 'fireflies']) });
            renderWithClient(<ToolsSection {...p} />);
            await userEvent.click(screen.getByRole('switch', { name: 'Gmail' }));
            const [[update]] = vi.mocked(p.setEnabledIntegrations).mock.calls;
            expect((update as (prev: string[] | null) => string[])(null)).toEqual(expect.arrayContaining(['fireflies', 'agent-search']));
        });

        it('a platform admin without a definite answer is told so', () => {
            const access: DesignerIntegrationAccess = { how: { mode: 'admin', availability: { isError: true }, platformAdmin: true }, adminMode: true, pending: false, unknown: true };
            renderWithClient(<ToolsSection {...props({ access })} />);
            expect(screen.getByText('Could not check whether this is available for this organisation')).toBeInTheDocument();
            expect(screen.getByRole('switch', { name: 'GitHub' })).toBeInTheDocument();
        });

        it("an organisation admin without a definite answer cannot toggle: a first toggle would drop the organisation's integrations", async () => {
            const access: DesignerIntegrationAccess = { how: { mode: 'admin', availability: { isError: true }, platformAdmin: false }, adminMode: true, pending: false, unknown: true };
            const p = props({ enabledIntegrations: null, access });
            renderWithClient(<ToolsSection {...p} />);
            expect(screen.getByText('Could not check whether this is available for this organisation')).toBeInTheDocument();
            const search = screen.getByRole('switch', { name: 'Agent Search' });
            expect(search).toBeDisabled();
            await userEvent.click(screen.getByText('Agent Search'));
            expect(p.setEnabledIntegrations).not.toHaveBeenCalled();
        });
    });
});
