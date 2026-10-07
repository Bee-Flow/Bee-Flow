import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ConnectorDrawerJs from './ConnectorDrawer';

/**
 * The connector drawer reports what is true: a linked connection the vault
 * no longer lists stays visible as such, empty settings leave room for the
 * example, the status reads as in the table, and the id is a tooltip rather
 * than a mono line.
 */

interface Connection { id: string; label?: string; kind?: string }
interface DrawerProps {
    connector: Record<string, unknown>;
    busy?: boolean;
    onLoadConnections?: (id: string) => Promise<Connection[]>;
    onSave?: (id: string, patch: Record<string, unknown>) => void;
    onSweep?: (id: string) => void;
    onClose?: () => void;
    mode?: 'inline' | 'overlay' | 'modal';
}
// ConnectorDrawer is plain JSX; these are the props it actually takes.
const ConnectorDrawer = ConnectorDrawerJs as unknown as React.ComponentType<DrawerProps>;

const GITHUB = {
    id: 'github',
    titleKey: 'GitHub repository security',
    descKey: 'Branch protection and review evidence',
    covered_controls: ['A.8.4', 'A.8.32'],
    credential: { provider: 'github' },
    settings_hint: 'repos: ["owner/repo"]',
    config: {
        enabled: true, connection_id: 'conn_github_org', settings: {},
        last_status: 'warn', last_sweep_at: '2026-09-14T06:00:00Z',
        last_error: 'Branch protection is off on 1 of 7 repositories.',
    },
};

function renderDrawer(over: Partial<DrawerProps> = {}) {
    const props: DrawerProps = {
        connector: GITHUB,
        onLoadConnections: vi.fn(async () => [{ id: 'conn_other', label: 'Other org', kind: 'github' }]),
        onSave: vi.fn(),
        onSweep: vi.fn(),
        onClose: vi.fn(),
        ...over,
    };
    render(<ConnectorDrawer {...props} />);
    return { props, user: userEvent.setup() };
}

describe('ConnectorDrawer', () => {
    it('keeps a linked connection the vault no longer lists, marked as not found', async () => {
        renderDrawer();
        const select = screen.getByTestId('connector-drawer-connection') as HTMLSelectElement;
        await waitFor(() => expect(select.getAttribute('data-missing')).toBe('true'));
        expect(select.value).toBe('conn_github_org');
        expect(select.options[0].textContent).toBe('Linked connection not found (conn_github_org)');
        expect(Array.from(select.options).map(o => o.textContent)).toContain('Other org (github)');
    });

    it('a linked connection the vault does list is simply selected', async () => {
        renderDrawer({ onLoadConnections: vi.fn(async () => [{ id: 'conn_github_org', label: 'Bee Flow org', kind: 'github' }]) });
        const select = screen.getByTestId('connector-drawer-connection') as HTMLSelectElement;
        await waitFor(() => expect(select.options[select.selectedIndex].textContent).toBe('Bee Flow org (github)'));
        expect(select.getAttribute('data-missing')).toBeNull();
        expect(Array.from(select.options).some(o => /not found/.test(o.textContent || ''))).toBe(false);
    });

    it('starts the settings box empty when there are no settings, so the example shows', async () => {
        const { props, user } = renderDrawer();
        const box = screen.getByTestId('connector-drawer-settings') as HTMLTextAreaElement;
        expect(box.value).toBe('');
        expect(box.getAttribute('placeholder')).toBe('{ repos: ["owner/repo"] }');
        // Saving the empty box writes an empty object, not an error.
        await user.click(screen.getByTestId('connector-drawer-foot-primary'));
        expect(props.onSave).toHaveBeenCalledWith('github', { enabled: true, connection_id: 'conn_github_org', settings: {} });
    });

    it('shows no mono id line: the id is the title tooltip, the status sits beside it', () => {
        renderDrawer();
        expect(screen.queryByTestId('connector-drawer-id')).toBeNull();
        const title = screen.getByTestId('connector-drawer-title');
        expect(title.textContent).toBe('GitHub repository security');
        expect(title.getAttribute('title')).toBe('github');
        expect(screen.getByTestId('connector-drawer-status').textContent).toBe('Swept with findings');
    });

    it('draws the finding drawer-sized, as a warning after a sweep that ran', () => {
        renderDrawer();
        const finding = screen.getByTestId('connector-drawer-error');
        expect(finding.getAttribute('data-size')).toBe('sm');
        expect(finding.getAttribute('data-severity')).toBe('warning');
    });

    it('writes the last sweep in the one date style, and keeps the actions in the footer', async () => {
        const { props, user } = renderDrawer();
        expect(screen.getByTestId('connector-drawer-last').textContent).toMatch(/14 Sep( 2026)? \d{2}:\d{2}/);
        const footer = screen.getByTestId('connector-drawer-foot');
        expect(footer.contains(screen.getByTestId('connector-drawer-sweep'))).toBe(true);
        await user.click(screen.getByTestId('connector-drawer-sweep'));
        expect(props.onSweep).toHaveBeenCalledWith('github');
    });
});
