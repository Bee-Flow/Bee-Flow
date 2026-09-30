import { describe, expect, it } from 'vitest';
import type { ProjectActivityItem } from '../../../api/queries/projects';
import { activityCategory, changeMeta, describeActivity, isContentChange, type ActivityNames } from './activityText';

// The English fallback, interpolated: what t() renders before the catalogue loads.
const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? `{${k}}`));

const names: ActivityNames = {
    person: (id) => ({ u1: 'Ada', u2: 'Ben' } as Record<string, string>)[id || ''] || null,
    group: (id) => (id === 'g1' ? 'Marketing' : null),
    currentUserId: 'me',
};

const item = (action: string, over: Partial<ProjectActivityItem> = {}): ProjectActivityItem => ({
    id: 'a1', action, actorId: 'u1', createdAt: '2026-09-01T10:00:00Z', ...over,
});

describe('describeActivity', () => {
    it.each([
        ['project_created', {}, 'Ada created the project'],
        ['instructions_updated', {}, 'Ada updated the instructions for the AI'],
        ['member_added', { targetType: 'user', targetId: 'u2', details: { role: 'editor' } }, 'Ada invited Ben as editor'],
        ['member_added', { targetType: 'group', targetId: 'g1', details: { role: 'viewer' } }, 'Ada invited Marketing as viewer'],
        ['member_removed', { details: { selfLeave: true } }, 'Ada left the project'],
        ['member_removed', { targetType: 'user', targetId: 'gone' }, 'Ada removed someone'],
        ['member_role_changed', { targetType: 'user', targetId: 'me', details: { from: 'viewer', to: 'editor' } }, 'Ada changed the role of you to editor'],
        ['resource_added', { targetType: 'document' }, 'Ada added a document'],
        ['resource_removed', { targetType: 'meeting' }, 'Ada removed a meeting from the project'],
        ['file.added', { details: { name: 'brief.pdf' } }, 'Ada uploaded “brief.pdf”'],
        ['file.removed', {}, 'Ada deleted a file'],
        ['file.removed', { targetType: 'file', targetId: 'f1', details: { targetType: 'file', targetId: 'f1', name: 'brief.pdf' } }, 'Ada deleted the file “brief.pdf”'],
        // Team chat rows carry the chat id only: the title is encrypted with
        // the project key and never reaches the activity log (the earlier
        // "started the team chat “<title>”" sentence could never be written).
        ['chat.created', { targetType: 'project_chat', targetId: 'c1', details: { targetType: 'project_chat', targetId: 'c1' } }, 'Ada started a team chat'],
        ['chat.deleted', { targetType: 'project_chat', targetId: 'c1' }, 'Ada deleted a team chat'],
        ['kind_set', { details: { kind: 'solution' } }, 'Ada marked this as a Studio Solution'],
        ['thread_shared', {}, 'Ada shared an AI chat with the project'],
        ['kind_set', { details: { kind: 'workspace' } }, 'Ada kept this as a project'],
        ['automation.run.failed', { details: { automationTitle: 'Nightly sync' } }, 'Nightly sync failed'],
        ['approval.requested', { actorId: undefined }, 'An approval was requested'],
    ] as Array<[string, Partial<ProjectActivityItem>, string]>)('%s → %s', (action, over, expected) => {
        expect(describeActivity(item(action, over), names, t)).toBe(expected);
    });

    it('says "You" for the caller and "Someone" for a former member', () => {
        expect(describeActivity(item('kb_added', { actorId: 'me' }), names, t)).toBe('You linked a knowledge base');
        expect(describeActivity(item('kb_added', { actorId: 'left-long-ago' }), names, t)).toBe('Someone linked a knowledge base');
    });

    it('keeps an unknown kind readable instead of dropping it', () => {
        expect(describeActivity(item('something.new'), names, t)).toBe('Ada made a change (something.new)');
    });
});

