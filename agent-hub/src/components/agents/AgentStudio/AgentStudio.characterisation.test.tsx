import { screen, waitFor, within } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentStudio from './index';

/**
 * AgentStudio's observable behaviour, pinned before the screen is split: the
 * three modes (card grid, wizard, editor), the list load / error / empty
 * branches, filters, the unsaved-draft guard, the URL reflection and editing
 * signal, and the plain delete dialog (the 409 round trip is in
 * deleteFlow.test.jsx). Network: `authFetch`; wizard and editor are stubs that
 * expose the props AgentStudio hands them.
 */

interface FakeResponse { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }
interface AgentRow { id: string; name: string; description?: string; can_edit?: boolean; category_id?: string; [key: string]: unknown }
interface SplitProps {
    agent: AgentRow;
    readOnly: boolean;
    onBack: () => void;
    onDirtyChange: (dirty: boolean) => void;
    onPublished: (updated: AgentRow) => Promise<void>;
    onDeleted: () => void;
}
interface WizardProps { onSwitchToManual: () => void; onPublished: (agent: AgentRow | null) => Promise<void> }

const { authFetch } = vi.hoisted(() => ({
    authFetch: vi.fn<(url: string, init?: RequestInit) => Promise<FakeResponse>>(),
}));

vi.mock('@/utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/helpers')>()),
    API_BASE: '',
    authFetch,
}));
vi.mock('../AgentWizard/BuilderSplit', () => ({
    default: (p: SplitProps) => (
        <div data-testid="split" data-agent-id={String(p.agent.id)} data-agent-name={p.agent.name} data-readonly={String(p.readOnly)}>
            <button onClick={p.onBack}>stub-back</button>
            <button onClick={() => p.onDirtyChange(true)}>stub-dirty</button>
            <button onClick={() => { void p.onPublished({ ...p.agent, name: 'Renamed' }); }}>stub-published</button>
            <button onClick={p.onDeleted}>stub-deleted</button>
        </div>
    ),
}));
vi.mock('../AgentWizard/index', () => ({
    default: (p: WizardProps) => (
        <div data-testid="wizard">
            <button onClick={p.onSwitchToManual}>stub-manual</button>
            <button onClick={() => { void p.onPublished({ id: 'new-1', name: 'Fresh' }); }}>stub-wizard-done</button>
            <button onClick={() => { void p.onPublished(null); }}>stub-wizard-none</button>
        </div>
    ),
}));

const res = (status: number, body: unknown = null, text = ''): FakeResponse => ({
    ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text,
});
const CATEGORIES = [{ id: 'c-support', name: 'Support' }, { id: 'c-sales', name: 'Sales' }];
const HELPDESK: AgentRow = { id: 'agent-1', name: 'Helpdesk', description: 'Answers tickets', can_edit: true, category_id: 'c-support' };
const QUOTES: AgentRow = { id: 'agent-2', name: 'Quote writer', description: 'Drafts offers', can_edit: true, category_id: 'c-sales' };
const UNFILED: AgentRow = { id: 'agent-3', name: 'Scratchpad', description: '', can_edit: false };

let listAnswer: () => FakeResponse;
let deleteAnswer: () => FakeResponse;
const calls = (method: string) => authFetch.mock.calls.filter(([, init]) => (init?.method || 'GET') === method).map(([url]) => url);
const listCalls = () => calls('GET').filter((u) => u.startsWith('/agents/all') || u.startsWith('/agents/system'));

beforeEach(() => {
    authFetch.mockReset();
    listAnswer = () => res(200, [HELPDESK, QUOTES, UNFILED]);
    deleteAnswer = () => res(200, { success: true });
    authFetch.mockImplementation(async (url, init) => {
        if (init?.method === 'DELETE') return deleteAnswer();
        if (url.startsWith('/agents/all') || url.startsWith('/agents/system')) return listAnswer();
        if (url === '/agents/categories') return res(200, CATEGORIES);
        return res(200, []);
    });
});

