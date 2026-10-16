'use strict';

/**
 * Characterisation of executeNextcloudDeckTool: one case per tool, plus the
 * shared failure branches (401, 404, non-ok). The Nextcloud client is stubbed
 * on the module object (the tool reads `ncClient.x` at call time), the fetch is
 * a scripted fake, so no network and no module-cache tricks.
 *
 * Run: cd server && node --test integrations/nextcloudDeckTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ncClient = require('./nextcloudClient');
const { NEXTCLOUD_DECK_TOOLS, executeNextcloudDeckTool, isNextcloudDeckTool } = require('./nextcloudDeckTools');

const BASE = 'https://nc.test';
const API = `${BASE}/index.php/apps/deck/api/v1.0`;
const OCS = `${BASE}/ocs/v2.php/apps/deck/api/v1.0`;

function res(status, body) {
    return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? '')) };
}

/** Run a tool against scripted responses: `routes` maps "METHOD url" to a response (or a list, consumed in order). */
async function run(toolName, args, routes = {}) {
    const calls = [];
    const orig = { ...ncClient };
    ncClient.isConnectorSession = () => false;
    ncClient.resolveBasicAuthOrNull = async () => ({
        baseUrl: BASE,
        authError: 'AUTH-ERR',
        fetch: async (url, options = {}) => {
            const key = `${options.method || 'GET'} ${url}`;
            calls.push({ key, headers: options.headers, body: options.body === undefined ? undefined : JSON.parse(options.body) });
            const r = routes[key];
            if (r === undefined) throw new Error(`unscripted request: ${key}`);
            return Array.isArray(r) ? r.shift() : r;
        },
    });
    try {
        return { out: await executeNextcloudDeckTool(toolName, args, 'u1', {}), calls };
    } finally {
        Object.assign(ncClient, orig);
    }
}

test('every advertised tool is recognised and the unknown one is refused', async () => {
    for (const t of NEXTCLOUD_DECK_TOOLS) assert.ok(isNextcloudDeckTool(t.function.name));
    const { out } = await run('nextcloud_deck_nope', {});
    assert.deepEqual(out, { error: 'Unknown Nextcloud Deck tool: nextcloud_deck_nope' });
    const { out: proto } = await run('constructor', {});
    assert.deepEqual(proto, { error: 'Unknown Nextcloud Deck tool: constructor' });
});

test('an OAuth-only session without an app password gets the CORS auth error', async () => {
    const orig = { ...ncClient };
    ncClient.isConnectorSession = () => false;
    ncClient.resolveBasicAuthOrNull = async () => null;
    ncClient.isNextcloudOAuthSession = () => true;
    try {
        const out = await executeNextcloudDeckTool('nextcloud_deck_list_boards', {}, 'u1', {});
        assert.deepEqual(out, { error: ncClient.CORS_AUTH_ERROR });
    } finally {
        Object.assign(ncClient, orig);
    }
});

test('list_boards filters archived, maps fields, and sends REST headers', async () => {
    const boards = [
        { id: 1, title: 'A', color: 'f00', archived: false, labels: [{ id: 9, title: 'L', color: '0f0', extra: 1 }], permissions: { x: 1 }, owner: { uid: 'bob' } },
        { id: 2, title: 'B', color: '00f', archived: true, owner: 'eve' },
    ];
    const { out, calls } = await run('nextcloud_deck_list_boards', {}, { [`GET ${API}/boards`]: res(200, boards) });
    assert.deepEqual(out, { count: 1, boards: [{ id: 1, title: 'A', color: 'f00', archived: false, labels: [{ id: 9, title: 'L', color: '0f0' }], permissions: { x: 1 }, owner: 'bob' }] });
    assert.deepEqual(calls[0].headers, { Accept: 'application/json' });
    const all = await run('nextcloud_deck_list_boards', { includeArchived: true }, { [`GET ${API}/boards?details=true`]: res(200, boards) });
    assert.equal(all.out.count, 2);
    assert.equal(all.out.boards[1].owner, 'eve');
    assert.deepEqual(all.out.boards[1].labels, []);
});

