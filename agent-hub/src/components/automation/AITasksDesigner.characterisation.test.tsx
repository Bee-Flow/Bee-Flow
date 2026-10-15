import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFetchMock, FakeResponse } from '../../test/automationDesignerHarness';
import {
    INVOICES, installRouter, mountDesigner, res, scenario, sent as sentTo,
} from '../../test/automationDesignerHarness';
import { toast } from '../shared/Toast';

/**
 * AITasksDesigner's sidebar list as a user sees it, pinned before the long
 * function is split: the four reads behind it, loading / empty / failed
 * states, the filter (sidebar, building blocks and launcher together), the live
 * run marker and the per-row actions (pause, duplicate, trash, runs, import).
 *
 * Network: `authFetch`, the layer the other automation tests use. The builder
 * and the launcher are stand-ins from the shared harness (src/test).
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<(url: string, init?: RequestInit) => Promise<FakeResponse>>() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/helpers')>()), API_BASE: '', authFetch,
}));
vi.mock('./Builder/BuilderShell', async () => ({ default: (await import('../../test/automationDesignerStubs')).BuilderStub }));
vi.mock('../admin/Studio/AutomationsStudio/AutomationsLauncher', async () => ({ default: (await import('../../test/automationDesignerStubs')).LauncherStub }));

const sent = (method: string, url: string) => sentTo(authFetch as AuthFetchMock, method, url);
beforeEach(() => { installRouter(authFetch as AuthFetchMock); });
afterEach(() => { vi.restoreAllMocks(); });

describe('AITasksDesigner — the list', () => {
    it('shows the launcher on the right and the sidebar list on the left, fed by four reads', async () => {
        mountDesigner();
        expect(await screen.findByText('Invoice sync')).toBeInTheDocument();
        expect(screen.getByText('Weekly report')).toBeInTheDocument();
        expect(screen.getByText('Automations')).toBeInTheDocument();
        expect(screen.getByTestId('launcher')).toHaveAttribute('data-count', '2');
        expect(screen.queryByTestId('builder')).toBeNull();
        expect(sent('GET', '/api/automation/folders')).toHaveLength(1);
        expect(sent('GET', '/api/step/').length).toBeGreaterThanOrEqual(1);
        expect(sent('GET', '/api/automation/_runs/active')).toHaveLength(1);
        expect(screen.getByTestId('automation-blocks')).toHaveTextContent('Building blocks');
        expect(await screen.findByText('Send to Slack')).toBeInTheDocument();
    });

    it('says "Loading…" until the first answer, then lists', async () => {
        let release: (r: FakeResponse) => void = () => {};
        const pending = new Promise<FakeResponse>((resolve) => { release = resolve; });
        scenario.list = () => ({ ok: true, status: 200, json: () => pending.then((r) => r.json()), text: async () => '' });
        mountDesigner();
        expect(await screen.findByText('Loading…')).toBeInTheDocument();
        expect(screen.queryByText('No automations yet.')).toBeNull();
        release(res(200, { automations: [INVOICES] }));
        expect(await screen.findByText('Invoice sync')).toBeInTheDocument();
        expect(screen.queryByText('Loading…')).toBeNull();
    });

    it('says "No automations yet." and explains the empty building blocks', async () => {
        scenario.list = () => res(200, { automations: [] });
        scenario.steps = () => res(200, { steps: [] });
        mountDesigner();
        expect(await screen.findByText('No automations yet.')).toBeInTheDocument();
        expect(screen.getByText(/No building blocks yet/)).toBeInTheDocument();
        expect(screen.getByTestId('launcher')).toHaveAttribute('data-count', '0');
    });

    it('a failed list read leaves an empty sidebar, not a crash', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        scenario.list = () => res(500);
        mountDesigner();
        expect(await screen.findByText('No automations yet.')).toBeInTheDocument();
        expect(screen.getByTestId('launcher')).toBeInTheDocument();
        await waitFor(() => expect(warn).toHaveBeenCalledWith('[AITasksDesigner] fetchAutomations failed:', expect.any(String)));
    });

    it('filters the sidebar, the building blocks and the launcher together; "No matches." when both are empty', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await screen.findByText('Invoice sync');
        const filter = screen.getByPlaceholderText('Filter…');
        await user.type(filter, 'WEEKLY');
        expect(screen.queryByText('Invoice sync')).toBeNull();
        expect(screen.getByText('Weekly report')).toBeInTheDocument();
        expect(screen.queryByText('Send to Slack')).toBeNull();
        expect(screen.getByTestId('launcher')).toHaveAttribute('data-count', '1');
        expect(screen.getByTestId('launcher')).toHaveAttribute('data-query', 'weekly');
        await user.clear(filter);
        await user.type(filter, 'slack');
        expect(screen.queryByText('No matches.')).toBeNull();
        expect(screen.getByText('Send to Slack')).toBeInTheDocument();
        await user.clear(filter);
        await user.type(filter, 'zzz');
        expect(screen.getByText('No matches.')).toBeInTheDocument();
    });

    it('marks an automation that is running right now', async () => {
        mountDesigner();
        const row = (await screen.findByText('Weekly report')).closest('div[title]');
        await waitFor(() => expect(row?.querySelector('.animate-pulse')).not.toBeNull());
        expect(screen.getByText('Invoice sync').closest('div[title]')?.querySelector('.animate-pulse')).toBeNull();
    });
});

describe('AITasksDesigner — row actions', () => {
    async function openMenu(user: ReturnType<typeof userEvent.setup>, title: string) {
        const row = (await screen.findByText(title)).closest('div[title]') as HTMLElement;
        await user.click(within(row).getByRole('button', { name: 'More options' }));
    }

    it('Pause calls deactivate then re-reads the list; Activate is the other label', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await openMenu(user, 'Invoice sync');
        await user.click(await screen.findByText('Pause'));
        await waitFor(() => expect(sent('POST', '/api/automation/a1/deactivate')).toHaveLength(1));
        await waitFor(() => expect(sent('GET', '/api/automation/').length).toBeGreaterThanOrEqual(2));
        await openMenu(user, 'Weekly report');
        expect(await screen.findByText('Activate')).toBeInTheDocument();
    });

    it('a failed toggle toasts the reason', async () => {
        const user = userEvent.setup();
        const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        authFetch.mockImplementation(async (url, init) => {
            if (init?.method === 'POST') return res(500, { error: 'engine is down' });
            if (/^\/api\/automation\/?$/.test(url)) return scenario.list();
            return res(200, url.includes('/step') ? { steps: [] } : {});
        });
        mountDesigner();
        await openMenu(user, 'Invoice sync');
        await user.click(await screen.findByText('Pause'));
        await waitFor(() => expect(error).toHaveBeenCalledWith('Could not pause “Invoice sync”: engine is down'));
    });

    it('Duplicate asks the server for a copy and opens it in the builder', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await openMenu(user, 'Invoice sync');
        await user.click(await screen.findByText('Duplicate'));
        expect(await screen.findByTestId('builder')).toHaveAttribute('data-id', 'copy-1');
        expect(sent('POST', '/api/automation/a1/duplicate')).toHaveLength(1);
    });

    it('the trash button asks first; Cancel sends nothing, Move to trash deletes and re-reads', async () => {
        const user = userEvent.setup();
        mountDesigner();
        const row = (await screen.findByText('Invoice sync')).closest('div[title]') as HTMLElement;
        await user.click(within(row).getByRole('button', { name: 'Move to trash' }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Delete "Invoice sync"?');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(sent('DELETE', '/api/automation/a1')).toHaveLength(0);

        await user.click(within(row).getByRole('button', { name: 'Move to trash' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to trash' }));
        await waitFor(() => expect(sent('DELETE', '/api/automation/a1')).toHaveLength(1));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('"View executions" opens the builder on the runs tab', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await openMenu(user, 'Weekly report');
        await user.click(await screen.findByText('View executions'));
        const b = await screen.findByTestId('builder');
        expect(b).toHaveAttribute('data-id', 'a2');
        expect(b).toHaveAttribute('data-tab', 'history');
    });

    it('import: refuses a file that is not JSON or not an export, accepts an export and opens it', async () => {
        const user = userEvent.setup();
        const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        const success = vi.spyOn(toast, 'success').mockImplementation(() => 0);
        mountDesigner();
        await screen.findByText('Invoice sync');
        const input = document.querySelector('input[type="file"]');
        if (!(input instanceof HTMLInputElement)) throw new Error('no file input');
        await user.upload(input, new File(['nope'], 'x.json', { type: 'application/json' }));
        await waitFor(() => expect(error).toHaveBeenCalledWith('That file is not JSON.'));
        await user.upload(input, new File(['{"format":"other"}'], 'y.json', { type: 'application/json' }));
        await waitFor(() => expect(error).toHaveBeenCalledWith('That is not a Bee Flow automation export.'));
        expect(sent('POST', '/api/automation/import')).toHaveLength(0);
        await user.upload(input, new File(['{"format":"beeflow.automation"}'], 'z.json', { type: 'application/json' }));
        expect(await screen.findByTestId('builder')).toHaveAttribute('data-id', 'imp-1');
        expect(success).toHaveBeenCalledWith('Imported as a draft.');
    });
});