interface MountOptions { initialAgentId?: string; systemMode?: boolean; startInWizard?: boolean; hasPermission?: () => boolean }
function mount({ hasPermission = () => true, systemMode = false, startInWizard = false, initialAgentId }: MountOptions = {}) {
    const onNavigate = vi.fn();
    const onEditingChange = vi.fn();
    // AgentStudio.jsx infers `initialAgentId?: null` from its `= null` default; its contract is a string id.
    const widened: Record<string, unknown> = { initialAgentId: initialAgentId ?? null };
    renderWithClient(<AgentStudio user={{ id: 'u1' }} onClose={vi.fn()} onNavigate={onNavigate} hasPermission={hasPermission}
        systemMode={systemMode} startInWizard={startInWizard} onEditingChange={onEditingChange} {...widened} />);
    return { onNavigate, onEditingChange };
}
type User = ReturnType<typeof userEvent.setup>;
/** The card's own button (the first one; the trash can is its sibling). */
async function openCard(user: User, name: string) {
    await screen.findAllByTestId('agent-card');
    const card = screen.getAllByTestId('agent-card').find((c) => within(c).queryByText(name));
    if (!card) throw new Error(`no card for ${name}`);
    await user.click(within(card).getAllByRole('button')[0]);
}
const cardNames = () => screen.queryAllByTestId('agent-card').map((c) => within(c).getByText(/Helpdesk|Quote writer|Scratchpad/).textContent);

describe('AgentStudio — the card grid', () => {
    it('lists every agent with a count and asks for the used-by numbers', async () => {
        mount();
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
        expect(screen.getByRole('heading', { name: /^Agents/ })).toHaveTextContent('Agents3');
        expect(screen.getByTestId('agent-overview-count')).toHaveTextContent('3');
        expect(cardNames()).toEqual(['Helpdesk', 'Quote writer', 'Scratchpad']);
        expect(listCalls()).toEqual(['/agents/all?usage=1']);
    });

    it('shows a busy region first, then replaces it with the cards', async () => {
        mount();
        expect(screen.getByText('Loading agents')).toBeInTheDocument();
        await screen.findAllByTestId('agent-card');
        expect(screen.queryByText('Loading agents')).toBeNull();
    });

    it('says "No agents yet" with a New agent action when the list is empty', async () => {
        listAnswer = () => res(200, []);
        mount();
        expect(await screen.findByText('No agents yet')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-overview-count')).toBeNull();
        expect(screen.getAllByRole('button', { name: 'New agent' })).toHaveLength(2);
    });

    it('names the failure and retries the same request on Retry', async () => {
        const user = userEvent.setup();
        listAnswer = () => res(500);
        mount();
        const err = await screen.findByTestId('agent-overview-error');
        expect(err).toHaveTextContent('Failed to load agents: HTTP 500');
        expect(screen.queryByText('No agents yet')).toBeNull();

        listAnswer = () => res(200, [HELPDESK]);
        await user.click(within(err).getByRole('button', { name: 'Retry' }));
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(1);
        expect(screen.queryByTestId('agent-overview-error')).toBeNull();
        expect(listCalls()).toHaveLength(2);
    });
});

describe('AgentStudio — filters and permissions', () => {
    it('filters by search text (name or description) and says when nothing matches', async () => {
        const user = userEvent.setup();
        mount();
        await screen.findAllByTestId('agent-card');
        const box = screen.getByRole('textbox', { name: 'Search agents by name, purpose or category' });
        await user.type(box, 'offers');
        expect(cardNames()).toEqual(['Quote writer']);
        await user.clear(box);
        await user.type(box, 'zzz');
        expect(screen.getByTestId('agent-overview-no-match')).toHaveTextContent('No agent matches that.');
        expect(screen.queryAllByTestId('agent-card')).toHaveLength(0);
    });

    it('filters by category chip: toggles, and "No category" keeps the uncategorised ones', async () => {
        const user = userEvent.setup();
        mount();
        const group = await screen.findByRole('group', { name: 'Filter by category' });
        await waitFor(() => expect(within(group).getByRole('button', { name: /Support/ })).toBeInTheDocument());
        expect(within(group).getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');

        await user.click(within(group).getByRole('button', { name: /Support/ }));
        expect(within(group).getByRole('button', { name: /Support/ })).toHaveAttribute('aria-pressed', 'true');
        expect(cardNames()).toEqual(['Helpdesk']);

        await user.click(within(group).getByRole('button', { name: /Support/ }));
        expect(cardNames()).toHaveLength(3);

        await user.click(within(group).getByRole('button', { name: /No category/ }));
        expect(cardNames()).toEqual(['Scratchpad']);
    });

    it('system mode reads /agents/system, is titled System Agents and offers neither create nor delete', async () => {
        mount({ systemMode: true });
        await screen.findAllByTestId('agent-card');
        expect(screen.getByRole('heading', { name: /System Agents/ })).toBeInTheDocument();
        expect(listCalls()).toEqual(['/agents/system']);
        expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
        expect(screen.queryByLabelText(/Delete: /)).toBeNull();
    });

    it('without manage_agents there is no New agent button and no trash can', async () => {
        mount({ hasPermission: () => false });
        await screen.findAllByTestId('agent-card');
        expect(screen.queryByRole('button', { name: 'New agent' })).toBeNull();
        expect(screen.queryByLabelText(/Delete: /)).toBeNull();
    });

    it('only agents with an explicit can_edit: true get a trash can', async () => {
        mount();
        await screen.findAllByTestId('agent-card');
        expect(screen.getByLabelText('Delete: Helpdesk')).toBeInTheDocument();
        expect(screen.getByLabelText('Delete: Quote writer')).toBeInTheDocument();
        expect(screen.queryByLabelText('Delete: Scratchpad')).toBeNull();
    });
});

describe('AgentStudio — wizard and editor modes', () => {
    it('New agent opens the wizard, whose Back to Agents returns to the grid', async () => {
        const user = userEvent.setup();
        const { onNavigate } = mount();
        await screen.findAllByTestId('agent-card');
        await user.click(screen.getAllByRole('button', { name: 'New agent' })[0]);
        expect(screen.getByTestId('wizard')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-card')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Back to Agents' }));
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
        expect(onNavigate).toHaveBeenCalledWith('studio/agents');
        expect(onNavigate).not.toHaveBeenCalledWith(expect.stringMatching(/agents\/./));
    });

    it('Create empty agent opens an unsaved draft in the editor (no id, "Untitled agent")', async () => {
        const user = userEvent.setup();
        const { onNavigate, onEditingChange } = mount({ startInWizard: true });
        await user.click(await screen.findByRole('button', { name: 'Create empty agent' }));
        const split = await screen.findByTestId('split');
        expect(split).toHaveAttribute('data-agent-id', 'null');
        expect(split).toHaveAttribute('data-agent-name', 'Untitled agent');
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        // A draft has no URL of its own: the last path pushed stays the list.
        expect(onNavigate).not.toHaveBeenCalledWith('studio/agents/null');
    });

    it('opening a card shows the editor, reflects the id in the URL and signals editing', async () => {
        const user = userEvent.setup();
        const { onNavigate, onEditingChange } = mount();
        await openCard(user, 'Helpdesk');
        const split = await screen.findByTestId('split');
        expect(split).toHaveAttribute('data-agent-id', 'agent-1');
        expect(split).toHaveAttribute('data-readonly', 'false');
        expect(onNavigate).toHaveBeenLastCalledWith('studio/agents/agent-1');
        expect(onEditingChange).toHaveBeenLastCalledWith(true);

        await user.click(screen.getByRole('button', { name: 'stub-back' }));
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/agents');
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
    });

    it('an agent with can_edit: false opens read-only', async () => {
        const user = userEvent.setup();
        mount();
        await openCard(user, 'Scratchpad');
        expect(await screen.findByTestId('split')).toHaveAttribute('data-readonly', 'true');
    });
});

