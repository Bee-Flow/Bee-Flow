import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import ConnectorsPage, { nextSweepAt, toneOfConnector } from './ConnectorsPage';

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

afterEach(cleanup);

const CONNECTORS = [
    {
        id: 'github',
        titleKey: 'GitHub',
        descKey: 'Branch protection and review evidence',
        covered_controls: ['A.8.31', 'A.8.32'],
        credential: { provider: 'github' },
        settings_hint: '"org": "bee-flow"',
        config: { enabled: true, connection_id: 'conn_1', settings: { org: 'bee-flow' }, last_status: 'ok', last_sweep_at: '2026-09-14T06:00:00Z', last_error: null },
    },
    {
        id: 'scaleway',
        titleKey: 'Scaleway',
        descKey: 'Backup and encryption evidence',
        covered_controls: ['A.8.13'],
        credential: { provider: 'scaleway' },
        config: { enabled: true, connection_id: null, settings: {}, last_status: 'error', last_sweep_at: '2026-09-13T06:00:00Z', last_error: 'token expired' },
    },
    {
        id: 'selfcheck',
        titleKey: 'Platform self-check',
        descKey: 'Reads the platform itself',
        covered_controls: [],
        credential: null,
        config: { enabled: false, settings: {}, last_status: null, last_sweep_at: null },
    },
];

function connectorState(over = {}) {
    return {
        connectors: CONNECTORS,
        busyId: null,
        refresh: vi.fn(),
        save: vi.fn().mockResolvedValue({}),
        sweep: vi.fn().mockResolvedValue({}),
        loadConnections: vi.fn().mockResolvedValue([{ id: 'conn_1', label: 'Bee Flow org', kind: 'github' }]),
        ...over,
    };
}

function pageProps(over = {}) {
    const { connectors, ...rest } = over;
    return {
        section: { id: 'connectors' }, tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u) => u, api: '/api/compliance', isMobile: false, setHeaderActions: vi.fn(),
        data: { connectors: connectorState(connectors), orgUsers: [] },
        ...rest,
    };
}

describe('nextSweepAt / toneOfConnector', () => {
    it('schedules the next sweep six hours after the last one', () => {
        expect(nextSweepAt({ last_sweep_at: '2026-09-14T06:00:00Z' })).toBe('2026-09-14T12:00:00.000Z');
    });
    it('has no clock when nothing has ever swept', () => {
        expect(nextSweepAt({})).toBeNull();
        expect(nextSweepAt({ last_sweep_at: 'nonsense' })).toBeNull();
    });
    it('tones a connector by what its last sweep did', () => {
        expect(toneOfConnector({ enabled: false })).toBe('neutral');
        expect(toneOfConnector({ enabled: true, last_status: 'ok' })).toBe('success');
        expect(toneOfConnector({ enabled: true, last_status: 'error' })).toBe('error');
        expect(toneOfConnector({ enabled: true })).toBe('warning');
    });
});

