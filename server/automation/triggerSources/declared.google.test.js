const test = require('node:test');
const assert = require('node:assert');

const { runPollDiff, makePassCtx } = require('./pollDiff');
const { getEventDef } = require('./index');
const { buildAppEventProviders } = require('../builderTools/triggerProviders');

/**
 * The Google Workspace apps beyond Gmail/Calendar/Drive get their triggers from
 * declarations alone — no poller, no webhook, no route. These tests exercise
 * them through the same generic runtime a third-party integration would use.
 */

function poller(eventDef, { results, integration }) {
    const saved = [];
    const passCtx = makePassCtx({
        toolBudget: 10,
        executeTool: async (tool) => ({ results: typeof results === 'function' ? results(tool) : results }),
        resolveEntitlements: async () => ({ effective: { integration: new Set([integration]) } }),
    });
    const store = { updateSubscription: async (id, patch) => saved.push(patch) };
    return (lastCursor) => runPollDiff({ id: 's1', userId: 'u1', lastCursor }, eventDef, passCtx, { automationStore: store })
        .then(out => ({ ...out, cursor: saved[saved.length - 1]?.lastCursor }));
}

const aged = (cursor) => JSON.stringify({ ...JSON.parse(cursor), t: 0 });

test('a fully connected Google user is offered every declared Workspace source', () => {
    const apps = new Set(['gmail', 'google-calendar', 'google-drive', 'google-sheets', 'google-slides', 'google-contacts', 'google-keep']);
    const ids = buildAppEventProviders({ availableAppIds: apps }).map(p => p.id);
    assert.deepStrictEqual(ids, [
        'gmail', 'google-calendar', 'google-drive',
        'google-sheets', 'google-slides', 'google-contacts', 'google-keep',
    ]);
});

test('each Workspace provider appears only when its own app is connected', () => {
    for (const app of ['google-sheets', 'google-slides', 'google-contacts', 'google-keep']) {
        const ids = buildAppEventProviders({ availableAppIds: new Set([app]) }).map(p => p.id);
        assert.deepStrictEqual(ids, [app], `${app} is gated on itself alone`);
    }
    assert.deepStrictEqual(buildAppEventProviders({ availableAppIds: new Set(['gmail']) }).map(p => p.id), ['gmail']);
});

