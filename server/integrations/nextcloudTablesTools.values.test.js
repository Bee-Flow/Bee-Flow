/**
 * Row writes and reads against a fake Tables server: selection labels, number
 * decimals, refused values, read-back of the stored row, honest truncation and
 * errors that never carry the server's own SQL text.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ncClient = require('./nextcloudClient');
const { json, installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');

test.after(resetFakeNc);

const { executeNextcloudTablesTool } = require('./nextcloudTablesTools');

const COLUMNS = [
    { id: 1, title: 'Name', type: 'text', subtype: 'line' },
    { id: 2, title: 'Status', type: 'selection', subtype: '', selectionOptions: JSON.stringify([{ id: 1, label: 'new' }, { id: 2, label: 'done' }]) },
    { id: 3, title: 'Amount', type: 'number', numberDecimals: 0 },
    { id: 4, title: 'Due', type: 'datetime', subtype: 'date' },
    { id: 5, title: 'Paid', type: 'selection', subtype: 'check' },
    { id: 6, title: 'Tags', type: 'selection', subtype: 'multi', selectionOptions: [{ id: 7, label: 'a' }, { id: 8, label: 'b' }] },
];

const cellsOf = (data, round) => Object.entries(data).map(([k, v]) => ({
    columnId: Number(k),
    value: round && k === '3' && typeof v === 'number' ? Math.trunc(v) : v,
}));

/** A fake server: stores what it is sent, rounding numbers to 0 decimals like the real one. */
function install({ rowsOnList = [], deleteStatus = 200, deleteBody = {} } = {}) {
    let stored = null;
    return installFakeNc(({ url, method, body }) => {
        if (/\/tables\/\d+\/columns$/.test(url)) return json(200, COLUMNS);
        if (/\/tables\/\d+\/rows$/.test(url) && method === 'POST') {
            // The write response echoes the request; storage rounds.
            stored = { id: 9, data: cellsOf(body.data, true) };
            return json(200, { id: 9, data: cellsOf(body.data, false) });
        }
        if (/\/rows\/9$/.test(url) && method === 'GET') return json(200, stored);
        if (/\/tables\/\d+\/rows\?/.test(url)) return json(200, rowsOnList.slice(0, Number(new URL(url).searchParams.get('limit'))));
        if (/\/rows\/\d+$/.test(url) && method === 'DELETE') return json(deleteStatus, deleteBody);
        return json(404, {});
    });
}

test('a selection label is written as its option id', async () => {
    const calls = install();
    const out = await executeNextcloudTablesTool('nextcloud_tables_create_row', { tableId: 5, values: { Status: 'done', Tags: ['a', 'b'], Paid: true } }, 'u', {});
    assert.equal(out.success, true);
    const post = calls.find(c => c.method === 'POST');
    assert.deepEqual(post.body.data, { 2: 2, 6: [7, 8], 5: 'true' });
    assert.equal(out.row.values.Status, 'done', 'read back as the label');
    assert.equal(out.row.values.Paid, true);
    assert.deepEqual(out.row.values.Tags, ['a', 'b']);
});

test('an unknown selection label, a non-number and a bad date are refused, not nulled', async () => {
    const calls = install();
    for (const values of [{ Status: 'nonsense' }, { Amount: 'notnum' }, { Due: 'garbage' }]) {
        const out = await executeNextcloudTablesTool('nextcloud_tables_create_row', { tableId: 5, values }, 'u', {});
        assert.ok(out.error, JSON.stringify(values));
        assert.equal(out.success, undefined);
    }
    assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'nothing was written');
});

test('the answer is the stored row, and a rounded number is reported', async () => {
    install();
    const out = await executeNextcloudTablesTool('nextcloud_tables_create_row', { tableId: 5, values: { Amount: 7.25 } }, 'u', {});
    assert.equal(out.row.values.Amount, 7);
    assert.match(out.warnings[0], /Amount.*7\.25.*stored as 7/);
});