describe('ConnectorsPage', () => {
    it('lists every connector with its status', () => {
        render(<ConnectorsPage {...pageProps()} />);
        expect(screen.getByTestId('connectors-status-github').textContent).toContain('Collecting');
        expect(screen.getByTestId('connectors-status-scaleway').textContent).toContain('failed');
        expect(screen.getByTestId('connectors-status-selfcheck').textContent).toContain('Off');
    });

    it('shows the last sweep and a clock for the next one', () => {
        render(<ConnectorsPage {...pageProps()} />);
        expect(screen.getByTestId('connectors-clock-github')).toBeTruthy();
        expect(screen.getByTestId('connectors-last-selfcheck').textContent).toBe('—');
        expect(screen.queryByTestId('connectors-clock-selfcheck')).toBeNull();
    });

    it('marks a connector that needs no credential', () => {
        render(<ConnectorsPage {...pageProps()} />);
        expect(screen.getByTestId('connectors-nocred-selfcheck')).toBeTruthy();
        expect(screen.queryByTestId('connectors-nocred-github')).toBeNull();
    });

    it('a failed read is its own state', () => {
        render(<ConnectorsPage {...pageProps({ connectors: { connectors: { error: 'x' } } })} />);
        expect(screen.getByTestId('connectors-failed')).toBeTruthy();
        expect(screen.queryByTestId('connectors-table')).toBeNull();
    });

    it('shows skeleton rows while the list is being read', () => {
        render(<ConnectorsPage {...pageProps({ connectors: { connectors: null } })} />);
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
    });

    it('opens the drawer and loads the vault connections', async () => {
        const loadConnections = vi.fn().mockResolvedValue([{ id: 'conn_1', label: 'Bee Flow org', kind: 'github' }]);
        render(<ConnectorsPage {...pageProps({ connectors: { loadConnections } })} />);
        fireEvent.click(screen.getByTestId('connectors-row-github'));
        await waitFor(() => expect(loadConnections).toHaveBeenCalledWith('github'));
        expect(screen.getByTestId('connector-drawer-connection').value).toBe('conn_1');
        expect(screen.getByTestId('connector-drawer-settings').value).toContain('bee-flow');
    });

    it('never asks the vault for a connector that needs no credential', async () => {
        const loadConnections = vi.fn();
        render(<ConnectorsPage {...pageProps({ connectors: { loadConnections } })} />);
        fireEvent.click(screen.getByTestId('connectors-row-selfcheck'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer')).toBeTruthy());
        expect(loadConnections).not.toHaveBeenCalled();
        expect(screen.queryByTestId('connector-drawer-connection')).toBeNull();
    });

    it('saves the enabled flag, the connection and the parsed settings', async () => {
        const save = vi.fn();
        render(<ConnectorsPage {...pageProps({ connectors: { save } })} />);
        fireEvent.click(screen.getByTestId('connectors-row-github'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer-settings')).toBeTruthy());
        fireEvent.change(screen.getByTestId('connector-drawer-settings'), { target: { value: '{"org":"acme"}' } });
        fireEvent.click(screen.getByTestId('connector-drawer-save'));
        expect(save).toHaveBeenCalledWith('github', { enabled: true, connection_id: 'conn_1', settings: { org: 'acme' } });
    });

    it('refuses to save invalid JSON instead of writing an empty settings object', async () => {
        const save = vi.fn();
        render(<ConnectorsPage {...pageProps({ connectors: { save } })} />);
        fireEvent.click(screen.getByTestId('connectors-row-github'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer-settings')).toBeTruthy());
        fireEvent.change(screen.getByTestId('connector-drawer-settings'), { target: { value: '{not json' } });
        fireEvent.click(screen.getByTestId('connector-drawer-save'));
        expect(save).not.toHaveBeenCalled();
        expect(screen.getByTestId('connector-drawer-settings-invalid')).toBeTruthy();
    });

    it('sweeps on demand, and only offers it while the connector is on', async () => {
        const sweep = vi.fn();
        render(<ConnectorsPage {...pageProps({ connectors: { sweep } })} />);
        fireEvent.click(screen.getByTestId('connectors-row-github'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer-sweep')).toBeTruthy());
        fireEvent.click(screen.getByTestId('connector-drawer-sweep'));
        expect(sweep).toHaveBeenCalledWith('github');
        fireEvent.click(screen.getByTestId('connectors-row-selfcheck'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer-id').textContent).toBe('selfcheck'));
        expect(screen.queryByTestId('connector-drawer-sweep')).toBeNull();
    });

    it('surfaces the last error in the drawer', async () => {
        render(<ConnectorsPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('connectors-row-scaleway'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer-error')).toBeTruthy());
        expect(screen.getByTestId('connector-drawer-error').textContent).toContain('token expired');
    });

    it('a second click on the same row closes the drawer', async () => {
        render(<ConnectorsPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('connectors-row-github'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer')).toBeTruthy());
        fireEvent.click(screen.getByTestId('connectors-row-github'));
        expect(screen.queryByTestId('connector-drawer')).toBeNull();
    });

    it('opens straight onto the focused connector', async () => {
        render(<ConnectorsPage {...pageProps({ focusId: 'scaleway' })} />);
        await waitFor(() => expect(screen.getByTestId('connector-drawer-id').textContent).toBe('scaleway'));
    });
});

describe('ConnectorsPage — phone (artboard 1h)', () => {
    it('the drawer is a right-side modal; desktop keeps the inline card', () => {
        const { unmount } = render(<ConnectorsPage {...pageProps({ isMobile: true })} />);
        fireEvent.click(screen.getByTestId('connectors-card-github'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('connector-drawer').dataset.mode).toBe('modal');
        unmount();
        render(<ConnectorsPage {...pageProps()} />);
        fireEvent.click(screen.getByTestId('connectors-row-github'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('connector-drawer').dataset.mode).toBe('inline');
    });
});
