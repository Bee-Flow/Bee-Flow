// Test support for the workspace shell: a tiny fake of the HTTP API behind
// `authFetch`, so tests exercise the real query hooks and apiClient instead
// of mocking each hook. Imported only by *.test.tsx files.

import type { Project, ProjectMembers } from '../../../api/queries/projects';

export interface FakeCall {
    method: string;
    path: string;
    query: URLSearchParams;
    body: unknown;
}

interface Reply { __status: number; body?: unknown }

type RouteValue = unknown | Reply | ((call: FakeCall) => unknown | Reply | Promise<unknown | Reply>);

/** A non-2xx answer: `reply(409, { error: '…' })`. */
export const reply = (status: number, body?: unknown): Reply => ({ __status: status, body });

const isReply = (v: unknown): v is Reply => !!v && typeof v === 'object' && '__status' in (v as object);

function respond(status: number, body: unknown) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body ?? null),
    };
}

/**
 * `routes` maps "METHOD /path" (no query string) to a body, a reply(), or a
 * function of the call. An unknown route answers 404, like the server would.
 */
export function makeFakeApi(routes: Record<string, RouteValue>) {
    const calls: FakeCall[] = [];
    const fetchImpl = async (url: string, init: { method?: string; body?: unknown } = {}) => {
        const u = new URL(url, 'http://test.local');
        const method = (init.method || 'GET').toUpperCase();
        const call: FakeCall = {
            method,
            path: u.pathname,
            query: u.searchParams,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const route = routes[`${method} ${u.pathname}`];
        if (route === undefined) return respond(404, { error: 'Not found' });
        const out = typeof route === 'function' ? await (route as (c: FakeCall) => unknown)(call) : route;
        return isReply(out) ? respond(out.__status, out.body) : respond(200, out);
    };
    const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
    return { calls, callsTo, fetchImpl, routes };
}

export const OWNER_ID = '11111111-1111-4111-8111-111111111111';
export const EDITOR_ID = '22222222-2222-4222-8222-222222222222';
export const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
export const GROUP_ID = '44444444-4444-4444-8444-444444444444';

export function makeProject(over: Partial<Project> = {}): Project {
    return {
        id: 'p1',
        name: 'Launch plan',
        description: 'Everything for the autumn launch',
        customInstructions: 'Answer briefly.',
        color: '#14b8a6',
        icon: '🚀',
        knowledgeBaseIds: [],
        extractMemories: false,
        ownerId: OWNER_ID,
        kind: 'workspace',
        role: 'owner',
        version: 3,
        updatedAt: new Date().toISOString(),
        ...over,
    };
}

export function makeMembers(over: Partial<ProjectMembers> = {}): ProjectMembers {
    return {
        ownerId: OWNER_ID,
        members: [
            { id: 's-editor', sharedWithType: 'user', sharedWithId: EDITOR_ID, permission: 'editor' },
            { id: 's-viewer', sharedWithType: 'user', sharedWithId: VIEWER_ID, permission: 'viewer' },
            { id: 's-group', sharedWithType: 'group', sharedWithId: GROUP_ID, permission: 'viewer' },
        ],
        people: {
            // Names only: the member list never carries an e-mail address.
            [OWNER_ID]: { name: 'Olivia Owner' },
            [EDITOR_ID]: { name: 'Eddie Editor' },
            [VIEWER_ID]: { name: 'Vera Viewer' },
        },
        groups: { [GROUP_ID]: { name: 'Marketing' } },
        ...over,
    };
}