describe('AgentStudio — deep links, publishing and deleting from the editor', () => {
    it('a deep link opens that agent once the list has loaded', async () => {
        const { onNavigate } = mount({ initialAgentId: 'agent-2' });
        expect(await screen.findByTestId('split')).toHaveAttribute('data-agent-id', 'agent-2');
        // The navigate call comes from an effect after the split renders: wait for it.
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/agents/agent-2'));
        expect(onNavigate).not.toHaveBeenCalledWith('studio/agents');
    });

    it('a deep link to an agent that is gone drops to the grid', async () => {
        const { onNavigate } = mount({ initialAgentId: 'ghost' });
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
        expect(screen.queryByTestId('split')).toBeNull();
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/agents'));
    });

    it('a published agent from the wizard opens in the editor after a list refetch', async () => {
        const user = userEvent.setup();
        mount({ startInWizard: true });
        await user.click(await screen.findByRole('button', { name: 'stub-wizard-done' }));
        expect(await screen.findByTestId('split')).toHaveAttribute('data-agent-id', 'new-1');
        expect(listCalls()).toHaveLength(2);
    });

    it('a wizard that publishes nothing returns to the grid', async () => {
        const user = userEvent.setup();
        mount({ startInWizard: true });
        await user.click(await screen.findByRole('button', { name: 'stub-wizard-none' }));
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
    });

    it('a publish in the editor refetches the list and hands the editor the updated agent', async () => {
        const user = userEvent.setup();
        mount();
        await openCard(user, 'Helpdesk');
        await user.click(await screen.findByRole('button', { name: 'stub-published' }));
        await waitFor(() => expect(screen.getByTestId('split')).toHaveAttribute('data-agent-name', 'Renamed'));
        expect(listCalls()).toHaveLength(2);
    });

    it('the editor reporting a deletion returns to the grid and refetches', async () => {
        const user = userEvent.setup();
        mount();
        await openCard(user, 'Helpdesk');
        await user.click(await screen.findByRole('button', { name: 'stub-deleted' }));
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
        await waitFor(() => expect(listCalls()).toHaveLength(2));
    });
});

