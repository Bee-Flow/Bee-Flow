'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeTaskNotifier } = require('./taskNotify');
const { makeCollabNotifier } = require('./collabNotify');

function harness(extra = {}) {
    const sent = [];
    const mails = [];
    const base = {
        createNotification: async (n) => { sent.push(n); },
        projectPath: (id, section) => `/app/projects/${id}/${section}`,
        renderText: async ({ userId, key, vars }) => ({ title: `${key}@${userId}`, message: `In "${vars.project}".`, intro: 'i', detail: 'd' }),
    };
    const deps = { ...base, ...extra };
    const collabNotifier = makeCollabNotifier({
        ...deps,
        prefs: { filterRecipients: async (ids) => ({ bell: ids, email: ids.filter((id) => id === 'ben') }) },
        sendEmail: async (m) => { mails.push(m); },
        clientHost: () => 'https://bee.example',
        getUser: async (id) => ({ id, displayName: `Name ${id}` }),
    });
    const notifier = makeTaskNotifier({ ...deps, collabNotifier });
    return { sent, mails, notifier };
}
const project = { id: 'p1', name: 'Launch' };

test('the people given a task are told, except the one who gave it, with a link and no task text', async () => {
    const { sent, notifier } = harness();
    assert.strictEqual(await notifier.assigned({ project, actorId: 'ann', assigneeIds: ['ann', 'ben', 'ben', 'cy'], taskId: 't1' }), 2);
    assert.deepStrictEqual(sent.map((n) => n.userId), ['ben', 'cy']);
    assert.strictEqual(sent[0].link, '/app/projects/p1/tasks/t1');
    assert.strictEqual(sent[0].category, 'heads_up');
    assert.strictEqual(sent[0].title, 'project_collab.bell.task_assigned@ben');
    assert.ok(sent[0].message.includes('Launch'));
    assert.ok(!JSON.stringify(sent).includes('t1 title'));
});

test('an assignment also mails the people whose prefs say so, through the collaboration notifier', async () => {
    const { mails, notifier } = harness();
    await notifier.assigned({ project, actorId: 'ann', assigneeIds: ['ben', 'cy'], taskId: 't1' });
    assert.deepStrictEqual(mails.map((m) => [m.userId, m.event, m.ctaUrl]), [['ben', 'task_assigned', 'https://bee.example/app/projects/p1/tasks/t1']]);
});

test('a mention on a task and a due date each ring the right bell; a late task is urgent', async () => {
    const { sent, notifier } = harness();
    await notifier.mentioned({ project, actorId: 'ann', mentionedUserIds: ['ann', 'ben'], taskId: 't1' });
    assert.deepStrictEqual(sent.map((n) => n.userId), ['ben']);
    assert.strictEqual(sent[0].title, 'project_collab.bell.task_mention@ben');
    await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'due_today' });
    await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'overdue' });
    assert.deepStrictEqual(sent.slice(1).map((n) => n.category), ['heads_up', 'urgent']);
    assert.deepStrictEqual(sent.slice(1).map((n) => n.title), ['project_collab.bell.task_due_today@ben', 'project_collab.bell.task_overdue@ben']);
    assert.strictEqual(await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'nonsense' }), false);
});

test('a bell that cannot be created never fails the caller', async () => {
    const { notifier } = harness({ createNotification: async () => { throw new Error('db down'); } });
    assert.strictEqual(await notifier.assigned({ project, actorId: 'ann', assigneeIds: ['ben'], taskId: 't1' }), 1);
    assert.strictEqual(await notifier.due({ project, userId: 'ben', taskId: 't1', tier: 'due_1d' }), false);
});

test('the default renderer speaks the recipient\'s language from the catalogue', async () => {
    const { makeRenderText } = require('./collabNotify');
    const render = makeRenderText({
        getUser: async () => ({ preferredLocale: 'nl' }),
        translate: async (locale, key, vars) => `${locale}:${key}:${vars.project}`,
    });
    assert.deepStrictEqual(await render({ userId: 'ben', key: 'project_collab.bell.task_assigned', vars: { project: 'Launch' } }),
        { title: 'nl:project_collab.bell.task_assigned.title:Launch', message: 'nl:project_collab.bell.task_assigned.message:Launch' });
});
