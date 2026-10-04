'use strict';

/**
 * The source registry and the collector runner: connection state, selection,
 * the read-only tool guard, concurrency, time limits, abort and failures.
 * Collectors and tools are injected; nothing is mocked at module level.
 *
 * Run: cd server && node --test automation/patterns/sources/index.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { SOURCE_GROUPS, LIVE_TOOLS, LIMITS, listSourceGroups, collectAll, selectUnits } = require('./index');
const { isSideEffect } = require('../../sideEffectMap');
const { makeEvent } = require('../events');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 18, 0);

const ALL_LIVE = [...LIVE_TOOLS];
const ev = (app, verb = 'mail.received') => makeEvent({ ts: NOW - DAY, source: 'mail', objectType: 'mail', app, verb, direction: 'in' });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collectors for every registry app, each returning one event unless overridden. */
function stubCollectors(overrides = {}) {
    const out = {};
    for (const g of SOURCE_GROUPS) for (const a of g.apps) out[a.id] = async () => [ev(a.id)];
    return { ...out, ...overrides };
}

test('the registry: four groups, unique app ids, live tools all read-only', () => {
    assert.deepStrictEqual(SOURCE_GROUPS.map((g) => [g.id, g.kind]), [
        ['mail', 'live'], ['calendar', 'stored'], ['files', 'live'], ['beeflow', 'stored'],
    ]);
    const ids = SOURCE_GROUPS.flatMap((g) => g.apps.map((a) => a.id));
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const t of LIVE_TOOLS) assert.strictEqual(isSideEffect(t), false, `${t} must be read-only`);
    for (const g of SOURCE_GROUPS) {
        for (const a of g.apps) {
            if (g.kind === 'live') assert.ok(a.tools?.length, `${a.id} names its tools`);
            assert.strictEqual(typeof a.collect, 'function');
        }
    }
    assert.deepStrictEqual({ ...LIMITS }, { concurrency: 3, perSourceMs: 20_000, totalMs: 75_000 });
});

test('listSourceGroups: the GET /suggest/sources payload', () => {
    const none = listSourceGroups([]);
    assert.strictEqual(none.windowDays, 90);
    const byId = Object.fromEntries(none.groups.map((g) => [g.id, g]));
    assert.strictEqual(byId.mail.connected, false);
    assert.strictEqual(byId.files.connected, false);
    assert.strictEqual(byId.calendar.connected, false);
    assert.strictEqual(byId.beeflow.connected, true, 'Bee Flow activity is always there');
    assert.deepStrictEqual(byId.mail.apps[0], { id: 'gmail', label: 'Gmail', connected: false });

    const some = listSourceGroups(['gmail_search', 'gmail_compose', 'nextcloud_mail_search', 'ms_calendar_list_events', 'drive_list_recent']);
    const s = Object.fromEntries(some.groups.map((g) => [g.id, Object.fromEntries(g.apps.map((a) => [a.id, a.connected]))]));
    assert.deepStrictEqual(s.mail, { gmail: true, outlook: false, nextcloud_mail: false }, 'Nextcloud Mail needs all three of its tools');
    assert.deepStrictEqual(s.calendar, { teams: true, gmeet: false, meetings: false });
    assert.deepStrictEqual(s.files, { nextcloud: false, onedrive: false, google_drive: true });
    assert.ok(some.groups.every((g) => ['live', 'stored'].includes(g.kind)));
});

test('selectUnits: groups, app ids in either spelling, empty means all connected', () => {
    const names = new Set(ALL_LIVE);
    const ids = (sel) => selectUnits(sel, names).map((u) => u.app.id);
    assert.deepStrictEqual(ids(['mail']), ['gmail', 'outlook', 'nextcloud_mail']);
    assert.deepStrictEqual(ids(['google-drive', 'chat']), ['google_drive', 'chat']);
    assert.strictEqual(ids([]).length, ids(null).length);
    assert.deepStrictEqual(selectUnits(['mail'], new Set()).map((u) => u.app.id), [], 'unconnected apps never run');
});

