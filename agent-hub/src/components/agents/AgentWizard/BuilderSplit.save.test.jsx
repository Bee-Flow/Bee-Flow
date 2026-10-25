/**
 * Characterisation tests for BuilderSplit's own data paths: the standalone
 * bootstrap, the explicit first save of a draft, "Publish" (publish-version)
 * and the 409 reconcile (Keep mine / Load latest). They pin the requests the
 * editor sends and what the screen shows afterwards, so moving these paths
 * into hooks (./builderSplit/) cannot change them unnoticed.
 *
 * Run: cd agent-hub && npx vitest run src/components/agents/AgentWizard/BuilderSplit.save.test.jsx
 */
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' })),
    parseSaveError: vi.fn(async () => ({ message: 'save failed' })),
}));
vi.mock('../../../api/queries/automation/agentBindings', () => ({
    useLinkedAutomationIds: () => ({ data: undefined }),
}));
vi.mock('../../renderers/MarkdownRenderer', () => ({
    default: ({ content }) => <div data-testid="markdown">{content}</div>,
}));

import { renderWithClient as render } from '@/test/render';
import BuilderSplit from './BuilderSplit';
import { authFetch } from '../../../utils/helpers';

const DEFAULT_FETCH = authFetch.getMockImplementation();
afterEach(() => { cleanup(); authFetch.mockImplementation(DEFAULT_FETCH); authFetch.mockClear(); });

const agent = {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent',
    system_prompt: 'Do the thing.',
    is_published: 0,
    config: {},
    updated_at: '2026-08-01T10:00:00Z',
    rev: 3,
};
const baseProps = { agent, plan: null, history: [], tier: 'fast', locale: 'en', onBack: () => {}, onPublished: () => {} };

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => '' });
/** routes: [method, urlPart, (opts, n) => response]; first match wins; n counts hits on that route. */
function routeFetch(routes) {
    const hits = new Map();
    authFetch.mockImplementation(async (url, opts = {}) => {
        const method = opts.method || 'GET';
        for (const [m, part, fn] of routes) {
            if (m === method && String(url).includes(part)) {
                const n = (hits.get(part + m) || 0) + 1;
                hits.set(part + m, n);
                return fn(opts, n);
            }
        }
        return reply(500, {});
    });
}
const calls = (method, part) => authFetch.mock.calls
    .filter(([url, opts]) => (opts?.method || 'GET') === method && String(url).includes(part));

// The component reads through react-query: every render gets its own client.

describe('BuilderSplit — standalone bootstrap', () => {
    it('reads the six pickers sources in this order when no provider is mounted', async () => {
        render(<BuilderSplit {...baseProps} />);
        await waitFor(() => expect(authFetch.mock.calls.length).toBeGreaterThanOrEqual(6));
        const urls = authFetch.mock.calls.map(([u]) => String(u));
        const boot = ['/api/skills', '/ai/user-settings', '/agents/categories', '/auth/groups',
            '/ai/config/tiers-for-user?taskType=direct_chat', '/automation'];
        const idx = boot.map(b => urls.indexOf(b));
        expect(idx.every(i => i >= 0)).toBe(true);
        expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    });
});

describe('BuilderSplit — first save of a draft', () => {
    it('POSTs the full snapshot to /agents and hands the created agent to onPublished', async () => {
        const onPublished = vi.fn();
        routeFetch([
            ['POST', '/agents', (opts) => reply(201, { ...JSON.parse(opts.body), id: 'new-1', rev: 1, system_prompt: 'Draft prompt' })],
        ]);
        const draft = { name: 'Draft', description: 'D', system_prompt: 'Draft prompt', config: { memoryEnabled: false } };
        render(<BuilderSplit {...baseProps} agent={draft} onPublished={onPublished} />);
        await userEvent.click(screen.getByTestId('agent-save-draft'));
        await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
        const posts = calls('POST', '/agents').filter(([u]) => u === '/agents');
        expect(posts).toHaveLength(1);
        const body = JSON.parse(posts[0][1].body);
        expect(body).toEqual({
            name: 'Draft', description: 'D', systemPrompt: 'Draft prompt', model: '', categoryId: null,
            embedEnabled: false, avatar: expect.any(String), config: { memoryEnabled: false },
        });
        expect(onPublished.mock.calls[0][0].id).toBe('new-1');
        // The draft button is gone: the agent now has an id, so the publish pill shows.
        await waitFor(() => expect(screen.queryByTestId('agent-save-draft')).toBeNull());
    });
});

