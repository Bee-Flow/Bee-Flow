// @typecheck
/**
 * executeSheetsTool dispatches by tool name: an unknown name and a missing
 * argument throw, and the read, append and create tools keep their requests
 * and answers. The Sheets and Drive clients come in through googleClient.
 *
 * Run: cd server && node --test integrations/sheetsTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const googleClient = require('./googleClient');
const { executeSheetsTool } = require('./sheetsTools');

/** A recording Sheets + Drive pair; every call lands in `calls` as [method, params]. */
function fakeGoogle() {
    /** @type {[string, any][]} */
    const calls = [];
    const rec = (/** @type {string} */ name, /** @type {any} */ data) => async (/** @type {any} */ params) => { calls.push([name, params]); return { data }; };
    const sheets = {
        spreadsheets: {
            get: rec('get', { properties: { title: 'Budget' }, sheets: [{ properties: { title: 'Q1' } }, { properties: { title: 'Q2' } }] }),
            create: rec('create', { spreadsheetId: 'new1' }),
            values: {
                get: rec('values.get', { range: 'Q1!A1:B2', values: [['a', 'b'], ['c']] }),
                append: rec('values.append', { updates: { updatedRange: 'Q1!A3:B3', updatedRows: 1, updatedCells: 2 } }),
                update: rec('values.update', {}),
            },
        },
    };
    const drive = { files: { list: rec('files.list', { files: [] }), get: rec('files.get', { parents: ['p0'] }), update: rec('files.update', {}) } };
    return { calls, client: { sheets, drive } };
}

/** @param {ReturnType<typeof fakeGoogle>['client']} client @param {() => Promise<unknown>} fn */
async function withClient(client, fn) {
    const orig = googleClient.createGoogleApiClient;
    googleClient.createGoogleApiClient = /** @type {any} */ (async () => client);
    try { return await fn(); } finally { googleClient.createGoogleApiClient = orig; }
}

const session = /** @type {any} */ ({});

test('an unknown name and a missing argument throw, as before', async () => {
    const { client } = fakeGoogle();
    await withClient(client, async () => {
        await assert.rejects(executeSheetsTool('sheets_nope', {}, session), { message: 'Unknown sheets tool: sheets_nope' });
        await assert.rejects(executeSheetsTool('sheets_append_rows', { spreadsheetId: 's' }, session), { message: 'spreadsheetId and range required' });
        await assert.rejects(executeSheetsTool('sheets_update_range', { spreadsheetId: 's', range: 'A1' }, session), { message: 'values must be a 2D array' });
    });
});

test('get_values reads the first tab and names the others; append and create keep their answers', async () => {
    const { client, calls } = fakeGoogle();
    await withClient(client, async () => {
        const read = /** @type {any} */ (await executeSheetsTool('sheets_get_values', { spreadsheetId: 's' }, session));
        assert.deepEqual([read.range, read.rowCount, read.colCount, read.availableTabs], ['Q1!A1:B2', 2, 2, ['Q1', 'Q2']]);
        assert.match(read.note, /^Read the first tab "Q1"\. This file has 2 tabs/);
        assert.deepEqual(await executeSheetsTool('sheets_append_rows', { spreadsheetId: 's', range: 'Q1', values: [['x', 'y']] }, session),
            { spreadsheetId: 's', updatedRange: 'Q1!A3:B3', rowsAppended: 1, cellsAppended: 2 });
        assert.deepEqual(await executeSheetsTool('sheets_create', { title: 'T', tabs: ['A'], folderId: 'f1' }, session),
            { spreadsheetId: 'new1', url: 'https://docs.google.com/spreadsheets/d/new1/edit', title: 'T' });
    });
    assert.deepEqual(calls.map(([name]) => name), ['get', 'values.get', 'values.append', 'create', 'files.get', 'files.update']);
    assert.deepEqual(calls[2][1].valueInputOption, 'USER_ENTERED');
    assert.deepEqual(calls[5][1], { fileId: 'new1', addParents: 'f1', removeParents: 'p0', supportsAllDrives: true });
});
