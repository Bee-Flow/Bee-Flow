// Test kit for the MCP library (components/mcpLibrary, pages/settings/OrgMcpConnections).
//
// A test mocks `utils/helpers` with a hoisted `authFetch` mock and hands it to
// `fakeBackend`, so every request goes through the REAL apiClient and the real
// McpLibraryError mapping; what a test pins is what the screen sends and what
// it shows back. Fixtures are the wire shapes from api/queries/mcpLibrary.ts.

import type { vi } from 'vitest';
import type {
    CatalogEntry, InstalledServer, McpLibrary, McpTool, PolicyPayload, ServerWideServer,
} from '../api/queries/mcpLibrary';

type FetchMock = ReturnType<typeof vi.fn>;

export interface Sent { method: string; path: string; body: unknown }
export interface Reply { status?: number; body?: unknown }
type Answer = Reply | ((body: unknown) => Reply | Promise<Reply>);

function response({ status = 200, body = {} }: Reply): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/**
 * Routes `METHOD /path` to an answer. An unrouted request answers 404 with a
 * sentence naming it, so a test that forgot a route fails on screen, loudly.
 */
export function fakeBackend(fetchMock: FetchMock) {
    const sent: Sent[] = [];
    const routes = new Map<string, Answer>();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        const path = String(url).split('?')[0];
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        sent.push({ method, path, body });
        const answer = routes.get(`${method} ${path}`);
        if (!answer) return response({ status: 404, body: { error: `No fake route for ${method} ${path}` } });
        return response(typeof answer === 'function' ? await answer(body) : answer);
    });
    const api = {
        sent,
        on(method: string, path: string, answer: Answer) {
            routes.set(`${method} ${path}`, answer);
            return api;
        },
        /** The JSON bodies sent to one route, oldest first. */
        bodies(method: string, path: string): unknown[] {
            return sent.filter(s => s.method === method && s.path === path).map(s => s.body);
        },
    };
    return api;
}

/** A promise the test settles by hand, to look at a screen mid-request. */
export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

export const ORG_PATH = '/api/mcp-library/org';
export const POLICY_PATH = '/api/mcp-library/policy';

export const GROUPS = [
    { id: 'g-eng', name: 'Engineering' },
    { id: 'g-sales', name: 'Sales' },
];

export function tool(name: string, over: Partial<McpTool> = {}): McpTool {
    return { name, description: `Runs ${name}`, readOnly: null, destructive: null, ...over };
}

export function catalogEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
    return {
        id: 'linear',
        name: 'Linear',
        description: 'Issues, projects and cycles.',
        category: 'development',
        url: 'https://mcp.linear.app/mcp',
        host: 'mcp.linear.app',
        selfHosted: false,
        authStyle: 'bearer',
        credential: { key: 'LINEAR_API_KEY', label: 'Linear API key', help: null, helpUrl: null },
        homepage: null,
        docsUrl: null,
        repository: null,
        safetyNote: null,
        allowed: true,
        installedIds: [],
        ...over,
    };
}

export function installedServer(over: Partial<InstalledServer> = {}): InstalledServer {
    return {
        id: 'srv-sentry',
        name: 'Sentry',
        description: 'Errors and performance.',
        catalogId: null,
        docsUrl: null,
        url: 'https://mcp.sentry.dev/mcp',
        host: 'mcp.sentry.dev',
        official: true,
        status: 'active',
        blockedByPolicy: false,
        blockedReason: null,
        authStyle: 'bearer',
        credential: { key: 'SENTRY_TOKEN', label: 'Sentry token' },
        credentialMode: 'shared',
        tools: [
            tool('list_issues', { readOnly: true, enabled: true }),
            tool('update_issue', { readOnly: false, enabled: true }),
            tool('delete_project', { readOnly: false, destructive: true, enabled: false }),
        ],
        enabledToolCount: 2,
        access: { mode: 'everyone', groupIds: [] },
        installedAt: null,
        installedBy: null,
        ...over,
    };
}

export function serverWide(over: Partial<ServerWideServer> = {}): ServerWideServer {
    return {
        id: 'github',
        capId: 'mcp:github',
        name: 'GitHub',
        description: 'Repositories, issues and pull requests.',
        icon: null,
        category: 'development',
        runsOn: 'server',
        status: 'ready',
        tools: [{ name: 'search_code', description: 'Search code' }],
        toolCount: 1,
        credentials: [],
        available: true,
        access: { mode: 'everyone', groupIds: [] },
        ...over,
    };
}

/**
 * An organisation with one installed server, one server-wide server in use
 * and one idle, and a catalogue over three categories with one entry the
 * policy does not allow.
 */
export function library(over: Partial<McpLibrary> = {}): McpLibrary {
    return {
        policy: { remote: 'official', allowsCustomUrls: false, allowedHosts: [] },
        isServerAdmin: false,
        catalog: [
            catalogEntry(),
            catalogEntry({ id: 'stripe', name: 'Stripe', description: 'Payments and invoices.', category: 'payments', url: 'https://mcp.stripe.com', host: 'mcp.stripe.com' }),
            catalogEntry({ id: 'context_docs', name: 'Context Docs', description: 'Library documentation.', category: 'docs', url: 'https://mcp.context.example/mcp', host: 'mcp.context.example', authStyle: 'none', credential: null }),
            catalogEntry({ id: 'gitlab_self', name: 'Self-hosted GitLab', description: 'Your own GitLab instance.', url: 'https://gitlab.example.com/api/v4/mcp', host: null, selfHosted: true, allowed: false }),
        ],
        installed: [installedServer()],
        serverWide: [
            serverWide(),
            serverWide({ id: 'fetch', capId: 'mcp:fetch', name: 'Fetch', description: 'Read web pages.', runsOn: 'remote', access: { mode: 'nobody', groupIds: [] } }),
        ],
        groups: GROUPS,
        ...over,
    };
}

export function policyPayload(over: Partial<PolicyPayload['policy']> = {}): PolicyPayload {
    return {
        policy: { remote: 'official', allowedHosts: ['mcp.acme.example'], ...over },
        modes: ['off', 'official', 'allowlist', 'any'],
        officialHosts: ['mcp.linear.app', 'mcp.stripe.com'],
    };
}
