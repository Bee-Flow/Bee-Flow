/**
 * apiPath turns an operation key of the server's contract into the path the
 * client sends. The compile-time half (an unknown key, a missing or misspelled
 * parameter) is pinned with `@ts-expect-error`: `npm run typecheck` fails when
 * one of those lines stops being an error.
 */

import { apiPath, type ApiBody } from './apiPath';
import type { ApiOperationKey } from './apiTypes.generated';

describe('apiPath', () => {
    it('is the path template without the method when there are no parameters', () => {
        expect(apiPath('GET /api/skills')).toBe('/api/skills');
        expect(apiPath('POST /api/skills/ai/draft')).toBe('/api/skills/ai/draft');
        expect(apiPath('GET /auth/groups')).toBe('/auth/groups');
    });

    it('fills each {name} with its encoded value', () => {
        expect(apiPath('GET /api/skills/{id}/usage', { id: 'sk1' })).toBe('/api/skills/sk1/usage');
        expect(apiPath('GET /api/skills/{id}', { id: 'a b/c?d' })).toBe('/api/skills/a%20b%2Fc%3Fd');
        expect(apiPath('PUT /api/skills/{id}', { id: 7 })).toBe('/api/skills/7');
    });

    it('fills several parameters, each from its own name', () => {
        const path = apiPath('PATCH /api/solution-stages/{stageProjectId}/parts/{ref}', { stageProjectId: 'p 1', ref: 'agent:9' });
        expect(path).toBe('/api/solution-stages/p%201/parts/agent%3A9');
    });

    it('throws rather than send a path with a hole in it', () => {
        const untyped = apiPath as (key: ApiOperationKey, params?: Record<string, string>) => string;
        expect(() => untyped('GET /api/skills/{id}', {})).toThrow('needs the path parameter "id"');
        expect(() => untyped('GET /api/skills/{id}')).toThrow('needs the path parameter "id"');
    });

    it('refuses, at compile time, a route the server does not mount and parameters that do not fit', () => {
        const wrong = [
            // @ts-expect-error not an operation of the server
            () => apiPath('GET /api/skils'),
            // @ts-expect-error the method is part of the key: this route has no PATCH
            () => apiPath('PATCH /api/skills/{id}', { id: 'sk1' }),
            // @ts-expect-error the path has a parameter, so it must be given
            () => apiPath('GET /api/skills/{id}'),
            // @ts-expect-error the parameter is called `id`
            () => apiPath('GET /api/skills/{id}', { skillId: 'sk1' }),
            // @ts-expect-error a path without parameters takes none
            () => apiPath('GET /api/skills', { id: 'sk1' }),
        ];
        expect(wrong).toHaveLength(5);
    });

    it('types a request body from the route schema', () => {
        const body: ApiBody<'POST /api/skills/{id}/examples/from-message'> = { conversationId: 'c1', messageIndex: 2 };
        // @ts-expect-error messageIndex is a number in the route's schema
        const mistyped: ApiBody<'POST /api/skills/{id}/examples/from-message'> = { conversationId: 'c1', messageIndex: '2' };
        expect([body.messageIndex, mistyped.conversationId]).toEqual([2, 'c1']);
    });
});
