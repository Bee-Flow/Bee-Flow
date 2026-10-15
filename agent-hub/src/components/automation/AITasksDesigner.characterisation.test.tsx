import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuthFetchMock, FakeResponse } from '../../test/automationDesignerHarness';
import {
    INVOICES, entitlements, mountDesigner, res, scenario, useDesignerHarness,
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
 *
 * The right pane: the launcher, the automation builder and the Step builder
 * swap places; the URL and the editing signal follow; the in-editor list flyout
 * and Cmd/Ctrl+K reach other automations; the launcher's create / template /
 * suggestion paths; deep links and the entitlement gate. The stand-ins expose
 * the props the designer hands them.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<(url: string, init?: RequestInit) => Promise<FakeResponse>>() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/helpers')>()), API_BASE: '', authFetch,
}));
vi.mock('./Builder/BuilderShell', async () => ({ default: (await import('../../test/automationDesignerStubs')).BuilderStub }));
vi.mock('../admin/Studio/AutomationsStudio/AutomationsLauncher', async () => ({ default: (await import('../../test/automationDesignerStubs')).LauncherStub }));

const sent = useDesignerHarness(authFetch as AuthFetchMock);

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

type User = ReturnType<typeof userEvent.setup>;
const builder = () => screen.getByTestId('builder');
const openRow = async (user: User, title: string) => { await user.click(await screen.findByText(title)); return screen.findByTestId('builder'); };

