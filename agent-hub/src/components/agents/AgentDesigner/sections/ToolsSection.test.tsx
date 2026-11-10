import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { ToolsSection } from './ToolsSection';
import type { DesignerSectionProps } from './sectionProps';

function props(over: Partial<DesignerSectionProps> = {}): DesignerSectionProps {
    const base: Partial<DesignerSectionProps> = {
        selectedAgent: null,
        enabledIntegrations: null,
        setEnabledIntegrations: vi.fn(),
        integrationStatus: { orgEnabledIntegrations: ['github', 'n8n', 'fireflies'], hasN8nConfig: true },
    };
    return { ...base, ...over } as DesignerSectionProps;
}

describe('ToolsSection', () => {
    it('lists what this person can attach, with the count of selected ones', () => {
        renderWithClient(<ToolsSection {...props({ enabledIntegrations: ['github'] })} />);
        expect(screen.getByText('Agent Integrations (1/2)')).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'GitHub' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'n8n' })).not.toBeChecked();
        // Fireflies needs a key this person does not have.
        expect(screen.queryByRole('checkbox', { name: 'Fireflies' })).toBeNull();
    });

    it('a click on the tile or on the switch toggles the integration once', async () => {
        const p = props();
        renderWithClient(<ToolsSection {...p} />);
        await userEvent.click(screen.getByText('n8n'));
        await userEvent.click(screen.getByRole('checkbox', { name: 'GitHub' }));
        const updates = vi.mocked(p.setEnabledIntegrations).mock.calls.map(([fn]) => (fn as (prev: string[] | null) => string[])(null));
        expect(updates).toEqual([['github'], ['n8n']]);
    });

    it('says so when nothing is available', () => {
        renderWithClient(<ToolsSection {...props({ integrationStatus: null })} />);
        expect(screen.getByText('No integrations available')).toBeInTheDocument();
    });
});
