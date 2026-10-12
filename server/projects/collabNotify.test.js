'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeCollabNotifier, ncPortalBase } = require('./collabNotify');

const project = { id: 'p1', name: 'Launch' };

function make(extra = {}) {
    const sent = [];
    const mails = [];
    const notifier = makeCollabNotifier({
        createNotification: async (x) => { sent.push(x); },
        prefs: { filterRecipients: async (ids) => ({ bell: ids, email: [] }) },
        sendEmail: async (x) => { mails.push(x); },
        renderText: async ({ userId, key }) => ({ title: `${key}@${userId}`, message: 'm' }),
        projectPath: (id, section) => (section ? `/app/projects/${id}/${section}` : `/app/projects/${id}`),
        getUser: async (id) => ({ id, displayName: `Name ${id}` }),
        groupMemberIds: async () => ({ ids: [], total: 0 }),
        ...extra,
    });
    return { sent, mails, notifier };
}

test('a chat mention rings the mentioned members, not the writer, in their locale', async () => {
    const { sent, notifier } = make();
    await notifier.chatMentioned({ project, actorId: 'ann', mentionedUserIds: ['ann', 'bob', 'bob'], chatId: 'c1' });
    assert.deepStrictEqual(sent.map((s) => [s.userId, s.title, s.link]), [['bob', 'project_collab.bell.chat_mention@bob', '/app/projects/p1/chats/c1']]);
});

test('mentions outside the project are dropped: the route passes only members, the notifier never widens', async () => {
    const { sent, notifier } = make();
    await notifier.commentMentioned({ project, actorId: 'ann', mentionedUserIds: ['bob'], targetType: 'document', targetId: 'd1' });
    assert.deepStrictEqual(sent.map((s) => s.userId), ['bob']);
    assert.strictEqual(sent[0].link, '/app/projects/p1/documents/d1');
    await notifier.commentMentioned({ project, actorId: 'ann', mentionedUserIds: ['bob'], targetType: 'notebook', targetId: 'n1' });
    assert.strictEqual(sent[1].link, '/app/projects/p1/notebooks/n1');
});

test('an add, a role change, a removal, a leave and an owner change reach the right people', async () => {
    const { sent, notifier } = make();
    await notifier.added({ project, actorId: 'ann', sharedWithType: 'user', sharedWithId: 'bob', role: 'editor' });
    await notifier.roleChanged({ project, actorId: 'ann', userId: 'bob', from: 'viewer', to: 'editor' });
    await notifier.removed({ project, actorId: 'ann', userId: 'bob' });
    await notifier.left({ project: { ...project, ownerId: 'ann' }, userId: 'bob' });
    await notifier.ownerChanged({ project, actorId: 'admin', fromUserId: 'ann', toUserId: 'bob' });
    assert.deepStrictEqual(sent.map((s) => [s.userId, s.title]), [
        ['bob', 'project_collab.bell.added@bob'],
        ['bob', 'project_collab.bell.role_changed@bob'],
        ['bob', 'project_collab.bell.removed@bob'],
        ['ann', 'project_collab.bell.left@ann'],
        ['bob', 'project_collab.bell.owner_changed@bob'],
        ['ann', 'project_collab.bell.owner_handed@ann'],
    ]);
});

test('acting on yourself rings nobody', async () => {
    const { sent, notifier } = make();
    await notifier.added({ project, actorId: 'ann', sharedWithType: 'user', sharedWithId: 'ann', role: 'editor' });
    await notifier.removed({ project, actorId: 'ann', userId: 'ann' });
    await notifier.ownerChanged({ project, actorId: 'ann', fromUserId: 'ann', toUserId: 'ann' });
    assert.deepStrictEqual(sent, []);
});

test('a group is fanned out to its members, except the one who shared', async () => {
    const asked = [];
    const { sent, notifier } = make({ groupMemberIds: async (g, cap) => { asked.push([g, cap]); return { ids: ['ann', 'bob', 'cy'], total: 3 }; } });
    await notifier.added({ project, actorId: 'ann', sharedWithType: 'group', sharedWithId: 'g1', role: 'viewer' });
    assert.deepStrictEqual(asked, [['g1', 200]]);
    assert.deepStrictEqual(sent.map((s) => s.userId), ['bob', 'cy']);
});

test('a large group is not fanned out', async () => {
    const log = require('../telemetry/log');
    const orig = log.warn;
    let warned = false;
    log.warn = () => { warned = true; };
    try {
        const { sent, notifier } = make({ groupMemberIds: async () => ({ ids: [], total: 201 }) });
        await notifier.added({ project, actorId: 'ann', sharedWithType: 'group', sharedWithId: 'g1', role: 'viewer' });
        assert.deepStrictEqual(sent, []);
        assert.ok(warned);
    } finally { log.warn = orig; }
});

