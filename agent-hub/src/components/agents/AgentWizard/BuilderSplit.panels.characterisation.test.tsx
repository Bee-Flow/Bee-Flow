import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BuilderSplit from './BuilderSplit';
import EntitlementsContext from '../../licensing/EntitlementsContext';
import type { EntitlementsValue } from '../../licensing/EntitlementsContext';
import { withQueryClient } from '../../../test/render';

/**
 * BuilderSplit's panels and dialogs that BuilderSplit.test.jsx and
 * BuilderSplit.save.test.jsx leave open, pinned before the editor is split
 * further: the Test and Used-by tabs, the plan-limit banner, the dirty signal
 * and the autosave of an edit, the Advanced drawer with the public-embed
 * confirmation, the Schedules pill and its delete dialog, and the refine rail
 * (Enter to send, a failure, and the first message that arrives from the wizard).
 *
 * Network: `authFetch` with a route table; anything unlisted answers 500, like
 * the sibling suites. The English catalogue is the real one.
 */

interface FakeResponse { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }
type Route = [method: string, urlPart: string, answer: (init: RequestInit) => FakeResponse];

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<(url: string, init?: RequestInit) => Promise<FakeResponse>>() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../utils/helpers')>()), API_BASE: '', authFetch,
}));

const reply = (status: number, body: unknown = {}, text = ''): FakeResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text });
const AGENT = { id: 'agent-1', name: 'Test Agent', description: 'A test agent', system_prompt: 'Do the thing.', is_published: 0, config: {}, updated_at: '2026-08-01T10:00:00Z', rev: 3 };
const DRAFT = { name: 'Draft', description: 'D', system_prompt: 'Draft prompt', config: { memoryEnabled: false } };

function route(routes: Route[]) {
    authFetch.mockImplementation(async (url, init = {}) => {
        const method = init.method || 'GET';
        const hit = routes.find(([m, part]) => m === method && url.includes(part));
        return hit ? hit[2](init) : reply(500);
    });
}
const calls = (method: string, part: string) => authFetch.mock.calls.filter(([u, i]) => (i?.method || 'GET') === method && u.includes(part));
const bodyOf = (call: [string, RequestInit?] | undefined): Record<string, unknown> => JSON.parse(String(call?.[1]?.body ?? '{}'));

function entitlements(can: boolean): EntitlementsValue {
    const none = { core: [], beta: [], integration: [] };
    return {
        loading: false, degraded: false, tier: 'full', mode: 'cloud', effective: none, ceiling: none, can: () => can,
        inCeiling: () => true, lockReason: () => null, hasTier: () => true, reload: () => {},
    };
}
interface MountOptions { agent?: Record<string, unknown>; readOnly?: boolean; initialRefinement?: string }
function mount({ agent = AGENT, readOnly = false, initialRefinement }: MountOptions = {}, can = false) {
    const onBack = vi.fn();
    const onPublished = vi.fn();
    const onDirtyChange = vi.fn();
    // BuilderSplit.jsx infers `initialRefinement?: null` from its `= null` default; its contract is a string.
    const widened: Record<string, unknown> = { initialRefinement: initialRefinement ?? null };
    render(withQueryClient(
        <EntitlementsContext.Provider value={entitlements(can)}>
            <BuilderSplit agent={agent} plan={null} history={[]} tier="fast" locale="en" onBack={onBack} onPublished={onPublished}
                onDirtyChange={onDirtyChange} rightHeaderExtras={null} user={null} readOnly={readOnly} onNavigate={null} {...widened} />
        </EntitlementsContext.Provider>,
    ));
    return { onBack, onPublished, onDirtyChange };
}
const tab = (name: RegExp) => screen.getAllByRole('radio', { name })[0];

beforeEach(() => { authFetch.mockReset(); route([]); });
afterEach(() => { vi.restoreAllMocks(); });

describe('BuilderSplit — Test and Used-by tabs', () => {
    it('an unsaved draft has no test set: the Test tab says where questions will land', async () => {
        const user = userEvent.setup();
        mount({ agent: DRAFT });
        await user.click(tab(/^Test/));
        expect(await screen.findByText('Test questions land here')).toBeInTheDocument();
        expect(calls('GET', '/tests')).toHaveLength(0);
    });

    it('a saved agent reads its test set only once the Test tab is opened', async () => {
        const user = userEvent.setup();
        mount();
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(calls('GET', '/agents/agent-1/tests')).toHaveLength(0);
        await user.click(tab(/^Test/));
        await waitFor(() => expect(calls('GET', '/agents/agent-1/tests').length).toBeGreaterThanOrEqual(1));
        expect(screen.queryByText('Test questions land here')).toBeNull();
    });

    it('a readable, empty usage list says nothing uses the agent and puts a 0 nowhere else', async () => {
        const user = userEvent.setup();
        route([['GET', '/usage', () => reply(200, [])]]);
        mount();
        await user.click(tab(/^Used by/));
        expect(await screen.findByText('Nothing uses this agent yet.')).toBeInTheDocument();
    });
});