test('collectAll: nothing selectable → no_sources', async () => {
    const res = await collectAll({ userId: 'u1', sources: ['mail', 'files'], availableToolNames: [] });
    assert.deepStrictEqual(res, { events: [], steps: [], reason: 'no_sources' });
});

test('collectAll: runs every selected app, reports steps, passes the window', async () => {
    const seen = [];
    const progress = [];
    const res = await collectAll({
        userId: 'u1', now: NOW, availableToolNames: ['gmail_search'], sources: ['mail', 'beeflow'],
        collectors: stubCollectors({
            gmail: async (c) => { seen.push(c); return [ev('gmail'), ev('gmail')]; },
            documents: async () => [],
        }),
    }, { onProgress: (s) => progress.push(s) });
    assert.strictEqual(res.reason, null);
    assert.deepStrictEqual(res.steps.map((s) => [s.source, s.app, s.status, s.events]).sort(), [
        ['beeflow', 'chat', 'done', 1], ['beeflow', 'documents', 'done', 0], ['mail', 'gmail', 'done', 2],
    ]);
    assert.strictEqual(res.events.length, 3);
    assert.strictEqual(seen[0].userId, 'u1');
    assert.strictEqual(seen[0].since, NOW - 90 * DAY);
    assert.strictEqual(typeof seen[0].pseudoDomain, 'function');
    assert.deepStrictEqual(progress.filter((p) => p.app === 'gmail').map((p) => p.status), ['start', 'done']);
});

test('collectAll: at most three sources at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => { inFlight++; peak = Math.max(peak, inFlight); await tick(15); inFlight--; return []; };
    const collectors = {};
    for (const g of SOURCE_GROUPS) for (const a of g.apps) collectors[a.id] = slow;
    const res = await collectAll({ userId: 'u1', availableToolNames: [...ALL_LIVE, 'teams_x', 'calendar_x', 'nextcloud_talk_x'], collectors });
    assert.strictEqual(res.steps.length, 11);
    assert.ok(res.steps.every((s) => s.status === 'done'));
    assert.strictEqual(peak, 3);
});

test('collectAll: a slow source times out, a failing one is skipped, the rest still count', async () => {
    let stoppedSignal = null;
    const res = await collectAll({
        userId: 'u1', sources: ['mail', 'chat'],
        availableToolNames: ['gmail_search', 'outlook_list_recent', 'nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes', 'nextcloud_mail_search'],
        limits: { perSourceMs: 30 },
        collectors: stubCollectors({
            gmail: (c) => { stoppedSignal = c.signal; return new Promise(() => {}); },
            outlook: async () => { throw Object.assign(new Error('token expired'), { code: 'auth' }); },
            nextcloud_mail: async () => { throw Object.assign(new Error('refused by the Privacy Shield'), { code: 'shield' }); },
            chat: async () => { throw new Error('db down'); },
        }),
    });
    const by = Object.fromEntries(res.steps.map((s) => [s.app, s]));
    assert.deepStrictEqual(by.gmail, { source: 'mail', app: 'gmail', status: 'skipped', events: 0, reason: 'timeout' });
    assert.strictEqual(by.outlook.reason, 'auth');
    assert.strictEqual(by.nextcloud_mail.reason, 'shield', 'a Shield refusal keeps its own code');
    assert.strictEqual(by.chat.reason, 'error', 'an uncoded failure is a plain error');
    assert.strictEqual(stoppedSignal.aborted, true, 'the timed-out collector is told to stop');
    assert.strictEqual(res.events.length, 0);
});