test('prefs and mutes filter per channel', async () => {
    const calls = [];
    const { sent, mails, notifier } = make({
        prefs: { filterRecipients: async (ids, projectId, event) => { calls.push([projectId, event]); return { bell: ids.filter((i) => i === 'bob'), email: ids.filter((i) => i === 'cy') }; } },
    });
    await notifier.chatMentioned({ project, actorId: 'ann', mentionedUserIds: ['bob', 'cy', 'dee'], chatId: 'c1' });
    assert.deepStrictEqual(calls, [['p1', 'chat_mention']]);
    assert.deepStrictEqual(sent.map((s) => s.userId), ['bob']);
    assert.deepStrictEqual(mails.map((m) => m.userId), ['cy']);
    assert.strictEqual(mails[0].event, 'chat_mention');
});

test('nothing from a row leaks: the message holds the project name and actor only', async () => {
    const seen = [];
    const { sent, notifier } = make({
        renderText: async ({ key, vars }) => { seen.push(vars); return { title: key, message: `${vars.project} ${vars.actor}` }; },
    });
    await notifier.commentMentioned({
        project: { id: 'p1', name: 'Launch', description: 'secret text', ownerId: 'ann' },
        actorId: 'ann', mentionedUserIds: ['bob'], targetType: 'task', targetId: 't1', text: 'secret text',
    });
    assert.ok(!JSON.stringify(sent).includes('secret text'));
    assert.deepStrictEqual(seen[0], { project: 'Launch', actor: 'Name ann' });
});

test('a failing bell, prefs lookup or text never fails the caller', async () => {
    const a = make({ createNotification: async () => { throw new Error('db down'); } });
    await a.notifier.chatMentioned({ project, actorId: 'ann', mentionedUserIds: ['bob'], chatId: 'c1' });
    const b = make({ prefs: { filterRecipients: async () => { throw new Error('x'); } } });
    await b.notifier.removed({ project, actorId: 'ann', userId: 'bob' });
    const c = make({ renderText: async () => { throw new Error('x'); } });
    await c.notifier.removed({ project, actorId: 'ann', userId: 'bob' });
    assert.deepStrictEqual([a.sent, b.sent, c.sent], [[], [], []]);
});

test('the mail of an event goes to the email recipients with an allow-listed payload and an absolute link', async () => {
    const { sent, mails, notifier } = make({
        prefs: { filterRecipients: async () => ({ bell: ['bob'], email: ['bob'] }) },
        renderText: async ({ userId, key, parts }) => (parts ? { intro: `intro:${key}`, detail: `detail:${key}` } : { title: `${key}@${userId}`, message: 'm' }),
        clientHost: () => 'https://app.example.test',
    });
    await notifier.chatMentioned({ project: { ...project, description: 'secret text' }, actorId: 'ann', mentionedUserIds: ['bob'], chatId: 'c1', text: 'secret text' });
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(mails, [{
        userId: 'bob',
        event: 'chat_mention',
        vars: { project: 'Launch', actor: 'Name ann', intro: 'intro:project_collab.email.chat_mention', detail: 'detail:project_collab.email.chat_mention' },
        ctaUrl: 'https://app.example.test/app/projects/p1/chats/c1',
    }]);
    assert.ok(!JSON.stringify(mails).includes('secret text'));
});

test('a removal mails without a link, and the previous owner gets the handed-over sentence', async () => {
    const { mails, notifier } = make({
        prefs: { filterRecipients: async (ids) => ({ bell: [], email: ids }) },
        renderText: async ({ key }) => ({ detail: key }),
        clientHost: () => 'https://app.example.test',
    });
    await notifier.removed({ project, actorId: 'ann', userId: 'bob' });
    await notifier.ownerChanged({ project, actorId: 'x', fromUserId: 'ann', toUserId: 'bob' });
    assert.strictEqual(mails[0].ctaUrl, null);
    assert.deepStrictEqual(mails.slice(1).map((m) => [m.userId, m.event, m.vars.detail]), [
        ['bob', 'owner_changed', 'project_collab.email.owner_changed'],
        ['ann', 'owner_changed', 'project_collab.email.owner_handed'],
    ]);
});

test('a mail that cannot be sent (no service mailbox) leaves the bell in place and throws nothing', async () => {
    const { sent, notifier } = make({
        prefs: { filterRecipients: async () => ({ bell: ['bob'], email: ['bob'] }) },
        sendEmail: async () => { throw new Error('service_email_not_configured'); },
    });
    await assert.doesNotReject(notifier.chatMentioned({ project, actorId: 'ann', mentionedUserIds: ['bob'], chatId: 'c1' }));
    assert.strictEqual(sent.length, 1);
});