test('list_boards: 401 and other failures', async () => {
    assert.deepEqual((await run('nextcloud_deck_list_boards', {}, { [`GET ${API}/boards`]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_list_boards', {}, { [`GET ${API}/boards`]: res(500, '') })).out, { error: 'Deck boards list failed (500)' });
    assert.deepEqual((await run('nextcloud_deck_list_boards', {}, { [`GET ${API}/boards`]: res(200, { not: 'array' }) })).out, { count: 0, boards: [] });
});

test('get_board', async () => {
    assert.deepEqual((await run('nextcloud_deck_get_board', {})).out, { error: 'boardId is required' });
    const k = `GET ${API}/boards/3`;
    assert.deepEqual((await run('nextcloud_deck_get_board', { boardId: 3 }, { [k]: res(200, { id: 3 }) })).out, { id: 3 });
    assert.deepEqual((await run('nextcloud_deck_get_board', { boardId: 3 }, { [k]: res(404, '') })).out, { error: 'Board not found: 3' });
    assert.deepEqual((await run('nextcloud_deck_get_board', { boardId: 3 }, { [k]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_get_board', { boardId: 3 }, { [k]: res(500, '') })).out, { error: 'Deck board fetch failed (500)' });
});

test('list_stacks', async () => {
    assert.deepEqual((await run('nextcloud_deck_list_stacks', {})).out, { error: 'boardId is required' });
    const k = `GET ${API}/boards/3/stacks`;
    const stacks = [{ id: 1, title: 'T', order: 2, cards: [{}, {}] }, { id: 2, title: 'U', order: 3 }];
    assert.deepEqual((await run('nextcloud_deck_list_stacks', { boardId: 3 }, { [k]: res(200, stacks) })).out, {
        count: 2, stacks: [{ id: 1, title: 'T', order: 2, cardCount: 2 }, { id: 2, title: 'U', order: 3, cardCount: 0 }],
    });
    assert.deepEqual((await run('nextcloud_deck_list_stacks', { boardId: 3 }, { [k]: res(200, { odd: 1 }) })).out, { odd: 1 });
    assert.deepEqual((await run('nextcloud_deck_list_stacks', { boardId: 3 }, { [k]: res(503, '') })).out, { error: 'Stack list failed (503)' });
});

test('create_stack', async () => {
    assert.deepEqual((await run('nextcloud_deck_create_stack', { boardId: 3 })).out, { error: 'boardId and title are required' });
    const k = `POST ${API}/boards/3/stacks`;
    const ok = await run('nextcloud_deck_create_stack', { boardId: 3, title: 'New' }, { [k]: res(200, { id: 5, title: 'New', order: 999 }) });
    assert.deepEqual(ok.out, { success: true, stack: { id: 5, title: 'New', order: 999, boardId: 3 } });
    assert.deepEqual(ok.calls[0].body, { title: 'New', order: 999 });
    assert.deepEqual(ok.calls[0].headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
    const ordered = await run('nextcloud_deck_create_stack', { boardId: 3, title: 'N', order: '4' }, { [k]: res(200, { id: 6 }) });
    assert.equal(ordered.calls[0].body.order, 4);
    assert.deepEqual((await run('nextcloud_deck_create_stack', { boardId: 3, title: 'N' }, { [k]: res(404, '') })).out, { error: 'Board not found: 3' });
    assert.deepEqual((await run('nextcloud_deck_create_stack', { boardId: 3, title: 'N' }, { [k]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_create_stack', { boardId: 3, title: 'N' }, { [k]: res(400, { m: 'bad' }) })).out, { error: 'Stack create failed (400)', detail: { m: 'bad' } });
});

test('update_stack merges onto the current stack', async () => {
    assert.deepEqual((await run('nextcloud_deck_update_stack', { boardId: 3 })).out, { error: 'boardId and stackId are required' });
    const list = `GET ${API}/boards/3/stacks`;
    const put = `PUT ${API}/boards/3/stacks/7`;
    const cur = [{ id: 7, title: 'Old', order: 1 }];
    const ok = await run('nextcloud_deck_update_stack', { boardId: 3, stackId: 7, title: 'New' }, { [list]: res(200, cur), [put]: res(200, { id: 7, title: 'New', order: 1 }) });
    assert.deepEqual(ok.out, { success: true, stack: { id: 7, title: 'New', order: 1 } });
    assert.deepEqual(ok.calls[1].body, { title: 'New', order: 1 });
    assert.deepEqual((await run('nextcloud_deck_update_stack', { boardId: 3, stackId: 9 }, { [list]: res(200, cur) })).out, { error: 'Stack not found: 9' });
    assert.deepEqual((await run('nextcloud_deck_update_stack', { boardId: 3, stackId: 7 }, { [list]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_update_stack', { boardId: 3, stackId: 7 }, { [list]: res(500, '') })).out, { error: 'Could not load stacks for update (500)' });
    assert.deepEqual((await run('nextcloud_deck_update_stack', { boardId: 3, stackId: 7 }, { [list]: res(200, cur), [put]: res(422, 'no') })).out, { error: 'Stack update failed (422)', detail: 'no' });
});

test('delete_stack', async () => {
    assert.deepEqual((await run('nextcloud_deck_delete_stack', { boardId: 3 })).out, { error: 'boardId and stackId are required' });
    const k = `DELETE ${API}/boards/3/stacks/7`;
    assert.deepEqual((await run('nextcloud_deck_delete_stack', { boardId: 3, stackId: 7 }, { [k]: res(200, '') })).out, { success: true, stackId: 7 });
    assert.deepEqual((await run('nextcloud_deck_delete_stack', { boardId: 3, stackId: 7 }, { [k]: res(404, '') })).out, { error: 'Stack not found: 7' });
    assert.deepEqual((await run('nextcloud_deck_delete_stack', { boardId: 3, stackId: 7 }, { [k]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_delete_stack', { boardId: 3, stackId: 7 }, { [k]: res(500, '') })).out, { error: 'Stack delete failed (500)' });
});

const STACKS = [
    { id: 1, title: 'Todo', cards: [
        { id: 10, title: 'Alpha task', description: 'first', duedate: '2026-10-01T00:00:00Z', labels: [{ id: 1, title: 'Urgent', color: 'f00' }], assignedUsers: [{ participant: { uid: 'bob' } }], archived: false, order: 1, type: 'plain' },
        { id: 11, title: 'Beta', description: 'second', duedate: '2026-12-01T00:00:00Z', labels: [], assignedUsers: [{ uid: 'eve' }] },
    ] },
    { id: 2, title: 'Done', cards: [{ id: 12, title: 'Gamma', description: 'alpha mention' }] },
];

test('list_cards and search_cards share the filter, with different default limits', async () => {
    const k = `GET ${API}/boards/3/stacks`;
    const all = await run('nextcloud_deck_list_cards', { boardId: 3 }, { [k]: res(200, STACKS) });
    assert.equal(all.out.count, 3);
    assert.deepEqual(all.out.cards[0], {
        id: 10, stackId: 1, stackTitle: 'Todo', title: 'Alpha task', description: 'first', duedate: '2026-10-01T00:00:00Z',
        labels: [{ id: 1, title: 'Urgent', color: 'f00' }], assignedUsers: ['bob'], archived: false, order: 1, type: 'plain',
    });
    assert.deepEqual(all.out.cards[1].assignedUsers, ['eve']);
    const q = await run('nextcloud_deck_search_cards', { boardId: 3, query: 'ALPHA' }, { [k]: res(200, STACKS) });
    assert.deepEqual(q.out.cards.map(c => c.id), [10, 12]);
    const f = await run('nextcloud_deck_search_cards', { boardId: 3, labelTitle: 'urg', assignedUid: 'bob', dueBefore: '2026-11-01', stackId: 1 }, { [k]: res(200, STACKS) });
    assert.deepEqual(f.out.cards.map(c => c.id), [10]);
    const after = await run('nextcloud_deck_list_cards', { boardId: 3, dueAfter: '2026-11-01' }, { [k]: res(200, STACKS) });
    assert.deepEqual(after.out.cards.map(c => c.id), [11]);
    const lim = await run('nextcloud_deck_list_cards', { boardId: 3, limit: 1 }, { [k]: res(200, STACKS) });
    assert.deepEqual([lim.out.count, lim.out.cards.length, lim.out.boardId], [1, 1, 3]);
    const arch = await run('nextcloud_deck_list_cards', { boardId: 3, includeArchived: true }, { [`GET ${API}/boards/3/stacks/archived`]: res(200, STACKS) });
    assert.equal(arch.out.count, 3);
    assert.deepEqual((await run('nextcloud_deck_list_cards', {})).out, { error: 'boardId is required' });
    assert.deepEqual((await run('nextcloud_deck_list_cards', { boardId: 3 }, { [k]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_list_cards', { boardId: 3 }, { [k]: res(500, '') })).out, { error: 'Card list failed (500)' });
    assert.deepEqual((await run('nextcloud_deck_search_cards', { boardId: 3 }, { [k]: res(200, {}) })).out, { error: 'Unexpected Deck response shape' });
});

test('search_cards caps the limit at 200, list_cards at 1000', async () => {
    const big = [{ id: 1, title: 's', cards: Array.from({ length: 1100 }, (_, i) => ({ id: i, title: 'c' })) }];
    const k = `GET ${API}/boards/3/stacks`;
    assert.equal((await run('nextcloud_deck_search_cards', { boardId: 3, limit: 9999 }, { [k]: res(200, big) })).out.count, 200);
    assert.equal((await run('nextcloud_deck_search_cards', { boardId: 3 }, { [k]: res(200, big) })).out.count, 50);
    assert.equal((await run('nextcloud_deck_list_cards', { boardId: 3, limit: 9999 }, { [k]: res(200, big) })).out.count, 1000);
    assert.equal((await run('nextcloud_deck_list_cards', { boardId: 3 }, { [k]: res(200, big) })).out.count, 200);
});

test('get_card', async () => {
    assert.deepEqual((await run('nextcloud_deck_get_card', { boardId: 3 })).out, { error: 'boardId, stackId, cardId required' });
    const k = `GET ${API}/boards/3/stacks/1/cards/10`;
    const a = { boardId: 3, stackId: 1, cardId: 10 };
    assert.deepEqual((await run('nextcloud_deck_get_card', a, { [k]: res(200, { id: 10 }) })).out, { id: 10 });
    assert.deepEqual((await run('nextcloud_deck_get_card', a, { [k]: res(404, '') })).out, { error: 'Card not found: 10' });
    assert.deepEqual((await run('nextcloud_deck_get_card', a, { [k]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_get_card', a, { [k]: res(500, '') })).out, { error: 'Card fetch failed (500)' });
});

test('create_card', async () => {
    assert.deepEqual((await run('nextcloud_deck_create_card', { boardId: 3, stackId: 1 })).out, { error: 'boardId, stackId, title required' });
    const k = `POST ${API}/boards/3/stacks/1/cards`;
    const a = { boardId: 3, stackId: 1, title: 'T' };
    const ok = await run('nextcloud_deck_create_card', a, { [k]: res(200, { id: 20 }) });
    assert.deepEqual(ok.out, { id: 20 });
    assert.deepEqual(ok.calls[0].body, { title: 'T', type: 'plain', order: 999, description: '', duedate: null });
    assert.deepEqual((await run('nextcloud_deck_create_card', a, { [k]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_create_card', a, { [k]: res(400, { m: 1 }) })).out, { error: 'Card create failed (400)', detail: { m: 1 } });
});

test('update_card merges, optionally moves, and reports a failed move', async () => {
    assert.deepEqual((await run('nextcloud_deck_update_card', {})).out, { error: 'boardId, stackId, cardId required' });
    const base = `${API}/boards/3/stacks/1/cards/10`;
    const get = `GET ${base}`, put = `PUT ${base}`, move = `PUT ${base}/reorder`;
    const cur = { title: 'Old', description: 'd', duedate: '2026-01-01', type: 'plain', owner: { uid: 'bob' }, order: 4 };
    const a = { boardId: 3, stackId: 1, cardId: 10 };
    const ok = await run('nextcloud_deck_update_card', { ...a, title: 'New', duedate: '' }, { [get]: res(200, cur), [put]: res(200, { id: 10, title: 'New' }) });
    assert.deepEqual(ok.out, { success: true, card: { id: 10, title: 'New' } });
    assert.deepEqual(ok.calls[1].body, { title: 'New', description: 'd', duedate: null, type: 'plain', owner: 'bob', order: 4 });
    const at2 = `GET ${API}/boards/3/stacks/2/cards/10`;
    const mv = await run('nextcloud_deck_update_card', { ...a, targetStackId: 2, order: 1 }, { [get]: res(200, cur), [put]: res(200, { id: 10 }), [move]: res(200, {}), [at2]: res(200, { id: 10, stackId: 2 }) });
    assert.deepEqual(mv.out, { success: true, card: { id: 10, stackId: 2 } });
    assert.deepEqual(mv.calls[2].body, { order: 1, stackId: 2 });
    const bad = await run('nextcloud_deck_update_card', { ...a, targetStackId: 2 }, { [get]: res(200, cur), [put]: res(200, { id: 10 }), [move]: res(500, 'x') });
    assert.deepEqual(bad.out, { success: true, updated: { id: 10 }, moveError: 'Card update succeeded but move failed (500)', moveDetail: 'x' });
    assert.deepEqual((await run('nextcloud_deck_update_card', a, { [get]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_update_card', a, { [get]: res(404, '') })).out, { error: 'Card not found: 10' });
    assert.deepEqual((await run('nextcloud_deck_update_card', a, { [get]: res(500, '') })).out, { error: 'Could not load card for update (500)' });
    assert.deepEqual((await run('nextcloud_deck_update_card', a, { [get]: res(200, cur), [put]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_update_card', a, { [get]: res(200, cur), [put]: res(400, 'z') })).out, { error: 'Card update failed (400)', detail: 'z' });
});

test('update_card reports a move that did not take effect', async () => {
    const base = `${API}/boards/3/stacks/1/cards/10`;
    const cur = { title: 'Old', owner: 'bob', order: 4 };
    const routes = {
        [`GET ${base}`]: res(200, cur), [`PUT ${base}`]: res(200, { id: 10 }), [`PUT ${base}/reorder`]: res(200, {}),
        [`GET ${API}/boards/3/stacks/2/cards/10`]: res(404, ''),
    };
    const r = await run('nextcloud_deck_update_card', { boardId: 3, stackId: 1, cardId: 10, targetStackId: 2, order: 0 }, routes);
    assert.equal(r.out.success, true);
    assert.match(r.out.moveError, /did not move/i);
});

test('update_card says so when the move cannot be verified, and keeps an unparsable stored due date', async () => {
    const base = `${API}/boards/3/stacks/1/cards/10`;
    const cur = { title: 'T', owner: 'bob', order: 1, duedate: 'weird' };
    const routes = {
        [`GET ${base}`]: res(200, cur), [`PUT ${base}`]: res(200, { id: 10 }), [`PUT ${base}/reorder`]: res(200, {}),
        [`GET ${API}/boards/3/stacks/2/cards/10`]: res(500, ''),
    };
    const r = await run('nextcloud_deck_update_card', { boardId: 3, stackId: 1, cardId: 10, targetStackId: 2 }, routes);
    assert.match(r.out.moveError, /could not be verified \(500\)/);
    assert.equal(r.calls[1].body.duedate, 'weird');
});

test('update_card and archive_card resend the due date as UTC, not as an offset string', async () => {
    const base = `${API}/boards/3/stacks/1/cards/10`;
    const cur = { title: 'T', owner: 'bob', order: 1, duedate: '2026-06-01T10:00:00-05:00' };
    const routes = () => ({ [`GET ${base}`]: res(200, cur), [`PUT ${base}`]: res(200, {}) });
    const up = await run('nextcloud_deck_update_card', { boardId: 3, stackId: 1, cardId: 10, title: 'y' }, routes());
    assert.equal(up.calls[1].body.duedate, '2026-06-01T15:00:00.000Z');
    const ar = await run('nextcloud_deck_archive_card', { boardId: 3, stackId: 1, cardId: 10 }, routes());
    assert.equal(ar.calls[1].body.duedate, '2026-06-01T15:00:00.000Z');
    const set = await run('nextcloud_deck_update_card', { boardId: 3, stackId: 1, cardId: 10, duedate: '2026-07-01T10:00:00+02:00' }, routes());
    assert.equal(set.calls[1].body.duedate, '2026-07-01T08:00:00.000Z');
});

test('an unparsable duedate is refused before Deck sees it', async () => {
    const a = { boardId: 3, stackId: 1, cardId: 10, duedate: 'next tuesday-ish' };
    const up = await run('nextcloud_deck_update_card', a, {});
    assert.match(up.out.error, /duedate/i);
    const cr = await run('nextcloud_deck_create_card', { boardId: 3, stackId: 1, title: 't', duedate: 'nope' }, {});
    assert.match(cr.out.error, /duedate/i);
    assert.equal(up.calls.length + cr.calls.length, 0);
});

test('archive_card defaults to archiving', async () => {
    assert.deepEqual((await run('nextcloud_deck_archive_card', {})).out, { error: 'boardId, stackId, cardId required' });
    const base = `${API}/boards/3/stacks/1/cards/10`;
    const a = { boardId: 3, stackId: 1, cardId: 10 };
    const cur = { title: 'T', owner: 'bob', order: 2 };
    const ok = await run('nextcloud_deck_archive_card', a, { [`GET ${base}`]: res(200, cur), [`PUT ${base}`]: res(200, {}) });
    assert.deepEqual(ok.out, { success: true, archived: true });
    assert.deepEqual(ok.calls[1].body, { title: 'T', description: '', duedate: null, type: 'plain', owner: 'bob', order: 2, archived: true });
    const un = await run('nextcloud_deck_archive_card', { ...a, archived: false }, { [`GET ${base}`]: res(200, cur), [`PUT ${base}`]: res(200, {}) });
    assert.deepEqual(un.out, { success: true, archived: false });
    assert.deepEqual((await run('nextcloud_deck_archive_card', a, { [`GET ${base}`]: res(500, '') })).out, { error: 'Could not load card (500)' });
    assert.deepEqual((await run('nextcloud_deck_archive_card', a, { [`GET ${base}`]: res(200, cur), [`PUT ${base}`]: res(500, 'q') })).out, { error: 'Archive toggle failed (500)', detail: 'q' });
});

test('delete_card', async () => {
    assert.deepEqual((await run('nextcloud_deck_delete_card', {})).out, { error: 'boardId, stackId, cardId required' });
    const k = `DELETE ${API}/boards/3/stacks/1/cards/10`;
    const a = { boardId: 3, stackId: 1, cardId: 10 };
    assert.deepEqual((await run('nextcloud_deck_delete_card', a, { [k]: res(204, '') })).out, { success: true, cardId: 10 });
    assert.deepEqual((await run('nextcloud_deck_delete_card', a, { [k]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_delete_card', a, { [k]: res(404, '') })).out, { error: 'Card not found: 10' });
    assert.deepEqual((await run('nextcloud_deck_delete_card', a, { [k]: res(500, '') })).out, { error: 'Card delete failed (500)' });
});

test('assign_label and remove_label differ only in the operation', async () => {
    assert.deepEqual((await run('nextcloud_deck_assign_label', { boardId: 3 })).out, { error: 'boardId, stackId, cardId, labelId required' });
    const a = { boardId: 3, stackId: 1, cardId: 10, labelId: 5 };
    const base = `PUT ${API}/boards/3/stacks/1/cards/10`;
    const as = await run('nextcloud_deck_assign_label', a, { [`${base}/assignLabel`]: res(200, {}) });
    assert.deepEqual(as.out, { success: true });
    assert.deepEqual(as.calls[0].body, { labelId: 5 });
    assert.deepEqual((await run('nextcloud_deck_remove_label', a, { [`${base}/removeLabel`]: res(200, {}) })).out, { success: true });
    assert.deepEqual((await run('nextcloud_deck_remove_label', a, { [`${base}/removeLabel`]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_assign_label', a, { [`${base}/assignLabel`]: res(409, 'c') })).out, { error: 'assignLabel failed (409)', detail: 'c' });
});

test('comments use the OCS family with the OCS header', async () => {
    assert.deepEqual((await run('nextcloud_deck_add_comment', { cardId: 10 })).out, { error: 'cardId and message required' });
    const post = `POST ${OCS}/cards/10/comments`;
    const ok = await run('nextcloud_deck_add_comment', { cardId: 10, message: 'hi' }, { [post]: res(200, { ocs: { data: { id: 1 } } }) });
    assert.deepEqual(ok.out, { success: true, comment: { id: 1 } });
    assert.deepEqual(ok.calls[0].body, { message: 'hi', parentId: 0 });
    assert.deepEqual(ok.calls[0].headers, { Accept: 'application/json', 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' });
    assert.deepEqual((await run('nextcloud_deck_add_comment', { cardId: 10, message: 'hi' }, { [post]: res(200, { plain: 1 }) })).out, { success: true, comment: { plain: 1 } });
    assert.deepEqual((await run('nextcloud_deck_add_comment', { cardId: 10, message: 'hi' }, { [post]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_add_comment', { cardId: 10, message: 'hi' }, { [post]: res(500, 'e') })).out, { error: 'Comment failed (500)', detail: 'e' });

    assert.deepEqual((await run('nextcloud_deck_list_comments', {})).out, { error: 'cardId is required' });
    const get = `GET ${OCS}/cards/10/comments?limit=50`;
    const lc = await run('nextcloud_deck_list_comments', { cardId: 10 }, { [get]: res(200, { ocs: { data: [{ id: 1 }, { id: 2 }] } }) });
    assert.deepEqual(lc.out, { count: 2, comments: [{ id: 1 }, { id: 2 }] });
    assert.deepEqual(lc.calls[0].headers, { Accept: 'application/json', 'OCS-APIRequest': 'true' });
    assert.deepEqual((await run('nextcloud_deck_list_comments', { cardId: 10, limit: 999 }, { [`GET ${OCS}/cards/10/comments?limit=200`]: res(200, { ocs: {} }) })).out, { count: 0, comments: { ocs: {} } });
    assert.deepEqual((await run('nextcloud_deck_list_comments', { cardId: 10 }, { [get]: res(401, '') })).out, { error: 'AUTH-ERR' });
    assert.deepEqual((await run('nextcloud_deck_list_comments', { cardId: 10 }, { [get]: res(500, '') })).out, { error: 'Comment list failed (500)' });
});

test('remove_label: a 403 or 404 names its cause instead of a bare status', async () => {
    const a = { boardId: 3, stackId: 1, cardId: 10, labelId: 5 };
    const key = `PUT ${API}/boards/3/stacks/1/cards/10/removeLabel`;
    const denied = (await run('nextcloud_deck_remove_label', a, { [key]: res(403, '{"message":"Not allowed"}') })).out;
    assert.match(denied.error, /Permission denied/);
    const missing = (await run('nextcloud_deck_remove_label', a, { [key]: res(404, '{"message":"Label not found"}') })).out;
    assert.match(missing.error, /Not found.*Label not found/);
});