describe('AITasksDesigner — automation builder pane', () => {
    it('opening a row swaps the right pane, drops the sidebar and reports editing + the URL; Back undoes all of it', async () => {
        const user = userEvent.setup();
        const { onNavigate, onEditingChange } = mountDesigner();
        const b = await openRow(user, 'Invoice sync');
        expect(b).toHaveAttribute('data-id', 'a1');
        expect(b).toHaveAttribute('data-mode', 'automation');
        expect(b).toHaveAttribute('data-can-export', 'true');
        expect(screen.queryByPlaceholderText('Filter…')).toBeNull();
        expect(screen.queryByTestId('launcher')).toBeNull();
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/automations/a1');

        await user.click(screen.getByRole('button', { name: 'stub-back' }));
        expect(await screen.findByTestId('launcher')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Filter…')).toBeInTheDocument();
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/automations');
    });

    it('the sidebar plus starts a new automation (no id, no export yet); the id it reports lands in the URL', async () => {
        const user = userEvent.setup();
        const { onNavigate } = mountDesigner();
        await user.click(await screen.findByRole('button', { name: 'New automation' }));
        const b = await screen.findByTestId('builder');
        expect(b).toHaveAttribute('data-id', 'null');
        expect(b).toHaveAttribute('data-can-export', 'false');
        await user.click(screen.getByRole('button', { name: 'stub-resolve' }));
        expect(builder()).toHaveAttribute('data-can-export', 'true');
        await waitFor(() => expect(onNavigate).toHaveBeenLastCalledWith('studio/automations/live-1'));
        await user.click(screen.getByRole('button', { name: 'stub-scope' }));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/automations/live-1/layer1');
    });

    it('a deep link opens that automation once the list has it; an unknown id stays on the launcher', async () => {
        mountDesigner({ initialTaskId: 'a2', initialFlowletKey: 'layer9' });
        const b = await screen.findByTestId('builder');
        expect(b).toHaveAttribute('data-id', 'a2');
        expect(b).toHaveAttribute('data-scope', 'layer9');
    });

    it('a deep link to an automation that does not exist leaves the launcher up', async () => {
        mountDesigner({ initialTaskId: 'ghost' });
        await screen.findByText('Invoice sync');
        expect(screen.getByTestId('launcher')).toBeInTheDocument();
        expect(screen.queryByTestId('builder')).toBeNull();
    });

    it('?view=runs opens the builder on the runs tab (tab id "history")', async () => {
        mountDesigner({ initialTaskId: 'a1', initialBuilderView: 'runs' });
        expect(await screen.findByTestId('builder')).toHaveAttribute('data-tab', 'history');
    });

    it('without the automations entitlement nothing creates or opens a builder', async () => {
        const user = userEvent.setup();
        mountDesigner({}, entitlements(false));
        await screen.findByText('Invoice sync');
        expect(screen.queryByRole('button', { name: 'Choose what to create' })).toBeNull();
        expect(screen.getByTestId('launcher')).toHaveAttribute('data-can-create', 'false');
        expect(screen.getByTestId('launcher')).toHaveAttribute('data-has-step', 'false');
        await user.click(screen.getByRole('button', { name: 'New automation' }));
        await user.click(screen.getByRole('button', { name: 'stub-open-a2' }));
        expect(screen.queryByTestId('builder')).toBeNull();
    });

    it('while entitlements still load the launcher says creation is not allowed yet', async () => {
        mountDesigner({}, entitlements(true, true));
        await screen.findByText('Invoice sync');
        expect(screen.getByTestId('launcher')).toHaveAttribute('data-can-create', 'false');
    });
});

describe('AITasksDesigner — launcher paths', () => {
    it('the launcher opens and creates, and a suggestion is sent directly or only prefilled', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await screen.findByText('Invoice sync');
        await user.click(screen.getByRole('button', { name: 'stub-open-a2' }));
        expect(await screen.findByTestId('builder')).toHaveAttribute('data-id', 'a2');
        await user.click(screen.getByRole('button', { name: 'stub-back' }));

        await user.click(await screen.findByRole('button', { name: 'stub-build' }));
        let b = await screen.findByTestId('builder');
        expect(b).toHaveAttribute('data-id', 'null');
        expect(b.getAttribute('data-auto-send')).toContain('Log every invoice');
        expect(b).toHaveAttribute('data-chat', '');
        await user.click(screen.getByRole('button', { name: 'stub-back' }));

        await user.click(await screen.findByRole('button', { name: 'stub-ask' }));
        b = await screen.findByTestId('builder');
        expect(b.getAttribute('data-chat')).toContain('Log every invoice');
        expect(b).toHaveAttribute('data-auto-send', '');
        await user.click(screen.getByRole('button', { name: 'stub-back' }));

        await user.click(await screen.findByRole('button', { name: 'stub-new' }));
        b = await screen.findByTestId('builder');
        expect(b).toHaveAttribute('data-chat', '');
        expect(b).toHaveAttribute('data-auto-send', '');
    });

    it('picking a template reads it, creates the automation from it and opens that', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await user.click(await screen.findByRole('button', { name: 'stub-template' }));
        expect(await screen.findByTestId('builder')).toHaveAttribute('data-id', 'from-tmpl');
        const [, init] = sent('POST', '/api/automation/')[0];
        expect(JSON.parse(String(init?.body))).toMatchObject({ title: 'Tmpl', description: null, templateId: 't1' });
    });

    it('a template that cannot be read toasts and stays on the launcher', async () => {
        const user = userEvent.setup();
        const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const base = authFetch.getMockImplementation();
        authFetch.mockImplementation(async (url, init) => (url === '/api/automation/templates/t1'
            ? res(404, { error: 'no such template' })
            : (base ? base(url, init) : res(200))));
        mountDesigner();
        await user.click(await screen.findByRole('button', { name: 'stub-template' }));
        await waitFor(() => expect(error).toHaveBeenCalledWith('Could not load template: no such template'));
        expect(screen.queryByTestId('builder')).toBeNull();
    });
});

describe('AITasksDesigner — building blocks (reusable Steps)', () => {
    it('a block opens the Step builder and puts steps/<id> in the URL; Back returns to the launcher', async () => {
        const user = userEvent.setup();
        const { onNavigate, onEditingChange } = mountDesigner();
        const b = await openRow(user, 'Send to Slack');
        expect(b).toHaveAttribute('data-mode', 'step');
        expect(b).toHaveAttribute('data-id', 'st1');
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/automations/steps/st1');
        await user.click(screen.getByRole('button', { name: 'stub-back' }));
        expect(await screen.findByTestId('launcher')).toBeInTheDocument();
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
    });

    it('the split + offers a new building block: a Step builder with no id yet', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await user.click(await screen.findByRole('button', { name: 'Choose what to create' }));
        await user.click(within(screen.getByTestId('sidebar-create-list')).getByText('New building block'));
        const b = await screen.findByTestId('builder');
        expect(b).toHaveAttribute('data-mode', 'step');
        expect(b).toHaveAttribute('data-id', 'null');
        expect(sent('GET', '/api/step/').length).toBeGreaterThanOrEqual(1);
    });

    it('the launcher\'s New building block opens the same Step builder', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await user.click(await screen.findByRole('button', { name: 'stub-new-block' }));
        expect(await screen.findByTestId('builder')).toHaveAttribute('data-mode', 'step');
    });

    it('a deep link to a step opens the Step builder', async () => {
        mountDesigner({ initialStepId: 'st1' });
        const b = await screen.findByTestId('builder');
        expect(b).toHaveAttribute('data-mode', 'step');
        expect(b).toHaveAttribute('data-id', 'st1');
    });
});

