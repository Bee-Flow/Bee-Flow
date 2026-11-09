// The plan editor's integration grid. Pinned: switching "restrict" on keeps
// what the plan included a moment ago; it does not hand out the opt-in MCP servers.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FeatureCardGrid, type FeatureOption } from './FeatureCardGrid';

const OPTIONS: FeatureOption[] = [
    { id: 'slack', label: 'Slack', category: 'Chat' },
    { id: 'jira', label: 'Jira', category: 'Work' },
    { id: 'mcp:files', label: 'Files server', category: 'MCP servers', isMcp: true },
];

describe('FeatureCardGrid', () => {
    it('starts a restriction from the catalog options, without the opt-in MCP servers', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<FeatureCardGrid options={OPTIONS} value={null} onChange={onChange} restrictLabel="Restrict integrations to selection" />);
        await user.click(screen.getByRole('switch'));
        expect(onChange).toHaveBeenCalledWith(['slack', 'jira']);
    });

    it('"Select all" is an explicit pick and includes the MCP servers', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<FeatureCardGrid options={OPTIONS} value={['slack']} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: 'Select all' }));
        expect(onChange).toHaveBeenCalledWith(['slack', 'jira', 'mcp:files']);
    });
});
