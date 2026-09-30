import { describe, expect, it } from 'vitest';
import { projectKeys } from '../../../api/queries/projects';
import { affectsActivity, keysForEvent } from './ProjectLiveContext';

describe('keysForEvent: what a live event makes stale', () => {
    it('re-reads the project and every project list when the reader was removed', () => {
        // The detail then answers 404 and the page says the project is gone;
        // the sidebar list drops it.
        expect(keysForEvent('p1', 'forbidden')).toEqual([projectKeys.detail('p1'), ['projects', 'list']]);
    });

    it('refreshes the team chats on chat events, but not on the transient AI ones', () => {
        expect(keysForEvent('p1', 'chat.message.created')).toEqual([projectKeys.chats('p1')]);
        expect(keysForEvent('p1', 'chat.ai.started')).toEqual([]);
    });

    it('refreshes the files on file events', () => {
        expect(keysForEvent('p1', 'file.added')).toEqual([projectKeys.files('p1'), projectKeys.resources('p1')]);
    });

    it('refreshes the detail, the sections and the lists when a legacy project is classified', () => {
        expect(keysForEvent('p1', 'kind_set')).toEqual([projectKeys.detail('p1'), projectKeys.resources('p1'), ['projects', 'list']]);
    });
});

describe('keysForEvent: catching up and co-editing', () => {
    it('re-reads everything of the project when the server could not replay the gap', () => {
        expect(keysForEvent('p1', 'resync')).toEqual([projectKeys.project('p1')]);
    });

    it('refreshes the content lists when a co-editing session is checkpointed or restored', () => {
        expect(keysForEvent('p1', 'doc.edited')).toEqual([projectKeys.resources('p1')]);
        expect(keysForEvent('p1', 'doc.restored')).toEqual([projectKeys.resources('p1')]);
        // The change feed's entries rename, move and re-attribute items in the content lists.
        for (const kind of ['content.created', 'content.edited', 'content.renamed', 'content.moved_in', 'content.moved_out', 'content.restored']) {
            expect(keysForEvent('p1', kind)).toEqual([projectKeys.resources('p1')]);
        }
    });

    it('never invalidates anything on keystroke-rate document frames', () => {
        for (const kind of ['doc.update', 'doc.awareness', 'doc.awareness.query', 'doc.resync', 'doc.closed']) {
            expect(keysForEvent('p1', kind)).toEqual([]);
        }
    });
});

describe('affectsActivity: when the Activity tab is re-read', () => {
    it('leaves it alone for chat and comment traffic, which never logs an activity row', () => {
        for (const kind of [
            'chat.message.created', 'chat.message.updated', 'chat.message.deleted', 'chat.mention', 'chat.updated',
            'comment.created', 'comment.updated', 'comment.mention', 'comment.resolved',
            'message.created', 'run.started', 'run.finished',
        ]) {
            expect(affectsActivity(kind, {}), kind).toBe(false);
        }
    });

    it('re-reads it for the traffic that does log a row', () => {
        for (const kind of ['chat.created', 'chat.deleted', 'comment.thread.created']) {
            expect(affectsActivity(kind, {}), kind).toBe(true);
        }
    });

    it('re-reads it for every other durable event', () => {
        for (const kind of ['member_added', 'project_updated', 'content.edited', 'resource_added', 'doc.edited', 'blueprint.published', 'file.added']) {
            expect(affectsActivity(kind, {}), kind).toBe(true);
        }
    });

    it('never re-reads it for transient events, co-editing frames or a resync', () => {
        expect(affectsActivity('member_added', { transient: true })).toBe(false);
        expect(affectsActivity('doc.update', {})).toBe(false);
        expect(affectsActivity('resync', {})).toBe(false);
    });
});
