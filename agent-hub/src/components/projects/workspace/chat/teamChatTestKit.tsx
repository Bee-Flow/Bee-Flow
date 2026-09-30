// Test kit for the team chat tests: a tiny in-memory router behind the mocked
// authFetch, and a render helper that mounts the project's live provider so a
// test can push feed events the way the server's stream would.
//
// Each test file still declares its own vi.mock calls (they are hoisted per
// file); this module only builds on the mocks it is handed.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import React from 'react';
import type { Mock } from 'vitest';
import { ProjectLiveProvider } from '../ProjectLiveContext';

export interface Call { method: string; path: string; query: Record<string, string>; body: any }
export interface Reply { status?: number; body?: unknown }
export type Handler = (req: { query: Record<string, string>; body: any; path: string }) => unknown;

const json = (body: unknown, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
});

/** `reply(409, {...})` inside a handler answers with a status; anything else is a 200 body. */
export function reply(status: number, body?: unknown): Reply & { __reply: true } {
    return { status, body, __reply: true };
}

export interface TestServer {
    calls: Call[];
    /** Answer `METHOD path` with a handler's result, or with a fixed value. */
    on(method: string, path: string, handler: Handler): TestServer;
    on(method: string, path: string, value: unknown): TestServer;
    called(method: string, path: string): Call[];
}

export function installServer(fetchMock: Mock): TestServer {
    const routes = new Map<string, Handler>();
    const calls: Call[] = [];
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
        const u = new URL(url, 'http://test.local');
        const method = (init.method || 'GET').toUpperCase();
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        const query = Object.fromEntries(u.searchParams.entries());
        calls.push({ method, path: u.pathname, query, body });
        const handler = routes.get(`${method} ${u.pathname}`);
        if (!handler) return json({ error: 'Not found' }, 404);
        const out = await handler({ query, body, path: u.pathname });
        if (out && typeof out === 'object' && (out as { __reply?: boolean }).__reply) {
            const r = out as Reply;
            return json(r.body ?? {}, r.status ?? 200);
        }
        return json(out ?? {});
    });
    const server: TestServer = {
        calls,
        on(method: string, path: string, handler: unknown) {
            routes.set(`${method.toUpperCase()} ${path}`, typeof handler === 'function' ? handler as Handler : () => handler);
            return server;
        },
        called(method: string, path: string) {
            return calls.filter(c => c.method === method.toUpperCase() && c.path === path);
        },
    };
    return server;
}

/** Holder the mocked useProjectStream writes its onEvent into. */
export interface StreamHolder { onEvent: ((kind: string, event: unknown) => void) | null }

export function testClient() {
    return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function renderLive(ui: React.ReactElement, { projectId = 'p1', currentUserId = 'u-me', client = testClient() } = {}) {
    const result = render(
        <QueryClientProvider client={client}>
            <ProjectLiveProvider projectId={projectId} currentUserId={currentUserId}>{ui}</ProjectLiveProvider>
        </QueryClientProvider>,
    );
    return { ...result, client };
}

/** Deliver one feed event to the page, as the stream would. */
export function emit(stream: StreamHolder, kind: string, event: Record<string, unknown> = {}) {
    act(() => { stream.onEvent?.(kind, { kind, ...event }); });
}

export const PROJECT = { id: 'p1', name: 'Launch plan', role: 'editor' as const, kind: 'workspace' as const };

export const MEMBERS = {
    ownerId: 'u-owner',
    members: [
        { id: 's1', sharedWithType: 'user', sharedWithId: 'u-me', permission: 'editor' },
        { id: 's2', sharedWithType: 'user', sharedWithId: 'u-ada', permission: 'editor' },
        { id: 's3', sharedWithType: 'user', sharedWithId: 'u-ben', permission: 'viewer' },
    ],
    people: {
        'u-owner': { name: 'Olivia Owner' },
        'u-me': { name: 'Tom Me' },
        'u-ada': { name: 'Ada Lovelace' },
        'u-ben': { name: 'Ben Viewer' },
    },
    groups: {},
};

export function teamChat(over: Record<string, unknown> = {}) {
    return {
        id: 'c1', title: 'Kick-off', aiMode: 'mention', agentId: null, createdBy: 'u-ada', archived: false,
        messageCount: 2, lastMessageAt: '2026-09-29T10:00:00.000Z', lastMessage: null, unread: 0,
        createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z', ...over,
    };
}

export function message(seq: number, over: Record<string, unknown> = {}) {
    return {
        id: `m${seq}`, seq, authorKind: 'user', authorUserId: 'u-ada', agentId: null, content: `Message ${seq}`,
        mentions: [], replyTo: null, createdAt: new Date(Date.now() - (100 - seq) * 60_000).toISOString(),
        editedAt: null, deleted: false, ...over,
    };
}
