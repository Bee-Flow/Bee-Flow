// @typecheck
'use strict';

/**
 * #191: a colleague's automation receives a Nextcloud event only about a
 * resource its owner can see in Nextcloud. Every check runs as the subscriber
 * through fake deps here (no Nextcloud, no DB) and must fail closed.
 *
 * Run: node --test automation/triggerBus/ncVisibility.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createNcVisibility, visibilityKind, pathFromSearch, fileIdSearchBody, COLLEAGUE_SWITCH_EVENTS } = require('./ncVisibility.mts');

/**
 * A text response the fake fetch answers with.
 * @param {number} status
 * @param {unknown} [body]
 */
const res = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

/**
 * @param {{ tools?: Record<string, (args: any, userId: string) => any>, fetch?: (url: string, opts: any) => any,
 *   denied?: string[], sessions?: Record<string, unknown>, uid?: string }} [o]
 */
function makeDeps(o = {}) {
    const calls = { tools: /** @type {string[]} */ ([]), fetch: /** @type {{ url: string, opts: any }[]} */ ([]), sessions: 0 };
    const deps = {
        loadSession: async (userId) => { calls.sessions++; return o.sessions ? (o.sessions[userId] ?? null) : { user: { id: userId } }; },
        resolveAuth: async (_session, userId) => ({
            baseUrl: 'https://nc.example',
            uid: o.uid || `nc-${userId}`,
            fetch: async (url, opts) => { calls.fetch.push({ url, opts }); return o.fetch ? o.fetch(url, opts) : res(404); },
        }),
        runTool: async (name, args, userId) => {
            calls.tools.push(name);
            const fn = o.tools?.[name];
            return fn ? fn(args, userId) : { error: 'not found' };
        },
        scopeDenied: async (name) => (o.denied || []).includes(name),
    };
    return { deps, calls };
}

test('which events are checked, and which get the colleagues switch', () => {
    assert.strictEqual(visibilityKind('talk.message.received'), 'talk_room');
    assert.strictEqual(visibilityKind('deck.card.moved'), 'deck_board');
    assert.strictEqual(visibilityKind('tables.row.updated'), 'table_rows');
    assert.strictEqual(visibilityKind('forms.submitted'), 'form_results');
    assert.strictEqual(visibilityKind('file.renamed'), 'file');
    assert.strictEqual(visibilityKind('calendar.event.created'), 'calendar');
    assert.strictEqual(visibilityKind('calendar.event.moved'), 'calendar');
    // Actor-only: no exact check exists.
    assert.strictEqual(visibilityKind('calendar.event.upcoming'), null, 'read off the owner\'s own calendars');
    assert.strictEqual(visibilityKind('file.tagged'), null);
    assert.strictEqual(visibilityKind('constructor'), null, 'no prototype keys');
    assert.ok(!COLLEAGUE_SWITCH_EVENTS.has('file.new'), 'file.new reads the owner\'s own activity feed');
    assert.ok(COLLEAGUE_SWITCH_EVENTS.has('forms.submitted'));
    assert.ok(COLLEAGUE_SWITCH_EVENTS.has('calendar.event.changed'), '#407: calendar events get the switch');
});

test('talk: an attendee sees the message, a non-member of a public room (read back as guest) does not', async () => {
    for (const [type, visible] of [[1, true], [2, true], [3, true], [5, true], [4, false], [6, false], [undefined, false]]) {
        const { deps } = makeDeps({ tools: { nextcloud_talk_get_room: () => ({ token: 'r1', participantType: type }) } });
        const d = await createNcVisibility(deps).check('u-alice', 'talk.message.received', { roomToken: 'r1' }, new Map());
        assert.strictEqual(d.visible, visible, `participantType ${type}`);
    }
    const { deps } = makeDeps(); // room not found for this user
    assert.strictEqual((await createNcVisibility(deps).check('u-alice', 'talk.reaction.added', { roomToken: 'r1' }, new Map())).visible, false);
    const noToken = makeDeps({ tools: { nextcloud_talk_get_room: () => ({ participantType: 1 }) } });
    assert.strictEqual((await createNcVisibility(noToken.deps).check('u-alice', 'talk.message.received', {}, new Map())).visible, false);
});