describe('BuilderSplit — saving', () => {
    it('a draft refused by the plan limit shows a dismissible banner with the way to upgrade', async () => {
        const user = userEvent.setup();
        route([['POST', '/agents', () => reply(403, {}, JSON.stringify({ error: 'Your plan allows 3 agents.', code: 'limit_reached', resource: 'agents' }))]]);
        mount({ agent: DRAFT });
        await user.click(screen.getByTestId('agent-save-draft'));
        expect(await screen.findByText('Plan limit reached')).toBeInTheDocument();
        expect(screen.getByText('Your plan allows 3 agents.')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'View plans & upgrade' })).toHaveAttribute('href', '/app/settings/organisation/license');
        await user.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByText('Plan limit reached')).toBeNull();
    });

    it('an edit marks the editor dirty and autosaves the new name with the version it is based on', async () => {
        const user = userEvent.setup();
        route([['PUT', '/agents/agent-1', () => reply(200, { ...AGENT, name: 'Renamed', rev: 4 })]]);
        const { onDirtyChange } = mount();
        const input = screen.getByDisplayValue('Test Agent');
        await user.clear(input);
        await user.type(input, 'Renamed');
        await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(true));
        await waitFor(() => expect(calls('PUT', '/agents/agent-1').length).toBeGreaterThanOrEqual(1), { timeout: 4000 });
        const last = calls('PUT', '/agents/agent-1').at(-1);
        expect(bodyOf(last)).toMatchObject({ name: 'Renamed', systemPrompt: 'Do the thing.' });
        await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false), { timeout: 4000 });
    });

    it('Back to Agents calls onBack, also while the agent is read-only', async () => {
        const user = userEvent.setup();
        const { onBack } = mount({ readOnly: true });
        await user.click(screen.getByRole('button', { name: /Back to Agents/ }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});

describe('BuilderSplit — Advanced settings drawer', () => {
    async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('button', { name: 'Advanced settings' }));
        return screen.findByRole('dialog', { name: 'Advanced settings' });
    }

    it('lists Behavior and Embed & bubble, plus Version History and Compliance for a saved agent only', async () => {
        const user = userEvent.setup();
        mount();
        const drawer = await openDrawer(user);
        for (const title of ['Behavior', 'Embed & bubble', 'Version History', 'Compliance']) {
            expect(within(drawer).getByText(title)).toBeInTheDocument();
        }
        await user.click(within(drawer).getByRole('button', { name: /Close/ }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Advanced settings' })).toBeNull());
    });

    it('a draft has no version history or compliance section', async () => {
        const user = userEvent.setup();
        mount({ agent: DRAFT });
        const drawer = await openDrawer(user);
        expect(within(drawer).getByText('Behavior')).toBeInTheDocument();
        expect(within(drawer).queryByText('Version History')).toBeNull();
        expect(within(drawer).queryByText('Compliance')).toBeNull();
    });

    it('a behaviour toggle autosaves into the agent config', async () => {
        const user = userEvent.setup();
        route([['PUT', '/agents/agent-1', () => reply(200, { ...AGENT, rev: 4 })]]);
        mount();
        const drawer = await openDrawer(user);
        const toggle = within(drawer).getByRole('checkbox', { name: /Allow copying/ });
        expect(toggle).toBeChecked();
        await user.click(toggle);
        expect(toggle).not.toBeChecked();
        await waitFor(() => expect(calls('PUT', '/agents/agent-1').length).toBeGreaterThanOrEqual(1), { timeout: 4000 });
        expect(bodyOf(calls('PUT', '/agents/agent-1').at(-1)).config).toMatchObject({ allowCopy: false });
    });

    it('turning the public embed on asks first; Cancel changes nothing, Enable public access saves it', async () => {
        const user = userEvent.setup();
        route([['PUT', '/agents/agent-1', () => reply(200, { ...AGENT, embed_enabled: 1, rev: 4 })]]);
        mount();
        const drawer = await openDrawer(user);
        await user.click(within(drawer).getByText('Embed & bubble'));
        const toggle = within(drawer).getByRole('checkbox', { name: /Web embed/ });
        await user.click(toggle);
        const confirm = await screen.findByText('Make this agent public?');
        expect(confirm).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText('Make this agent public?')).toBeNull());
        expect(toggle).not.toBeChecked();
        expect(calls('PUT', '/agents/agent-1')).toHaveLength(0);

        await user.click(toggle);
        await user.click(await screen.findByRole('button', { name: 'Enable public access' }));
        await waitFor(() => expect(toggle).toBeChecked());
        await waitFor(() => expect(calls('PUT', '/agents/agent-1').length).toBeGreaterThanOrEqual(1), { timeout: 4000 });
        expect(bodyOf(calls('PUT', '/agents/agent-1').at(-1))).toMatchObject({ embedEnabled: true });
    });
});