test('editing a spreadsheet fires once, naming modifiedTime', async () => {
    const ev = getEventDef('google-sheets', 'spreadsheet.changed');
    const sheet = (modifiedTime) => [{ id: 'sheet-1', name: 'Invoices', url: 'https://x', modifiedTime }];

    const run = poller(ev, { results: sheet('2026-05-11T09:02:00Z'), integration: 'google-sheets' });
    const first = await run(null);
    assert.deepStrictEqual(first.events, [], 'connecting the app fires nothing');

    const run2 = poller(ev, { results: sheet('2026-05-12T10:23:00Z'), integration: 'google-sheets' });
    const second = await run2(aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    assert.strictEqual(second.events[0].id, 'sheet-1');
    assert.strictEqual(second.events[0].name, 'Invoices');
    assert.deepStrictEqual(second.events[0].changedKeys, ['modifiedTime']);
});

test('a new spreadsheet fires the appear event, not the edit event', async () => {
    const changed = getEventDef('google-sheets', 'spreadsheet.changed');
    const created = getEventDef('google-sheets', 'spreadsheet.new');
    const one = [{ id: 'a', name: 'A', url: 'u', modifiedTime: 't1' }];
    const two = [...one, { id: 'b', name: 'B', url: 'u', modifiedTime: 't1' }];

    const anchorChanged = await poller(changed, { results: one, integration: 'google-sheets' })(null);
    const afterChanged = await poller(changed, { results: two, integration: 'google-sheets' })(aged(anchorChanged.cursor));
    assert.deepStrictEqual(afterChanged.events, [], 'an added file is not an edit');

    const anchorNew = await poller(created, { results: one, integration: 'google-sheets' })(null);
    const afterNew = await poller(created, { results: two, integration: 'google-sheets' })(aged(anchorNew.cursor));
    assert.strictEqual(afterNew.events.length, 1);
    assert.strictEqual(afterNew.events[0].id, 'b');
});

test('a contact changing its email fires with both values', async () => {
    const ev = getEventDef('google-contacts', 'contact.changed');
    const person = (email) => [{ resourceName: 'people/c1', displayName: 'Sanne', firstName: 'Sanne', lastName: '', email, phone: null, company: null }];

    const first = await poller(ev, { results: person('old@example.com'), integration: 'google-contacts' })(null);
    const second = await poller(ev, { results: person('new@example.com'), integration: 'google-contacts' })(aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    assert.deepStrictEqual(second.events[0].changedKeys, ['email']);
    assert.strictEqual(second.events[0].previous.email, 'old@example.com');
    assert.strictEqual(second.events[0].current.email, 'new@example.com');
});

test('a Keep note edit fires; an untouched note does not', async () => {
    const ev = getEventDef('google-keep', 'note.changed');
    const note = (content) => [{ noteId: 'notes/a', title: 'Boodschappen', type: 'text', content, updateTime: content }];

    const first = await poller(ev, { results: note('koffie'), integration: 'google-keep' })(null);
    const same = await poller(ev, { results: note('koffie'), integration: 'google-keep' })(aged(first.cursor));
    assert.deepStrictEqual(same.events, []);

    const edited = await poller(ev, { results: note('koffie, brood'), integration: 'google-keep' })(aged(first.cursor));
    assert.strictEqual(edited.events.length, 1);
    assert.strictEqual(edited.events[0].content, 'koffie, brood');
});

test('losing the app stops the polling instead of failing silently', async () => {
    const ev = getEventDef('google-keep', 'note.changed');
    const run = poller(ev, { results: [], integration: 'something-else' });
    assert.strictEqual((await run(null)).skipped, 'no_capability');
});

test('a picked spreadsheet switches the trigger to watching its rows (BFSF-480)', async () => {
    const ev = getEventDef('google-sheets', 'spreadsheet.changed');
    assert.ok(ev.configFields.some(f => f.key === 'spreadsheetId'), 'the declaration names its config');

    const calls = [];
    const runOnce = (values, lastCursor) => {
        const saved = [];
        const passCtx = makePassCtx({
            toolBudget: 10,
            executeTool: async (tool, args) => { calls.push({ tool, args }); return { values }; },
            resolveEntitlements: async () => ({ effective: { integration: new Set(['google-sheets']) } }),
        });
        const store = { updateSubscription: async (id, patch) => saved.push(patch) };
        const sub = {
            id: 's1', userId: 'u1', lastCursor,
            filter: { spreadsheetId: 'sheet-1', sheet: 'Invoices', range: 'A1:D100' },
        };
        return runPollDiff(sub, ev, passCtx, { automationStore: store })
            .then(out => ({ ...out, cursor: saved[saved.length - 1]?.lastCursor }));
    };

    const first = await runOnce([['date', 'who', 'amount'], ['2026-05-11', 'Acme', '100']], null);
    assert.deepStrictEqual(first.events, [], 'connecting the watch fires nothing');
    assert.strictEqual(calls[0].tool, 'sheets_get_values');
    assert.deepStrictEqual(calls[0].args, { spreadsheetId: 'sheet-1', range: "'Invoices'!A1:D100" });

    const second = await runOnce(
        [['date', 'who', 'amount'], ['2026-05-11', 'Acme', '120']],
        aged(first.cursor),
    );
    assert.strictEqual(second.events.length, 1);
    assert.strictEqual(second.events[0].rowIndex, 1);
    assert.deepStrictEqual(second.events[0].row, ['2026-05-11', 'Acme', '120']);
    assert.strictEqual(second.events[0].spreadsheetId, 'sheet-1');
    assert.strictEqual(second.events[0].sheet, 'Invoices');
});

test('without a picked spreadsheet the trigger still watches the file list', async () => {
    const ev = getEventDef('google-sheets', 'spreadsheet.changed');
    const run = poller(ev, { results: [{ id: 'a', name: 'A', url: 'u', modifiedTime: 't1' }], integration: 'google-sheets' });
    const first = await run(null);
    assert.ok(first.cursor, 'the base spec still polls sheets_list');
});
