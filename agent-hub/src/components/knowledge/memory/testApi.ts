/** A tiny in-memory stand-in for /agents/memory, shared by the memory tests. */
import { vi } from 'vitest';

import type { Memory } from './memoryTypes';

export const mem = (over: Partial<Memory> & { id: string }): Memory => ({
    type: 'fact', content: `content ${over.id}`, summary: null, importance: 0.5, origin: 'explicit', sensitivity: 'none',
    status: 'active', agent_id: null, agent_name: null, project_id: null, project_name: null,
    source_conversation_id: null, source_conversation_kind: null,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', valid_from: null,
    last_used_at: null, use_count: 0, ...over,
});

export const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

export interface Call { method: string; path: string; query: URLSearchParams; body: unknown; hasBody: boolean }
type Handler = (call: Call) => ReturnType<typeof respond> | Promise<ReturnType<typeof respond>>;

export function mockApi(routes: Record<string, Handler> = {}) {
    const calls: Call[] = [];
    const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname.replace(/^.*\/agents\/memory/, '') || '/';
        const method = (init?.method ?? 'GET').toUpperCase();
        const call: Call = {
            method, path, query: url.searchParams,
            body: init?.body ? JSON.parse(String(init.body)) : undefined, hasBody: init?.body != null,
        };
        calls.push(call);
        const handler = routes[`${method} ${path}`];
        if (handler) return handler(call) as unknown as Response;
        if (method === 'GET' && path === '/stats') {
            return respond({ total: 2, typeDistribution: { labels: ['preference', 'fact'], data: [1, 1] }, pendingReview: 0 }) as unknown as Response;
        }
        return respond({}) as unknown as Response;
    });
    return {
        calls, spy,
        find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
        lastList: () => [...calls].reverse().find((c) => c.method === 'GET' && (c.path === '/' || c.path === '' || c.path === '/review')),
    };
}

export const page = (items: Memory[], extra: Record<string, unknown> = {}) =>
    respond({ items, total: items.length, limit: 50, offset: 0, ...extra });
