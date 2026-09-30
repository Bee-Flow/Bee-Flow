import { describe, expect, it } from 'vitest';
import { isProjectsPage, projectHistoryMode, projectRouteFromPage } from './projectNavigation';

describe('projectHistoryMode', () => {
    it('writes nothing when the URL already says it', () => {
        expect(projectHistoryMode('/app/projects/p1/chats', '/app/projects/p1/chats')).toBe('none');
    });

    it('pushes a step the person took', () => {
        expect(projectHistoryMode('/app/projects', '/app/projects/p1')).toBe('push');
        expect(projectHistoryMode('/app/projects/p1/overview', '/app/projects/p1/chats')).toBe('push');
        expect(projectHistoryMode('/app/projects/p1/chats', '/app/projects/p1/chats/c1')).toBe('push');
        expect(projectHistoryMode('/app/projects/p1/chats', '/app/projects/p2/chats')).toBe('push');
    });

    it('replaces the create form with the project it created', () => {
        expect(projectHistoryMode('/app/projects/new', '/app/projects/p9')).toBe('replace');
    });

    it('replaces a workspace address that is only being normalised', () => {
        expect(projectHistoryMode('/app/projects/p1', '/app/projects/p1/overview')).toBe('replace');
        expect(projectHistoryMode('/app/projects/p1/threads', '/app/projects/p1/chats')).toBe('replace');
        expect(projectHistoryMode('/app/projects/p1/general', '/app/projects/p1/settings')).toBe('replace');
    });

    it('pushes the first step away from a bare or legacy project address', () => {
        // Only the normalised form of the SAME view replaces. Opening another
        // tab from /app/projects/p1 is a step: Back must bring the overview
        // back instead of leaving the project altogether.
        expect(projectHistoryMode('/app/projects/p1', '/app/projects/p1/chats')).toBe('push');
        expect(projectHistoryMode('/app/projects/p1', '/app/projects/p1/overview/x')).toBe('push');
        expect(projectHistoryMode('/app/projects/p1/threads', '/app/projects/p1/chats/c1')).toBe('push');
        expect(projectHistoryMode('/app/projects/p1/threads', '/app/projects/p1/documents')).toBe('push');
    });

    it('pushes when arriving from outside the projects pages', () => {
        expect(projectHistoryMode('/app', '/app/projects/p1')).toBe('push');
        expect(projectHistoryMode('/d/abcdef12', '/app/projects')).toBe('push');
    });
});

describe('projects page names', () => {
    it('recognises the projects pages and nothing else', () => {
        expect(isProjectsPage('projects')).toBe(true);
        expect(isProjectsPage('projects/p1/chats/c1')).toBe(true);
        expect(isProjectsPage('projectsx')).toBe(false);
        expect(isProjectsPage('notebooks/n1')).toBe(false);
    });

    it('reads the route out of a page name', () => {
        expect(projectRouteFromPage('projects')).toEqual({ projectId: null, tab: null, sub: null });
        expect(projectRouteFromPage('projects/new')).toEqual({ projectId: '', tab: null, sub: null });
        expect(projectRouteFromPage('projects/p1/chats/c1')).toEqual({ projectId: 'p1', tab: 'chats', sub: 'c1' });
    });
});