describe('describeActivity — content changes', () => {
    it.each([
        ['content.edited', { targetType: 'document', title: 'Launch brief' }, 'Ada edited “Launch brief”'],
        ['content.edited', { targetType: 'notebook' }, 'Ada edited a notebook'],
        ['content.edited', { targetType: 'document', title: 'Brief', details: { aiAssisted: true } }, 'Ada edited “Brief” with AI'],
        ['content.edited', { actorId: undefined, actorKind: 'ai', targetType: 'document', title: 'Brief', details: { aiAssisted: true } }, 'The AI edited “Brief”'],
        ['content.created', { targetType: 'notebook', title: 'Interviews' }, 'Ada created “Interviews”'],
        ['content.renamed', { targetType: 'document' }, 'Ada renamed a document'],
        ['content.moved_in', { targetType: 'meeting', title: 'Kick-off' }, 'Ada moved “Kick-off” into the project'],
        ['content.moved_out', { targetType: 'document' }, 'Ada moved a document out of the project'],
        ['content.restored', { targetType: 'document', title: 'Plan' }, 'Ada restored an earlier version of “Plan”'],
        ['content.version_named', { targetType: 'notebook', title: 'Notes' }, 'Ada named a version of “Notes”'],
        // The coarse co-editing events arrive from the live feed with a resource, not a title.
        ['doc.edited', { details: { resource: { kind: 'notebook', id: 'n1' } } }, 'Ada edited a notebook'],
        ['doc.restored', { details: { itemType: 'document' } }, 'Ada restored an earlier version of a document'],
        ['content.edited', { actorId: undefined, actorKind: 'system', targetType: 'document' }, 'Someone edited a document'],
    ] as Array<[string, Record<string, unknown>, string]>)('%s → %s', (action, over, expected) => {
        expect(describeActivity(item(action, over as Partial<ProjectActivityItem>), names, t)).toBe(expected);
    });

    it('adds counts to an editing session, and nothing to other entries', () => {
        expect(changeMeta(item('content.edited', { details: { stats: { wordsAdded: 12, wordsRemoved: 3 }, changes: 4 } }), t)).toBe('+12 words · −3 words · 4 saves');
        expect(changeMeta(item('content.edited', { details: { stats: { wordsAdded: 0, wordsRemoved: 0 }, changes: 1 } }), t)).toBeNull();
        expect(changeMeta(item('kb_added'), t)).toBeNull();
    });

    it('knows which entries are content changes', () => {
        expect(isContentChange('content.edited')).toBe(true);
        expect(isContentChange('doc.edited')).toBe(true);
        expect(isContentChange('resource_added')).toBe(false);
        expect(activityCategory('content.renamed')).toBe('content');
        expect(activityCategory('doc.edited')).toBe('content');
    });
});

describe('describeActivity — comments', () => {
    it.each([
        // The activity row names the thread; the notebook or document it is on is in the details.
        ['comment.thread.created', { targetType: 'comment_thread', targetId: 't1', details: { targetType: 'comment_thread', targetId: 't1', itemType: 'notebook', itemId: 'n1' } }, 'Ada commented on a notebook'],
        // A live event carries the commented item as payload.targetType.
        ['comment.created', { targetType: 'comment_thread', details: { threadId: 't1', targetType: 'document', targetId: 'd1' } }, 'Ada replied to a comment on a document'],
        ['comment.created', { actorId: undefined, actorKind: 'ai', details: { targetType: 'notebook' } }, 'The AI replied to a comment on a notebook'],
        ['comment.updated', { details: { targetType: 'document' } }, 'Ada edited a comment on a document'],
        ['comment.deleted', { details: { targetType: 'document' } }, 'Ada deleted a comment on a document'],
        ['comment.resolved', { details: { targetType: 'notebook' } }, 'Ada resolved a comment thread on a notebook'],
        ['comment.reopened', { actorId: 'me', details: { targetType: 'notebook' } }, 'You reopened a comment thread on a notebook'],
        ['comment.thread.deleted', { details: { targetType: 'document' } }, 'Ada deleted a comment thread on a document'],
        ['comment.thread.updated', { details: { targetType: 'document', aiMode: 'auto' } }, 'Ada changed how the AI takes part in a comment thread on a document'],
        ['comment.mention', { details: { targetType: 'notebook', mentionedUserIds: ['u2'] } }, 'Ada mentioned someone in a comment on a notebook'],
        ['comment.thread.created', { details: {} }, 'Ada commented on an item'],
    ] as Array<[string, Record<string, unknown>, string]>)('%s → %s', (action, over, expected) => {
        expect(describeActivity(item(action, over as Partial<ProjectActivityItem>), names, t)).toBe(expected);
    });

    it('files comments under content, and not as changes to the content itself', () => {
        expect(activityCategory('comment.thread.created')).toBe('content');
        expect(isContentChange('comment.created')).toBe(false);
    });
});

describe('activityCategory', () => {
    it('sorts every kind into one filter', () => {
        expect(activityCategory('member_added')).toBe('people');
        expect(activityCategory('chat.created')).toBe('chats');
        expect(activityCategory('thread_unshared')).toBe('chats');
        expect(activityCategory('file.added')).toBe('content');
        expect(activityCategory('resource_added')).toBe('content');
        expect(activityCategory('automation.run.started')).toBe('project');
    });
});