test('create_column can set the decimals of a number column', async () => {
    const calls = [];
    ncClient.resolveAuth = async () => ({
        baseUrl: 'https://nc.example.test', authError: 'x',
        fetch: async (url, opts = {}) => { calls.push(JSON.parse(opts.body || '{}')); return json(200, { id: 1, title: 'A', type: 'number', numberDecimals: 2 }); },
    });
    await executeNextcloudTablesTool('nextcloud_tables_create_column', { tableId: 5, title: 'A', type: 'number', numberDecimals: 2 }, 'u', {});
    assert.equal(calls[0].numberDecimals, 2);
});

test('truncated is only true when more rows exist than were returned', async () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, data: [{ columnId: 1, value: `r${i}` }] }));
    install({ rowsOnList: rows(2) });
    const exact = await executeNextcloudTablesTool('nextcloud_tables_list_rows', { tableId: 5, limit: 2 }, 'u', {});
    assert.equal(exact.count, 2);
    assert.equal(exact.truncated, false);
    install({ rowsOnList: rows(3) });
    const more = await executeNextcloudTablesTool('nextcloud_tables_list_rows', { tableId: 5, limit: 2 }, 'u', {});
    assert.equal(more.count, 2);
    assert.equal(more.truncated, true);
    assert.equal(more.rows[0].values.Status, null, 'empty cells keep their key');
});

test('a 500 from the server never reaches the caller with its SQL text', async () => {
    install({ deleteStatus: 500, deleteBody: { message: 'SQLSTATE[42S02]: Base table oc_tables_rows_x not found' } });
    const out = await executeNextcloudTablesTool('nextcloud_tables_delete_row', { rowId: 99 }, 'u', {});
    assert.ok(out.error);
    assert.doesNotMatch(out.error, /SQL|oc_tables|SQLSTATE/i);
});

test('a missing column or row is not reported as "Tables is not installed"', async () => {
    install({ deleteStatus: 404 });
    const row = await executeNextcloudTablesTool('nextcloud_tables_delete_row', { rowId: 99 }, 'u', {});
    assert.doesNotMatch(row.error, /not installed/);
    const col = await executeNextcloudTablesTool('nextcloud_tables_delete_column', { columnId: 99 }, 'u', {});
    assert.doesNotMatch(col.error, /not installed/);
});

const { toWireValue, fromWireValue } = require('./nextcloudTablesValues');

test('time columns take HH:MM, date columns need an ISO date', () => {
    const time = { id: 1, title: 'At', type: 'datetime', subtype: 'time' };
    assert.deepEqual(toWireValue(time, '14:30'), { value: '14:30' });
    assert.ok(toWireValue(time, 'noon').error);
    const date = { id: 2, title: 'Due', type: 'datetime', subtype: 'date' };
    assert.deepEqual(toWireValue(date, '2026-09-19'), { value: '2026-09-19' });
    assert.ok(toWireValue(date, 'Sept 5').error);
    assert.ok(toWireValue(date, '').value === null);
});

test('a blank checkbox is false, and a selection without options refuses a label', () => {
    const check = { id: 1, title: 'Paid', type: 'selection', subtype: 'check' };
    assert.deepEqual(toWireValue(check, ''), { value: 'false' });
    assert.deepEqual(toWireValue(check, null), { value: 'false' });
    const bare = { id: 2, title: 'S', type: 'selection', subtype: '' };
    assert.ok(toWireValue(bare, 'done').error);
    assert.deepEqual(toWireValue(bare, 2), { value: 2 });
});

test('a multi selection stored as a JSON string reads back as labels', () => {
    const multi = { id: 3, title: 'Tags', type: 'selection', subtype: 'multi', selectionOptions: [{ id: 7, label: 'a' }, { id: 8, label: 'b' }] };
    assert.deepEqual(fromWireValue(multi, '[7,8]'), ['a', 'b']);
});

test('a failed re-read is reported as a warning', async () => {
    const calls = install();
    const base = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => {
        const ctx = await base();
        const f = ctx.fetch;
        const failingReread = async (url, opts) => {
            if (/\/rows\/9$/.test(url) && !opts?.method) return json(500, 'x');
            return f(url, opts);
        };
        return { ...ctx, fetch: failingReread };
    };
    const out = await executeNextcloudTablesTool('nextcloud_tables_create_row', { tableId: 5, values: { Name: 'a' } }, 'u', {});
    assert.ok(out.warnings.includes('Could not re-read the stored row; values are as sent.'));
    assert.ok(calls.length);
});