test('collectAll: the total budget cuts the running source and everything queued', async () => {
    const collectors = {};
    for (const g of SOURCE_GROUPS) for (const a of g.apps) collectors[a.id] = () => tick(40).then(() => [ev(a.id)]);
    const res = await collectAll({
        userId: 'u1', availableToolNames: ALL_LIVE, sources: ['mail', 'files'],
        limits: { concurrency: 1, totalMs: 60, perSourceMs: 1000 }, collectors,
    });
    assert.strictEqual(res.steps[0].status, 'done');
    assert.strictEqual(res.steps[1].reason, 'budget', 'cut while running');
    assert.ok(res.steps.slice(2).every((s) => s.status === 'skipped' && s.reason === 'budget'), 'never started');
    assert.strictEqual(res.events.length, 1);
});

test('collectAll: the caller\'s abort stops running and queued sources without throwing', async () => {
    const ac = new AbortController();
    const res = await collectAll({
        userId: 'u1', availableToolNames: ALL_LIVE, sources: ['mail'], limits: { concurrency: 1 },
        collectors: stubCollectors({ gmail: () => { setTimeout(() => ac.abort(), 5); return new Promise(() => {}); } }),
    }, { signal: ac.signal });
    assert.deepStrictEqual(res.steps.map((s) => [s.app, s.reason]), [['gmail', 'aborted'], ['outlook', 'aborted'], ['nextcloud_mail', 'aborted']]);
});

test('collectAll: the tool guard only lets the registry\'s available read tools through', async () => {
    const executed = [];
    const executeTool = async (name, args, opts) => { executed.push({ name, args, hasSignal: !!opts?.signal }); return { results: [] }; };
    const tryTool = (name) => async (c) => { await c.executeTool(name, {}); return []; };
    const res = await collectAll({
        userId: 'u1', executeTool, availableToolNames: ['gmail_search', 'gmail_compose', 'drive_list_recent'], sources: ['gmail', 'google_drive', 'chat'],
        collectors: stubCollectors({
            gmail: tryTool('gmail_compose'),               // a write, though the user has it
            google_drive: tryTool('outlook_list_recent'),  // a registry tool the user lacks
            chat: tryTool('gmail_search'),                 // allowed
        }),
    });
    const by = Object.fromEntries(res.steps.map((s) => [s.app, s]));
    assert.strictEqual(by.gmail.reason, 'error');
    assert.strictEqual(by.google_drive.reason, 'not_connected');
    assert.strictEqual(by.chat.status, 'done');
    assert.deepStrictEqual(executed, [{ name: 'gmail_search', args: {}, hasSignal: true }]);
});

test('collectAll end to end: real collectors, one domain pseudonym per scan', async () => {
    const mail = { from: 'Billing <billing@acme-supplies.nl>', to: 'billing@acme-supplies.nl', subject: 'Invoice 4711', date: new Date(NOW - 2 * DAY).toISOString() };
    const executeTool = async (name) => (name === 'gmail_search' ? { results: [mail] } : { results: [{ ...mail, from: 'x@sub.acme-supplies.nl', to: 'y@mail.acme-supplies.nl' }] });
    const res = await collectAll({
        userId: 'u1', now: NOW, executeTool, availableToolNames: ['gmail_search', 'outlook_list_recent'],
        sources: ['mail', 'beeflow'],
        deps: {
            getManualToolEvents: async () => [{ tool_name: 'sheets_append_rows', integration_type: 'google_sheets', timestamp: new Date(NOW - DAY), conversation_id: 'c9' }],
            db: { query: async () => ({ rows: [] }) },
        },
    });
    assert.ok(res.steps.every((s) => s.status === 'done'), JSON.stringify(res.steps));
    const mails = res.events.filter((e) => e.source === 'mail');
    assert.strictEqual(mails.length, 4, 'gmail in + sent, outlook inbox + sent');
    assert.ok(mails.every((e) => e.domainPseudo === 'd1' && e.template === 'Invoice <n>'));
    assert.strictEqual(res.events.filter((e) => e.source === 'ledger').length, 1);
    const text = JSON.stringify(res.events);
    assert.ok(!text.includes('acme') && !text.includes('@') && !text.includes('Billing'));
});