describe('BuilderSplit — Schedules', () => {
    const SCHEDULE = { id: 's1', title: 'Weekly digest', agentId: 'agent-1', isActive: true, nextRunAt: null };
    const withSchedules = (): Route[] => [
        ['GET', '/api/cowork', () => reply(200, { schedules: [SCHEDULE, { ...SCHEDULE, id: 's2', title: 'Other agent', agentId: 'agent-9' }] })],
        ['DELETE', '/api/cowork/s1', () => reply(200, {})],
    ];

    it('the pill needs the entitlement and a saved agent, and counts this agent\'s active schedules', async () => {
        route(withSchedules());
        mount({}, true);
        const pill = await screen.findByRole('button', { name: /Schedules/ });
        await waitFor(() => expect(pill).toHaveTextContent('1'));
    });

    it('is absent without the entitlement, and for a draft', async () => {
        route(withSchedules());
        mount({}, false);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /Schedules/ })).toBeNull();
    });

    it('a draft with the entitlement has no Schedules pill either', async () => {
        route(withSchedules());
        mount({ agent: DRAFT }, true);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /Schedules/ })).toBeNull();
        expect(calls('GET', '/api/cowork')).toHaveLength(0);
    });

    it('deleting goes through a confirmation dialog, then DELETE and a re-read', async () => {
        const user = userEvent.setup();
        route(withSchedules());
        mount({}, true);
        await user.click(await screen.findByRole('button', { name: /Schedules/ }));
        expect(await screen.findByText('Weekly digest')).toBeInTheDocument();
        expect(screen.queryByText('Other agent')).toBeNull();
        await user.click(screen.getByTitle('Delete'));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Delete "Weekly digest"?');
        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(calls('DELETE', '/api/cowork/s1')).toHaveLength(1));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(calls('GET', '/api/cowork').length).toBeGreaterThanOrEqual(2);
    });
});

describe('BuilderSplit — the refine rail', () => {
    const REFINED = { plan: { name: 'Test Agent', description: 'A test agent', systemPrompt: 'Be brief.', capabilities: [], enabledIntegrations: [], knowledge_base_ids: [], skills: [] }, preserved: {} };

    it('Enter sends the message to /agents/wizard/refine with the tier and locale; Shift+Enter and an empty box do not', async () => {
        const user = userEvent.setup();
        route([['POST', '/agents/wizard/refine', () => reply(200, REFINED)], ['POST', '/pre-refine', () => reply(200, { id: 'v1' })]]);
        mount();
        const box = screen.getByPlaceholderText('Ask me to change anything about this agent');
        await user.type(box, '{Enter}');
        expect(calls('POST', '/agents/wizard/refine')).toHaveLength(0);
        await user.type(box, 'make it brief');
        await user.keyboard('{Shift>}{Enter}{/Shift}');
        expect(calls('POST', '/agents/wizard/refine')).toHaveLength(0);
        await user.keyboard('{Enter}');
        await waitFor(() => expect(calls('POST', '/agents/wizard/refine')).toHaveLength(1));
        expect(bodyOf(calls('POST', '/agents/wizard/refine')[0])).toMatchObject({ refinement: 'make it brief', modelTier: 'fast', locale: 'en' });
        expect(await screen.findByText('make it brief')).toBeInTheDocument();
    });

    it('a refine the server refuses shows its reason in the rail and leaves the instructions alone', async () => {
        const user = userEvent.setup();
        route([['POST', '/agents/wizard/refine', () => reply(503, { error: 'Model overloaded' })]]);
        mount();
        await user.type(screen.getByPlaceholderText('Ask me to change anything about this agent'), 'make it brief{Enter}');
        expect(await screen.findByText('Model overloaded')).toBeInTheDocument();
        expect(screen.getByText('Do the thing.')).toBeInTheDocument();
        expect(calls('PUT', '/agents/agent-1')).toHaveLength(0);
    });

    it('a malformed model answer is reported as retryable', async () => {
        const user = userEvent.setup();
        route([['POST', '/agents/wizard/refine', () => reply(422, { reason: 'plan_parse_failed' })]]);
        mount();
        await user.type(screen.getByPlaceholderText('Ask me to change anything about this agent'), 'again{Enter}');
        expect(await screen.findByText('The assistant returned malformed output. Please try again.')).toBeInTheDocument();
    });

    it('a first message handed over by the wizard is sent once, on mount', async () => {
        route([['POST', '/agents/wizard/refine', () => reply(200, REFINED)], ['POST', '/pre-refine', () => reply(200, { id: 'v1' })]]);
        mount({ initialRefinement: 'Answer in Dutch' });
        await waitFor(() => expect(calls('POST', '/agents/wizard/refine')).toHaveLength(1));
        expect(bodyOf(calls('POST', '/agents/wizard/refine')[0]).refinement).toBe('Answer in Dutch');
        expect(await screen.findByText('Answer in Dutch')).toBeInTheDocument();
    });
});
