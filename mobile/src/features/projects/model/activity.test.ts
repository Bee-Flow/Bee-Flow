/**
 * The activity trail in words: names when the directory gives them, the
 * web's own sentences for the actions it knows, and an unknown action named
 * as the server wrote it rather than dropped.
 */

import { translate } from '@/core/i18n';

import { activityLine, humaniseAction } from './activity';
import { nameResolver } from './people';
import type { ActivityItem } from './types';

const nameFor = nameResolver({ users: [{ id: 'u1', displayName: 'Ada' }, { id: 'u2', displayName: 'Grace' }], groups: [{ id: 'g1', name: 'Finance' }] });

const item = (over: Partial<ActivityItem>): ActivityItem => ({
    id: 'a',
    actorId: 'u1',
    action: 'project_created',
    targetType: null,
    targetId: null,
    details: {},
    createdAt: null,
    ...over,
});

describe('activityLine', () => {
    it.each([
        [item({}), 'Ada created the project'],
        [item({ action: 'project_updated', details: { changes: { name: {}, icon: {} } } }), 'Ada updated name, icon'],
        [item({ action: 'project_updated' }), 'Ada updated the project'],
        [item({ action: 'instructions_updated' }), 'Ada updated the project instructions'],
        [item({ action: 'member_added', targetType: 'user', targetId: 'u2', details: { role: 'editor' } }), 'Ada added Grace (Can edit)'],
        [item({ action: 'member_added', targetType: 'group', targetId: 'g1' }), 'Ada added Finance (Can view)'],
        [item({ action: 'member_removed', targetType: 'user', targetId: 'u9abcdef12345' }), 'Ada removed u9abcdef'],
        [item({ action: 'member_removed', details: { selfLeave: true } }), 'Ada left the project'],
        [item({ action: 'member_role_changed', targetType: 'user', targetId: 'u2', details: { from: 'viewer', to: 'editor' } }), "Ada changed Grace's role from viewer to editor"],
        [item({ action: 'kb_added' }), 'Ada attached a knowledge base'],
        [item({ action: 'kb_removed' }), 'Ada removed a knowledge base'],
        [item({ action: 'conversation_assigned' }), 'Ada added a conversation'],
        [item({ action: 'conversation_unassigned' }), 'Ada removed a conversation'],
        [item({ action: 'resource_added', targetType: 'datatable' }), 'Ada filed something in (datatable)'],
        [item({ action: 'resource_removed', targetType: 'app' }), 'Ada took something out (app)'],
        [item({ action: 'blueprint.published' }), 'Ada published a new version'],
        [item({ action: 'thread_shared', actorId: 'stranger' }), 'Someone: Thread shared'],
    ])('%#: %s', (row, text) => {
        expect(activityLine(row, nameFor, translate)).toBe(text);
    });

    it('humanises an action as the web does', () => {
        expect(humaniseAction('automation.run_finished')).toBe('Automation run finished');
        expect(humaniseAction('')).toBe('');
    });
});