describe('BuilderSplit — publish-version', () => {
    it('POSTs /agents/:id/publish-version and shows the version the server names', async () => {
        routeFetch([
            ['POST', '/agents/agent-1/publish-version', () => reply(200, { publishedVersion: 7 })],
        ]);
        render(<BuilderSplit {...baseProps} />);
        expect(screen.queryByTestId('agent-version-chip')).toBeNull();
        await userEvent.click(screen.getByText('Publish'));
        await waitFor(() => expect(screen.getByTestId('agent-version-chip').textContent).toContain('7'));
        expect(calls('POST', '/agents/agent-1/publish-version')).toHaveLength(1);
    });

    it('keeps the old version when the answer names none', async () => {
        routeFetch([
            ['POST', '/agents/agent-1/publish-version', () => reply(200, {})],
        ]);
        render(<BuilderSplit {...baseProps} agent={{ ...agent, published_version: 2 }} />);
        await userEvent.click(screen.getByText('Publish new version'));
        await waitFor(() => expect(calls('POST', '/agents/agent-1/publish-version')).toHaveLength(1));
        expect(screen.getByTestId('agent-version-chip').textContent).toContain('2');
    });
});

describe('BuilderSplit — 409 reconcile', () => {
    const SERVER = { ...agent, name: 'Server Name', system_prompt: 'Server prompt', rev: 9 };

    it('"Keep mine" re-sends the local snapshot with the server version as base', async () => {
        routeFetch([
            ['PUT', '/agents/agent-1', (_o, n) => (n === 1 ? reply(409, { currentVersion: 9, agent: SERVER }) : reply(200, { ...agent, name: 'Mine', rev: 10 }))],
        ]);
        render(<BuilderSplit {...baseProps} />);
        const input = screen.getByDisplayValue('Test Agent');
        await userEvent.clear(input);
        await userEvent.type(input, 'Mine');
        await screen.findByText('Keep mine', {}, { timeout: 3000 });
        expect(JSON.parse(calls('PUT', '/agents/agent-1')[0][1].body).baseVersion).toBe(3);
        await userEvent.click(screen.getByText('Keep mine'));
        await waitFor(() => expect(screen.queryByText('Keep mine')).toBeNull());
        const puts = calls('PUT', '/agents/agent-1');
        // Typing may land more than one guarded save before the modal; the
        // overwrite is the LAST PUT and the only one on the server's version.
        expect(puts.filter(([, o]) => JSON.parse(o.body).baseVersion === 9)).toHaveLength(1);
        const body = JSON.parse(puts[puts.length - 1][1].body);
        expect(body.baseVersion).toBe(9);
        expect(body.name).toBe('Mine');
    });

    it('"Load latest" re-reads the agent and shows the server copy', async () => {
        routeFetch([
            ['PUT', '/agents/agent-1', () => reply(409, { currentVersion: 9, agent: SERVER })],
            ['GET', '/agents/agent-1', () => reply(200, SERVER)],
        ]);
        render(<BuilderSplit {...baseProps} />);
        const input = screen.getByDisplayValue('Test Agent');
        await userEvent.clear(input);
        await userEvent.type(input, 'Mine');
        await screen.findByText('Load latest', {}, { timeout: 3000 });
        await userEvent.click(screen.getByText('Load latest'));
        await waitFor(() => expect(screen.queryByText('Load latest')).toBeNull());
        expect(calls('GET', '/agents/agent-1').filter(([u]) => u === '/agents/agent-1')).toHaveLength(1);
        expect(screen.getByDisplayValue('Server Name')).toBeTruthy();
    });
});