describe('AgentStudio — the unsaved draft guard', () => {
    async function dirtyDraft() {
        const user = userEvent.setup();
        const view = mount({ startInWizard: true });
        await user.click(await screen.findByRole('button', { name: 'Create empty agent' }));
        await user.click(await screen.findByRole('button', { name: 'stub-dirty' }));
        return { user, ...view };
    }

    it('leaving a dirty draft asks first; Cancel (or Escape) keeps the draft', async () => {
        const { user } = await dirtyDraft();
        await user.click(screen.getByRole('button', { name: 'stub-back' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Unsaved changes' });
        expect(dialog).toHaveTextContent('Your draft agent has not been saved yet. Leaving will discard these changes.');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(screen.getByTestId('split')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'stub-back' }));
        await screen.findByRole('alertdialog', { name: 'Unsaved changes' });
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(screen.getByTestId('split')).toBeInTheDocument();
    });

    it('Discard runs the leave: the draft is dropped and the grid is back', async () => {
        const { user } = await dirtyDraft();
        await user.click(screen.getByRole('button', { name: 'stub-back' }));
        await user.click(await screen.findByRole('button', { name: 'Discard' }));
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
        expect(screen.queryByTestId('split')).toBeNull();
    });

    it('a clean draft, or a saved agent, leaves without asking', async () => {
        const user = userEvent.setup();
        mount({ startInWizard: true });
        await user.click(await screen.findByRole('button', { name: 'Create empty agent' }));
        await user.click(await screen.findByRole('button', { name: 'stub-back' }));
        expect(await screen.findAllByTestId('agent-card')).toHaveLength(3);
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });
});

describe('AgentStudio — deleting from the grid', () => {
    async function openDialog(name: string) {
        const user = userEvent.setup();
        await user.click(await screen.findByLabelText(`Delete: ${name}`));
        const dialog = await screen.findByRole('alertdialog', { name: 'Delete agent' });
        return { user, dialog };
    }

    it('confirms by name, sends an unconfirmed DELETE, closes and refetches', async () => {
        mount();
        const { user, dialog } = await openDialog('Helpdesk');
        expect(dialog).toHaveTextContent('Delete agent "Helpdesk"? This cannot be undone.');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(calls('DELETE')).toEqual(['/agents/agent-1']);
        await waitFor(() => expect(listCalls()).toHaveLength(2));
    });

    it('shows the failure inside the dialog and keeps it open', async () => {
        deleteAnswer = () => res(500, null, 'database is locked');
        mount();
        const { user, dialog } = await openDialog('Helpdesk');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('database is locked');
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(listCalls()).toHaveLength(1);
    });

    it('falls back to the status when the failure has no body', async () => {
        deleteAnswer = () => res(502);
        mount();
        const { user, dialog } = await openDialog('Helpdesk');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('HTTP 502');
    });

    it('Cancel and Escape close it without a request; Ctrl+Enter confirms', async () => {
        mount();
        const first = await openDialog('Helpdesk');
        await first.user.click(within(first.dialog).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('alertdialog')).toBeNull();

        const second = await openDialog('Quote writer');
        await second.user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(calls('DELETE')).toEqual([]);

        const third = await openDialog('Quote writer');
        await third.user.keyboard('{Control>}{Enter}{/Control}');
        await waitFor(() => expect(calls('DELETE')).toEqual(['/agents/agent-2']));
    });
});