test('deck: visible only when the subscriber can open the board', async () => {
    const ok = makeDeps({ tools: { nextcloud_deck_get_board: ({ boardId }) => ({ id: Number(boardId) }) } });
    assert.strictEqual((await createNcVisibility(ok.deps).check('u', 'deck.card.changed', { boardId: 12 }, new Map())).visible, true);
    const no = makeDeps({ tools: { nextcloud_deck_get_board: () => ({ error: 'Deck board fetch failed (403)' }) } });
    assert.strictEqual((await createNcVisibility(no.deps).check('u', 'deck.card.changed', { boardId: 12 }, new Map())).visible, false);
});

test('tables: visible only with READ on the table rows', async () => {
    const ok = makeDeps({ tools: { nextcloud_tables_list_rows: () => ({ rows: [] }) } });
    assert.strictEqual((await createNcVisibility(ok.deps).check('u', 'tables.row.added', { tableId: 34 }, new Map())).visible, true);
    const no = makeDeps({ tools: { nextcloud_tables_list_rows: () => ({ error: 'Tables row fetch failed (403)' }) } });
    assert.strictEqual((await createNcVisibility(no.deps).check('u', 'tables.row.added', { tableId: 34 }, new Map())).visible, false);
    assert.strictEqual((await createNcVisibility(ok.deps).check('u', 'tables.row.added', { tableId: 'x' }, new Map())).visible, false);
});

test('forms: the owner and holders of the results permission see a submission; a respondent does not', async () => {
    const form = (data) => makeDeps({ fetch: (url) => (url.endsWith('/ocs/v2.php/apps/forms/api/v3/forms/51') ? res(200, { ocs: { data } }) : res(404)) });
    const check = async (data) => (await createNcVisibility(form(data).deps).check('u-alice', 'forms.submitted', { formId: 51 }, new Map())).visible;
    assert.strictEqual(await check({ permissions: ['results'], ownerId: 'someone' }), true);
    assert.strictEqual(await check({ permissions: [], ownerId: 'nc-u-alice' }), true);
    assert.strictEqual(await check({ permissions: ['submit'], ownerId: 'someone' }), false);
    const forbidden = makeDeps({ fetch: () => res(403) });
    assert.strictEqual((await createNcVisibility(forbidden.deps).check('u', 'forms.submitted', { formId: 51 }, new Map())).visible, false);
});

