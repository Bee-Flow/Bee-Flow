// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseProjectUrl, projectRoutePath } from './projectRoutes';

describe('parseProjectUrl', () => {
    it('is null for non-project paths', () => {
        expect(parseProjectUrl('/app')).toBeNull();
        expect(parseProjectUrl('/app/notebooks/abc')).toBeNull();
        // Prefix match must not swallow a sibling route.
        expect(parseProjectUrl('/app/projectsomething')).toBeNull();
    });

    it('reads the list route', () => {
        expect(parseProjectUrl('/app/projects')).toEqual({ projectId: null, tab: null, sub: null });
        expect(parseProjectUrl('/app/projects/')).toEqual({ projectId: null, tab: null, sub: null });
    });

    it('reads the create route as the empty-string sentinel', () => {
        // Distinct from the list (null) — that collapse is what broke the
        // "New Project" button.
        expect(parseProjectUrl('/app/projects/new')).toEqual({ projectId: '', tab: null, sub: null });
    });

    it('reads a project and its tab', () => {
        expect(parseProjectUrl('/app/projects/abc-123')).toEqual({ projectId: 'abc-123', tab: null, sub: null });
        expect(parseProjectUrl('/app/projects/abc-123/threads')).toEqual({ projectId: 'abc-123', tab: 'threads', sub: null });
    });

    it('reads an item inside a section', () => {
        expect(parseProjectUrl('/app/projects/abc-123/chats/chat-9')).toEqual({ projectId: 'abc-123', tab: 'chats', sub: 'chat-9' });
    });
});

describe('projectRoutePath', () => {
    it('round-trips every destination', () => {
        for (const [id, tab, sub, path] of [
            [null, null, null, '/app/projects'],
            [undefined, null, null, '/app/projects'],
            ['', null, null, '/app/projects/new'],
            ['abc-123', null, null, '/app/projects/abc-123'],
            ['abc-123', 'threads', null, '/app/projects/abc-123/threads'],
            ['abc-123', 'chats', 'chat-9', '/app/projects/abc-123/chats/chat-9'],
        ]) {
            expect(projectRoutePath(id, tab, sub)).toBe(path);
            expect(parseProjectUrl(path)).toEqual({ projectId: id ?? null, tab: tab || null, sub: sub || null });
        }
    });

    it('drops a sub item that has no section to live in', () => {
        expect(projectRoutePath('abc-123', null, 'chat-9')).toBe('/app/projects/abc-123');
    });
});
