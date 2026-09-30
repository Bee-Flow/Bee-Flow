import { describe, expect, it } from 'vitest';
import { mergeRecent } from './overviewRecent';
import { initialsOf, projectTileStyle, safeProjectColor } from './projectVisuals';
import { contentIntentOf, normalizeWorkspaceTab, roleOfProject, toWorkspaceUser } from './types';

describe('normalizeWorkspaceTab', () => {
    it('keeps a known tab and maps the old ids', () => {
        expect(normalizeWorkspaceTab('knowledge')).toBe('knowledge');
        expect(normalizeWorkspaceTab('general')).toBe('settings');
        expect(normalizeWorkspaceTab('threads')).toBe('chats');
        expect(normalizeWorkspaceTab('resources')).toBe('overview');
        expect(normalizeWorkspaceTab('memory')).toBe('knowledge');
        expect(normalizeWorkspaceTab('danger')).toBe('settings');
        expect(normalizeWorkspaceTab('nonsense')).toBe('overview');
        expect(normalizeWorkspaceTab(null)).toBe('overview');
    });
});

describe('roles and users', () => {
    it('reads role or permission and never guesses owner', () => {
        expect(roleOfProject({ id: 'p', name: 'p', role: 'owner' })).toBe('owner');
        expect(roleOfProject({ id: 'p', name: 'p', permission: 'editor' })).toBe('editor');
        expect(roleOfProject({ id: 'p', name: 'p' })).toBe('viewer');
        expect(roleOfProject(null)).toBe('viewer');
    });

    it('maps the app user, and none without an id', () => {
        expect(toWorkspaceUser({ id: 'u', displayName: 'Ada', email: 'a@example.org' })).toEqual({ id: 'u', name: 'Ada', email: 'a@example.org' });
        expect(toWorkspaceUser({ username: 'x' })).toBeNull();
    });

    it('passes only content intents to content sections', () => {
        expect(contentIntentOf('upload')).toBe('upload');
        expect(contentIntentOf('invite')).toBeNull();
        expect(contentIntentOf(undefined)).toBeNull();
    });
});

describe('projectVisuals', () => {
    it('lets only a plain hex colour into CSS', () => {
        expect(safeProjectColor('#14b8a6')).toBe('#14b8a6');
        expect(safeProjectColor('#abc')).toBe('#abc');
        expect(safeProjectColor('red) , url(https://tracker.example/x.png')).toBe('#3b82f6');
        expect(safeProjectColor(undefined)).toBe('#3b82f6');
        expect(String(projectTileStyle('url(x)').background)).not.toContain('url(');
    });

    it('makes initials', () => {
        expect(initialsOf('Ada Lovelace')).toBe('AL');
        expect(initialsOf('ada@example.org')).toBe('A');
        expect(initialsOf('')).toBe('?');
    });
});

describe('mergeRecent', () => {
    it('puts everything newest first, tolerates missing sections, and caps the list', () => {
        const entries = mergeRecent({
            teamChats: [{ id: 'c1', title: 'Standup', lastMessageAt: '2026-09-03T10:00:00Z', updatedAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }],
            threads: [{ id: 't1', type: 'direct', ownerId: 'u', title: 'Idea', updatedAt: '2026-09-04T10:00:00Z' }],
            resources: { documents: [{ id: 'd1', name: 'Brief', updatedAt: '2026-09-02T10:00:00Z' }], notebooks: null, meetings: [{ title: 'no id' }] },
        }, 2);
        expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['ai_chat:t1', 'team_chat:c1']);
        expect(entries[0]).toMatchObject({ threadType: 'direct', agentId: null });
    });
});
