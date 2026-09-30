'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeTaskNotifier } = require('./taskNotify');

function harness(extra = {}) {
    const sent = [];
    const notifier = makeTaskNotifier({
        createNotification: async (n) => { sent.push(n); },
        projectPath: (id, section) => `/app/projects/${id}/${section}`,
        ...extra,
    });
    return { sent, notifier };
}
const project = { id: 'p1', name: 'Launch' };

test('the people given a task are told, except the one who gave it, with a link and no task text', async () => {
    const { sent, notifier } = harness();
    assert.strictEqual(await notifier.assigned({ project, actorId: 'ann', assigneeIds: ['ann', 'ben', 'ben', 'cy'], taskId: 't1' }), 2);
    assert.deepStrictEqual(sent.map((n) => n.userId), ['ben', 'cy']);
    assert.strictEqual(sent[0].link, '/app/projects/p1/tasks/t1');
    assert.strictEqual(sent[0].category, 'heads_up');
    assert.ok(sent[0].message.includes('Launch'));
    assert.ok(!JSON.stringify(sent).includes('t1 title'));
});

test('a mention on a task and a due date each ring the right bell; a late task is urgent', async () => {
    const { sent, notifier } = harness();
    await notifier.mentioned({ project, actorId: 'ann', mentionedUserIds: ['ann', 'ben'], taskId: 't1' });
    assert.deepStrictEqual(sent.map((n) => n.userId), ['ben']);
    await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'due_today' });
    await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'overdue' });
    assert.deepStrictEqual(sent.slice(1).map((n) => n.category), ['heads_up', 'urgent']);
    assert.strictEqual(await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'nonsense' }), false);
});

test('a bell that cannot be created never fails the caller', async () => {
    const { notifier } = harness({ createNotification: async () => { throw new Error('db down'); } });
    assert.strictEqual(await notifier.assigned({ project, actorId: 'ann', assigneeIds: ['ben'], taskId: 't1' }), 1);
    assert.strictEqual(await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'due_1d' }), false);
});
