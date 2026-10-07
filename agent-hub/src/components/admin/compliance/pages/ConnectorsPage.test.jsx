import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
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
    it('has no next sweep when nothing has ever swept', () => {
        expect(nextSweepAt({})).toBeNull();
        expect(nextSweepAt({ last_sweep_at: 'nonsense' })).toBeNull();
    });
    it('tones a connector by what its last sweep did', () => {
        const at = '2026-09-14T06:00:00Z';
        expect(toneOfConnector({ enabled: false })).toBe('neutral');
        expect(toneOfConnector({ enabled: true })).toBe('warning');
        expect(toneOfConnector({ enabled: true, last_sweep_at: at, last_status: 'ok' })).toBe('success');
        expect(toneOfConnector({ enabled: true, last_sweep_at: at, last_status: 'error' })).toBe('error');
        expect(toneOfConnector({ enabled: true, last_sweep_at: at, last_status: 'warn', last_error: 'x' })).toBe('warning');
    });
});

describe('ConnectorsPage', () => {
    const setup = (over = {}) => {
        const user = userEvent.setup();
        const view = render(<ConnectorsPage {...pageProps(over)} />);
        return { user, ...view };
    };

    it('splits what collects from what is available', () => {
        setup();
        expect(screen.getByTestId('connectors-active').textContent).toContain('Collecting (2)');
        const table = screen.getByTestId('connectors-table');
        expect(within(table).getByTestId('connectors-row-github')).toBeTruthy();
        expect(within(table).getByTestId('connectors-row-scaleway')).toBeTruthy();
        expect(within(table).queryByTestId('connectors-row-selfcheck')).toBeNull();
        const available = screen.getByTestId('connectors-available');
        expect(available.textContent).toContain('Available (1)');
        expect(within(available).getByTestId('connectors-row-selfcheck').textContent).toContain('Platform self-check');
        expect(within(available).getByTestId('connectors-setup-selfcheck').textContent).toBe('Set up');
    });

    it('lists every collecting connector with its status, and no "Off" rows', () => {
        setup();
        expect(screen.getByTestId('connectors-status-github').textContent).toBe('Collecting');
        expect(screen.getByTestId('connectors-status-scaleway').textContent).toBe('Last sweep failed');
        expect(screen.queryByTestId('connectors-status-selfcheck')).toBeNull();
        expect(screen.queryByText('Off')).toBeNull();
    });

    it('a swept connector is never "Never swept", whatever its last_status says', () => {
        const at = new Date(Date.now() - 2 * 3600_000).toISOString();
        setup({ connectors: { connectors: [
            { ...CONNECTORS[0], config: { ...CONNECTORS[0].config, last_sweep_at: at, last_status: 'warn', last_error: 'Branch protection is off on 1 of 7 repositories.' } },
            { ...CONNECTORS[1], id: 'odd', config: { enabled: true, last_sweep_at: at, last_status: 'partial', last_error: null } },
            { ...CONNECTORS[1], id: 'fresh', config: { enabled: true, last_sweep_at: null, last_status: null } },
        ] } });
        expect(screen.getByTestId('connectors-status-github').textContent).toBe('Swept with findings');
        expect(screen.getByTestId('connectors-status-odd').textContent).toBe('Collecting');
        expect(screen.getByTestId('connectors-status-fresh').textContent).toBe('Never swept');
    });

    it('shows the sweep as plain text, not a deadline clock', () => {
        setup();
        const cell = screen.getByTestId('connectors-sweep-github');
        expect(cell.textContent).toMatch(/^Swept .+ · next ~.+$/);
        expect(screen.queryByText(/overdue|left$/)).toBeNull();
        expect(screen.queryByTestId('connectors-clock-github')).toBeNull();
    });

    it('writes a sweep in warning ink only once it is a whole interval late', () => {
        const recent = new Date(Date.now() - 9 * 3600_000).toISOString();
        const stale = new Date(Date.now() - 13 * 3600_000).toISOString();
        setup({ connectors: { connectors: [
            { ...CONNECTORS[0], config: { ...CONNECTORS[0].config, last_sweep_at: recent } },
            { ...CONNECTORS[1], config: { ...CONNECTORS[1].config, last_sweep_at: stale } },
        ] } });
        expect(screen.getByTestId('connectors-sweep-github').getAttribute('data-late')).toBeNull();
        expect(screen.getByTestId('connectors-sweep-scaleway').getAttribute('data-late')).toBe('true');
    });

    it('stripes only a problem row', () => {
        setup();
        expect(screen.getByTestId('connectors-row-github').getAttribute('data-accent')).toBeNull();
        expect(screen.getByTestId('connectors-row-scaleway').getAttribute('data-accent')).toBe('error');
    });

    it('marks a connector that needs no credential as quiet text', () => {
        setup();
        expect(screen.getByTestId('connectors-nocred-selfcheck').textContent).toContain('no credential needed');
        expect(screen.queryByTestId('connectors-nocred-github')).toBeNull();
    });

    it('a failed read is its own state', () => {
        setup({ connectors: { connectors: { error: 'x' } } });
        expect(screen.getByTestId('connectors-failed')).toBeTruthy();
        expect(screen.queryByTestId('connectors-table')).toBeNull();
    });

    it('shows skeleton rows while the list is being read', () => {
        setup({ connectors: { connectors: null } });
        expect(screen.getAllByTestId('table-skeleton-row').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('connectors-available')).toBeNull();
    });

    it('says so when nothing collects yet', () => {
        setup({ connectors: { connectors: [CONNECTORS[2]] } });
        expect(screen.getByTestId('connectors-active').textContent).toContain('Collecting (0)');
        expect(screen.getByTestId('connectors-table-empty').textContent).toContain('Nothing collects yet');
    });

    it('opens the drawer and loads the vault connections', async () => {
        const loadConnections = vi.fn().mockResolvedValue([{ id: 'conn_1', label: 'Bee Flow org', kind: 'github' }]);
        const { user } = setup({ connectors: { loadConnections } });
        await user.click(screen.getByTestId('connectors-row-github'));
        await waitFor(() => expect(loadConnections).toHaveBeenCalledWith('github'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer-connection').value).toBe('conn_1'));
        expect(screen.getByTestId('connector-drawer-settings').value).toContain('bee-flow');
    });

    it('"Set up" opens the drawer of an available connector, which never asks the vault without a credential', async () => {
        const loadConnections = vi.fn();
        const { user } = setup({ connectors: { loadConnections } });
        await user.click(screen.getByTestId('connectors-setup-selfcheck'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer')).toBeTruthy());
        expect(screen.getByTestId('connector-drawer-title').getAttribute('title')).toBe('selfcheck');
        expect(screen.getByTestId('connector-drawer-status').textContent).toBe('Off');
        expect(loadConnections).not.toHaveBeenCalled();
        expect(screen.queryByTestId('connector-drawer-connection')).toBeNull();
        expect(screen.getByTestId('connectors-setup-selfcheck').getAttribute('aria-expanded')).toBe('true');
    });

    it('saves the enabled flag, the connection and the parsed settings', async () => {
        const save = vi.fn();
        const { user } = setup({ connectors: { save } });
        await user.click(screen.getByTestId('connectors-row-github'));
        const settings = await screen.findByTestId('connector-drawer-settings');
        await user.clear(settings);
        await user.click(settings);
        await user.paste('{"org":"acme"}');
        await user.click(screen.getByTestId('connector-drawer-foot-primary'));
        expect(save).toHaveBeenCalledWith('github', { enabled: true, connection_id: 'conn_1', settings: { org: 'acme' } });
    });

    it('refuses to save invalid JSON instead of writing an empty settings object', async () => {
        const save = vi.fn();
        const { user } = setup({ connectors: { save } });
        await user.click(screen.getByTestId('connectors-row-github'));
        const settings = await screen.findByTestId('connector-drawer-settings');
        await user.clear(settings);
        await user.click(settings);
        await user.paste('{not json');
        await user.click(screen.getByTestId('connector-drawer-foot-primary'));
        expect(save).not.toHaveBeenCalled();
        expect(screen.getByTestId('connector-drawer-settings-invalid')).toBeTruthy();
        expect(settings.getAttribute('aria-invalid')).toBe('true');
    });

    it('sweeps on demand, and only offers it while the connector is on', async () => {
        const sweep = vi.fn();
        const { user } = setup({ connectors: { sweep } });
        await user.click(screen.getByTestId('connectors-row-github'));
        await user.click(await screen.findByTestId('connector-drawer-sweep'));
        expect(sweep).toHaveBeenCalledWith('github');
        await user.click(screen.getByTestId('connectors-setup-selfcheck'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer-title').getAttribute('title')).toBe('selfcheck'));
        expect(screen.queryByTestId('connector-drawer-sweep')).toBeNull();
    });

    it('surfaces the last error in the drawer, drawer-sized', async () => {
        const { user } = setup();
        await user.click(screen.getByTestId('connectors-row-scaleway'));
        const error = await screen.findByTestId('connector-drawer-error');
        expect(error.textContent).toContain('token expired');
        expect(error.getAttribute('data-size')).toBe('sm');
        expect(error.getAttribute('data-severity')).toBe('error');
    });

    it('a second click on the same row closes the drawer', async () => {
        const { user } = setup();
        await user.click(screen.getByTestId('connectors-row-github'));
        await waitFor(() => expect(screen.getByTestId('connector-drawer')).toBeTruthy());
        await user.click(screen.getByTestId('connectors-row-github'));
        expect(screen.queryByTestId('connector-drawer')).toBeNull();
    });

    it('opens straight onto the focused connector', async () => {
        setup({ focusId: 'scaleway' });
        await waitFor(() => expect(screen.getByTestId('connector-drawer-title').getAttribute('title')).toBe('scaleway'));
    });
});

describe('ConnectorsPage — phone (artboard 1h)', () => {
    it('a card carries the title, the coloured status and a meta line', () => {
        render(<ConnectorsPage {...pageProps({ isMobile: true })} />);
        const card = screen.getByTestId('connectors-card-github');
        expect(card.textContent).toContain('GitHub');
        expect(screen.getByTestId('connectors-card-status-github').getAttribute('data-tone')).toBe('success');
        expect(card.textContent).toContain('A.8.31 · A.8.32 · Swept');
    });

    it('the drawer is a right-side modal; desktop keeps the inline card', async () => {
        const user = userEvent.setup();
        const { unmount } = render(<ConnectorsPage {...pageProps({ isMobile: true })} />);
        await user.click(screen.getByTestId('connectors-card-github'));
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(screen.getByTestId('connector-drawer').dataset.mode).toBe('modal');
        unmount();
        render(<ConnectorsPage {...pageProps()} />);
        await user.click(screen.getByTestId('connectors-row-github'));
        expect(document.body.querySelector('[role="dialog"]')).toBeNull();
        expect(screen.getByTestId('connector-drawer').dataset.mode).toBe('inline');
    });
});
