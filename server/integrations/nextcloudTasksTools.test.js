'use strict';

/**
 * Nextcloud tasks tools: list discovery (writable / supportsTasks), the
 * default list, and readable errors for a calendar without VTODO support.
 *
 * Run: cd server && node --test integrations/nextcloudTasksTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ncClient = require('./nextcloudClient');
const { executeNextcloudTasksTool } = require('./nextcloudTasksTools');

const BASE = 'https://nc.test';

function calendar(slug, comps, writable) {
    const privs = writable ? '<d:privilege><d:write/></d:privilege>' : '<d:privilege><d:read/></d:privilege>';
    return `<d:response><d:href>/remote.php/dav/calendars/u1/${slug}/</d:href><d:propstat><d:prop>
      <d:displayname>${slug}</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <c:supported-calendar-component-set>${comps.map((c) => `<c:comp name="${c}"/>`).join('')}</c:supported-calendar-component-set>
      <d:current-user-privilege-set>${privs}</d:current-user-privilege-set>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

const LISTING = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
${calendar('personal', ['VEVENT'], true)}
${calendar('deck-board', ['VTODO'], false)}
${calendar('my-tasks', ['VTODO', 'VEVENT'], true)}
</d:multistatus>`;

const EMPTY_REPORT = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>';
const INVALID_COMPONENT = '<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:exception>Sabre\\CalDAV\\Exception\\InvalidComponentType</s:exception><s:message>Calendar does not support VTODO</s:message></d:error>';

async function run(tool, args, { putStatus = 201, putBody = '' } = {}) {
    const calls = [];
    const orig = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => ({
        baseUrl: BASE, uid: 'u1', authError: 'AUTH',
        fetch: async (url, options = {}) => {
            const method = options.method || 'GET';
            calls.push(`${method} ${url}`);
            const reply = (status, text) => ({ status, ok: status < 300, headers: { get: () => null }, text: async () => text });
            if (method === 'PUT') return reply(putStatus, putBody);
            if (method === 'REPORT') return reply(207, EMPTY_REPORT);
            return reply(207, LISTING);
        },
    });
    try {
        return { out: await executeNextcloudTasksTool(tool, args, 'u1', {}), calls };
    } finally {
        ncClient.resolveAuth = orig;
    }
}

test('list_lists reports supportsTasks and writable per list', async () => {
    const { out } = await run('nextcloud_tasks_list_lists', {});
    const by = Object.fromEntries(out.lists.map((l) => [l.slug, l]));
    assert.deepEqual([by.personal.supportsTasks, by.personal.writable], [false, true]);
    assert.deepEqual([by['deck-board'].supportsTasks, by['deck-board'].writable], [true, false]);
    assert.deepEqual([by['my-tasks'].supportsTasks, by['my-tasks'].writable], [true, true]);
});

test('tasks_list without a list uses the first writable list that supports tasks', async () => {
    const { out, calls } = await run('nextcloud_tasks_list', {});
    assert.equal(out.list, 'my-tasks');
    assert.ok(calls.some((c) => c === `REPORT ${BASE}/remote.php/dav/calendars/u1/my-tasks/`));
});

test('tasks_list on a calendar without VTODO says so instead of returning an empty list', async () => {
    const { out } = await run('nextcloud_tasks_list', { list: 'personal' });
    assert.match(out.error, /does not support tasks/i);
});

test('create on a calendar without VTODO gives a readable error, not raw XML', async () => {
    const { out } = await run('nextcloud_tasks_create', { list: 'personal', summary: 't' }, { putStatus: 403, putBody: INVALID_COMPONENT });
    assert.match(out.error, /does not support tasks/i);
    assert.doesNotMatch(out.error, /<|Sabre/);
});

test('create on a read-only list says it is read-only', async () => {
    const { out } = await run('nextcloud_tasks_create', { list: 'deck-board', summary: 't' }, { putStatus: 403, putBody: '<d:error xmlns:d="DAV:"><s:message>Access denied</s:message></d:error>' });
    assert.match(out.error, /read-only|permission/i);
    assert.doesNotMatch(out.error, /</);
});

test('a calendar without a component set is treated as supporting tasks (RFC 4791)', async () => {
    const orig = ncClient.resolveAuth;
    const xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/remote.php/dav/calendars/u1/any/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
    ncClient.resolveAuth = async () => ({ baseUrl: BASE, uid: 'u1', authError: 'AUTH', fetch: async () => ({ status: 207, ok: true, text: async () => xml }) });
    try {
        const out = await executeNextcloudTasksTool('nextcloud_tasks_list_lists', {}, 'u1', {});
        assert.equal(out.lists[0].supportsTasks, true);
    } finally {
        ncClient.resolveAuth = orig;
    }
});

test('a 5xx on create does not echo server detail', async () => {
    const { out } = await run('nextcloud_tasks_create', { list: 'my-tasks', summary: 't' }, { putStatus: 500, putBody: '<s:message>SQLSTATE secret_table</s:message>' });
    assert.doesNotMatch(out.error, /SQLSTATE|secret/);
});