const SEARCH_HIT = (uid, path) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/${uid}${path.split('/').map(encodeURIComponent).join('/')}</d:href></d:response></d:multistatus>`;

test('files: the path owner sees it as is; a colleague gets the file in THEIR tree, found by id', async () => {
    const own = makeDeps({ uid: 'alice' });
    const d1 = await createNcVisibility(own.deps).check('u-alice', 'file.changed', { id: 437, path: '/Invoices/x.pdf', owner: 'alice' }, new Map());
    assert.deepStrictEqual(d1, { visible: true });
    assert.strictEqual(own.calls.fetch.length, 0, 'no request for the owner');

    const shared = makeDeps({ uid: 'carol', fetch: (url, opts) => {
        assert.strictEqual(url, 'https://nc.example/remote.php/dav/');
        assert.strictEqual(opts.method, 'SEARCH');
        assert.match(opts.body, /<d:literal>437<\/d:literal>/);
        assert.match(opts.body, /<d:href>\/files\/carol<\/d:href>/);
        return res(207, SEARCH_HIT('carol', '/Shared with me/Invoices/x final.pdf'));
    } });
    const d2 = await createNcVisibility(shared.deps).check('u-carol', 'file.renamed',
        { id: 437, path: '/Invoices/x final.pdf', oldPath: '/Invoices/x.pdf', owner: 'bob' }, new Map());
    assert.strictEqual(d2.visible, true);
    assert.deepStrictEqual(d2.overrides, {
        path: '/Shared with me/Invoices/x final.pdf', name: 'x final.pdf', extension: 'pdf', owner: 'carol',
        oldPath: '/Shared with me/Invoices/x.pdf',
    });
});

test('files: no hit, no id (a delete), or the org scope refusing the path → not visible', async () => {
    const miss = makeDeps({ uid: 'carol', fetch: () => res(207, '<d:multistatus xmlns:d="DAV:"></d:multistatus>') });
    assert.strictEqual((await createNcVisibility(miss.deps).check('u', 'file.new', { id: 437, owner: 'bob', path: '/x' }, new Map())).visible, false);
    const deleted = makeDeps({ uid: 'carol', fetch: () => { throw new Error('must not search without an id'); } });
    assert.strictEqual((await createNcVisibility(deleted.deps).check('u', 'file.deleted', { id: null, owner: 'bob', path: '/x' }, new Map())).visible, false);
    const scoped = makeDeps({ uid: 'carol', denied: ['nextcloud_read_file'], fetch: () => res(207, SEARCH_HIT('carol', '/x.pdf')) });
    assert.strictEqual((await createNcVisibility(scoped.deps).check('u', 'file.new', { id: 437, owner: 'bob', path: '/x.pdf' }, new Map())).visible, false);
    // A moved file keeps no old path for the colleague.
    const moved = makeDeps({ uid: 'carol', fetch: () => res(207, SEARCH_HIT('carol', '/B/x.pdf')) });
    const d = await createNcVisibility(moved.deps).check('u', 'file.renamed', { id: 1, path: '/B/x.pdf', oldPath: '/A/x.pdf', owner: 'bob' }, new Map());
    assert.strictEqual(d.overrides?.oldPath, null);
});

const CALENDAR_207 = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response>'
    + '<d:href>/remote.php/dav/calendars/carol/team_shared_by_alice/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype></d:prop>'
    + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
const calendarEvent = (extra = {}) => ({
    calendarId: 9, calendarUri: 'team', calendarOwner: 'alice', uid: 'e1',
    calendarShares: [{ principal: 'principals/users/carol', readOnly: true }],
    ...extra,
});

test('calendar (#407): the owner sees an event in their own calendar without a request', async () => {
    const own = makeDeps({ uid: 'alice' });
    const d = await createNcVisibility(own.deps).check('u-alice', 'calendar.event.changed', calendarEvent(), new Map());
    assert.deepStrictEqual(d, { visible: true });
    assert.strictEqual(own.calls.fetch.length, 0);
    const scoped = makeDeps({ uid: 'alice', denied: ['nextcloud_calendar_list_events'] });
    assert.strictEqual((await createNcVisibility(scoped.deps).check('u-alice', 'calendar.event.changed', calendarEvent(), new Map())).visible, false,
        'a calendar the owner did not share with Bee Flow stays out');
});

test('calendar (#407): a colleague it is shared with gets it, as THEIR calendar, asked of Nextcloud as them', async () => {
    const shared = makeDeps({ uid: 'carol', fetch: (url, opts) => {
        assert.strictEqual(url, 'https://nc.example/remote.php/dav/calendars/carol/team_shared_by_alice/');
        assert.strictEqual(opts.method, 'PROPFIND');
        assert.strictEqual(opts.headers.Depth, '0');
        return res(207, CALENDAR_207);
    } });
    const d = await createNcVisibility(shared.deps).check('u-carol', 'calendar.event.created', calendarEvent(), new Map());
    assert.strictEqual(d.visible, true);
    assert.deepStrictEqual(d.overrides, { calendarUri: 'team_shared_by_alice', calendarShares: null },
        'the calendar URI in their own home, and not who else it is shared with');
});

test('calendar (#407): through a group share Nextcloud decides; a removed share reads as not visible', async () => {
    const viaGroup = calendarEvent({ calendarShares: [{ principal: 'principals/groups/sales', readOnly: false }] });
    const member = makeDeps({ uid: 'carol', fetch: () => res(207, CALENDAR_207) });
    assert.strictEqual((await createNcVisibility(member.deps).check('u-carol', 'calendar.event.deleted', viaGroup, new Map())).visible, true);
    const gone = makeDeps({ uid: 'carol', fetch: () => res(404) });
    assert.strictEqual((await createNcVisibility(gone.deps).check('u-carol', 'calendar.event.deleted', viaGroup, new Map())).visible, false);
    const notACalendar = makeDeps({ uid: 'carol', fetch: () => res(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:status>HTTP/1.1 200 OK</d:status><d:resourcetype><d:collection/></d:resourcetype></d:response></d:multistatus>') });
    assert.strictEqual((await createNcVisibility(notACalendar.deps).check('u-carol', 'calendar.event.deleted', viaGroup, new Map())).visible, false);
});

test('calendar (#407): not shared with them, no owner (older connector), or the scope refusing → not visible, often without a request', async () => {
    const never = () => { throw new Error('must not ask Nextcloud'); };
    const check = (payload, o = {}) => createNcVisibility(makeDeps({ uid: 'carol', fetch: never, ...o }).deps)
        .check('u-carol', 'calendar.event.created', payload, new Map());
    assert.strictEqual((await check(calendarEvent({ calendarShares: [{ principal: 'principals/users/dave' }] }))).visible, false, 'shared with someone else only');
    assert.strictEqual((await check(calendarEvent({ calendarShares: [] }))).visible, false, 'shared with no one');
    assert.strictEqual((await check(calendarEvent({ calendarOwner: undefined, calendarShares: undefined }))).visible, false, 'a connector before 1.6.6');
    assert.strictEqual((await check(calendarEvent({ calendarOwner: 'alice/../bob' }))).visible, false);
    assert.strictEqual((await check(calendarEvent(), { denied: ['nextcloud_calendar_list_events'] })).visible, false);
});

test('fails closed: no credentials, a scope denial, a throwing call', async () => {
    const noSession = makeDeps({ sessions: {}, tools: { nextcloud_deck_get_board: () => ({ id: 1 }) } });
    assert.strictEqual((await createNcVisibility(noSession.deps).check('u', 'deck.card.created', { boardId: 1 }, new Map())).visible, false);
    const denied = makeDeps({ denied: ['nextcloud_deck_get_board'], tools: { nextcloud_deck_get_board: () => ({ id: 1 }) } });
    assert.strictEqual((await createNcVisibility(denied.deps).check('u', 'deck.card.created', { boardId: 1 }, new Map())).visible, false);
    assert.deepStrictEqual(denied.calls.tools, [], 'a refused scope never reaches Nextcloud');
    const warnings = [];
    const throwing = makeDeps({ tools: { nextcloud_deck_get_board: () => { throw new Error('ECONNRESET'); } } });
    const vis = createNcVisibility({ ...throwing.deps, log: { warn: (m) => warnings.push(m) } });
    assert.strictEqual((await vis.check('u', 'deck.card.created', { boardId: 1 }, new Map())).visible, false);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual((await createNcVisibility(throwing.deps).check('u', 'calendar.event.created', {}, new Map())).visible, false);
    assert.strictEqual((await createNcVisibility(throwing.deps).check('', 'deck.card.created', { boardId: 1 }, new Map())).visible, false);
});

test('one dispatch asks once per subscriber and resource', async () => {
    const { deps, calls } = makeDeps({ tools: { nextcloud_talk_get_room: () => ({ participantType: 3 }) } });
    const vis = createNcVisibility(deps);
    const memo = new Map();
    await Promise.all([1, 2, 3].map(() => vis.check('u-alice', 'talk.message.received', { roomToken: 'r1' }, memo)));
    await vis.check('u-bob', 'talk.message.received', { roomToken: 'r1' }, memo);
    assert.deepStrictEqual(calls.tools, ['nextcloud_talk_get_room', 'nextcloud_talk_get_room']);
    // A new dispatch asks again: a membership removed a moment ago counts at once.
    await vis.check('u-alice', 'talk.message.received', { roomToken: 'r1' }, new Map());
    assert.strictEqual(calls.tools.length, 3);
});

test('tag names resolve as the subscriber sees the tag list', async () => {
    const { deps } = makeDeps({ tools: { nextcloud_list_tags: () => ({ tags: [{ id: 3, name: 'Invoice' }, { id: 17, name: 'Paid' }] }) } });
    const vis = createNcVisibility(deps);
    assert.deepStrictEqual(await vis.tagNames('u', [3, '17', 99], new Map()), ['Invoice', 'Paid']);
    assert.deepStrictEqual(await vis.tagNames('u', [], new Map()), []);
});

test('pathFromSearch: only hits in this user\'s own tree, decoded', () => {
    const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/ann2/x.pdf</d:href></d:response>'
        + '<d:response><d:href>/remote.php/dav/files/ann/A%20B/x.pdf</d:href></d:response></d:multistatus>';
    assert.strictEqual(pathFromSearch(xml, 'ann'), '/A B/x.pdf');
    assert.strictEqual(pathFromSearch('<multistatus/>', 'ann'), null);
    assert.match(fileIdSearchBody('a&b', '1'), /\/files\/a&amp;b/);
});