test('a task assignment rings and mails the assignees except the giver, with a task link and an allow-listed mail', async () => {
    const { sent, mails, notifier } = make({
        prefs: { filterRecipients: async (ids, projectId, event) => { assert.strictEqual(event, 'task_assigned'); return { bell: ids, email: ids }; } },
        clientHost: () => 'https://bee.example',
        renderText: async ({ userId, key, parts }) => (parts ? { intro: `intro@${key}`, detail: `detail@${key}` } : { title: `${key}@${userId}`, message: 'm' }),
    });
    assert.strictEqual(await notifier.taskAssigned({ project, actorId: 'ann', assigneeIds: ['ann', 'bob', 'bob', 'cy'], taskId: 't1' }), 2);
    assert.deepStrictEqual(sent.map((s) => [s.userId, s.title, s.link]), [
        ['bob', 'project_collab.bell.task_assigned@bob', '/app/projects/p1/tasks/t1'],
        ['cy', 'project_collab.bell.task_assigned@cy', '/app/projects/p1/tasks/t1'],
    ]);
    assert.deepStrictEqual(mails.map((m) => m.userId), ['bob', 'cy']);
    assert.deepStrictEqual(mails[0], {
        userId: 'bob',
        event: 'task_assigned',
        vars: { project: 'Launch', actor: 'Name ann', intro: 'intro@project_collab.email.task_assigned', detail: 'detail@project_collab.email.task_assigned' },
        ctaUrl: 'https://bee.example/app/projects/p1/tasks/t1',
    });
});

test('the mail link of a Nextcloud user points into their Nextcloud portal, others keep the Bee Flow origin', async () => {
    const users = {
        ann: { id: 'ann', displayName: 'Ann' },
        nc: { id: 'nc', nc_uid: 'ncuser', organizationId: 'o1' },
        web: { id: 'web', organizationId: 'o1' },
    };
    const orgs = { o1: { id: 'o1', registrationSource: 'nextcloud_connector', nc_base_url: 'https://cloud.example/' } };
    const { mails, notifier } = make({
        prefs: { filterRecipients: async (ids) => ({ bell: [], email: ids }) },
        renderText: async () => ({ title: 't', message: 'm', intro: 'i', detail: 'd' }),
        clientHost: () => 'https://beeflow.nl',
        getUser: async (id) => users[id],
        getOrganization: async (o) => orgs[o],
    });
    await notifier.added({ project, actorId: 'ann', sharedWithType: 'user', sharedWithId: 'nc', role: 'editor' });
    await notifier.added({ project, actorId: 'ann', sharedWithType: 'user', sharedWithId: 'web', role: 'editor' });
    assert.deepStrictEqual(mails.map((m) => [m.userId, m.ctaUrl]), [
        ['nc', 'https://cloud.example/index.php/apps/app_api/embedded/bee_flow/main?path=%2Fapp%2Fprojects%2Fp1'],
        ['web', 'https://beeflow.nl/app/projects/p1'],
    ]);
});

test('ncPortalBase is null without an NC org, a base URL or an nc_uid', async () => {
    const get = (user, org) => ncPortalBase('u', { getUser: async () => user, getOrganization: async () => org });
    assert.strictEqual(await get({ nc_uid: 'x', organizationId: 'o' }, { registrationSource: 'direct', nc_base_url: 'https://c.example' }), null);
    assert.strictEqual(await get({ nc_uid: 'x', organizationId: 'o' }, { registrationSource: 'nextcloud_connector' }), null);
    assert.strictEqual(await get({ organizationId: 'o' }, { registrationSource: 'nextcloud_connector', nc_base_url: 'https://c.example' }), null);
    assert.strictEqual(await get(null, null), null);
});

test('a Docker-internal or bare-IP Nextcloud base URL is not a portal base; the mail keeps the Bee Flow origin', async () => {
    for (const nc_base_url of ['http://nextcloud', 'http://localhost:8080', 'http://192.168.1.5', 'http://nextcloud.internal', 'http://[::1]:8080']) {
        const orgs = { o1: { id: 'o1', registrationSource: 'nextcloud_connector', nc_base_url } };
        const users = { ann: { id: 'ann', displayName: 'Ann' }, nc: { id: 'nc', nc_uid: 'ncuser', organizationId: 'o1' } };
        const { mails, notifier } = make({
            prefs: { filterRecipients: async (ids) => ({ bell: [], email: ids }) },
            renderText: async () => ({ title: 't', message: 'm', intro: 'i', detail: 'd' }),
            clientHost: () => 'https://beeflow.nl',
            getUser: async (id) => users[id],
            getOrganization: async (o) => orgs[o],
        });
        await notifier.added({ project, actorId: 'ann', sharedWithType: 'user', sharedWithId: 'nc', role: 'editor' });
        assert.deepStrictEqual(mails.map((m) => m.ctaUrl), ['https://beeflow.nl/app/projects/p1'], nc_base_url);
    }
});