describe('AITasksDesigner — reaching another automation from inside the editor', () => {
    it('the list flyout shows the same list; picking a row closes it and switches the builder', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await openRow(user, 'Invoice sync');
        expect(screen.queryByRole('dialog', { name: 'Automations' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'stub-open-list' }));
        const flyout = await screen.findByRole('dialog', { name: 'Automations' });
        expect(within(flyout).getByText('Invoice sync')).toBeInTheDocument();
        expect(within(flyout).getByPlaceholderText('Filter…')).toBeInTheDocument();
        await user.click(within(flyout).getByText('Weekly report'));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Automations' })).toBeNull());
        expect(builder()).toHaveAttribute('data-id', 'a2');
    });

    it('the flyout closes with its Close button and with Escape', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await openRow(user, 'Invoice sync');
        await user.click(screen.getByRole('button', { name: 'stub-open-list' }));
        await user.click(within(await screen.findByRole('dialog', { name: 'Automations' })).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Automations' })).toBeNull());
        await user.click(screen.getByRole('button', { name: 'stub-open-list' }));
        await screen.findByRole('dialog', { name: 'Automations' });
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Automations' })).toBeNull());
    });

    it('the flyout leads with the building blocks while a Step is open, and its + starts a new automation', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await openRow(user, 'Send to Slack');
        await user.click(screen.getByRole('button', { name: 'stub-open-list' }));
        const flyout = await screen.findByRole('dialog', { name: 'Automations' });
        const blocks = within(flyout).getByTestId('automation-blocks');
        expect(blocks).toHaveTextContent('Send to Slack');
        expect(blocks.compareDocumentPosition(within(flyout).getByText('Invoice sync')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        await user.click(within(flyout).getByTestId('flyout-create-main'));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Automations' })).toBeNull());
        expect(builder()).toHaveAttribute('data-mode', 'automation');
        expect(builder()).toHaveAttribute('data-id', 'null');
    });

    it('Ctrl+K opens the quick switcher; typing narrows it and Enter opens the pick', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await screen.findByText('Invoice sync');
        await user.keyboard('{Control>}k{/Control}');
        const dialog = await screen.findByRole('dialog', { name: 'Jump to an automation' });
        expect(within(dialog).getByText('Invoice sync')).toBeInTheDocument();
        expect(within(dialog).getByText('Weekly report')).toBeInTheDocument();
        await user.keyboard('weekly{Enter}');
        expect(await screen.findByTestId('builder')).toHaveAttribute('data-id', 'a2');
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Jump to an automation' })).toBeNull());
    });

    it('the ⌘K chip in the filter opens the switcher too; Escape closes it', async () => {
        const user = userEvent.setup();
        mountDesigner();
        await user.click(await screen.findByRole('button', { name: 'Quick switch' }));
        await screen.findByRole('dialog', { name: 'Jump to an automation' });
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Jump to an automation' })).toBeNull());
    });

    it('outside the Studio shell (not embedded) Ctrl+K does nothing', async () => {
        const user = userEvent.setup();
        mountDesigner({ embedded: false });
        await screen.findByText('Invoice sync');
        await user.keyboard('{Control>}k{/Control}');
        expect(screen.queryByRole('dialog', { name: 'Jump to an automation' })).toBeNull();
    });

    it('a list that fails to load still lets a deep-linked row wait without opening a builder', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        scenario.list = (): FakeResponse => res(500);
        mountDesigner({ initialTaskId: 'a1' });
        await screen.findByText('No automations yet.');
        expect(screen.queryByTestId('builder')).toBeNull();
    });
});
