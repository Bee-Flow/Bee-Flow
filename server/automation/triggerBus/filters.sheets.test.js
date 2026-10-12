const test = require('node:test');
const assert = require('node:assert');

const { matchSheetsChangedFilter, pickMatcher } = require('./filters');

/**
 * google-sheets.spreadsheet.changed (BFSF-480). Narrowing by sheet/range
 * happens at the source (the declaration's contentWatch variant polls just
 * that range); the matcher is the backstop that keeps a file-level event for
 * the WRONG spreadsheet from firing a subscription that picked one.
 */

test('both google-sheets events route to the sheets matcher', () => {
    assert.strictEqual(pickMatcher('google-sheets', 'spreadsheet.changed'), matchSheetsChangedFilter);
    assert.strictEqual(pickMatcher('google-sheets', 'spreadsheet.new'), matchSheetsChangedFilter);
});

test('an empty filter passes; a missing payload does not', () => {
    const payload = { id: 'sheet-1', name: 'Invoices' };
    assert.strictEqual(matchSheetsChangedFilter(payload, undefined), true);
    assert.strictEqual(matchSheetsChangedFilter(payload, {}), true);
    assert.strictEqual(matchSheetsChangedFilter(null, {}), false);
});

test('spreadsheetId matches the file-level id and the content-watch echo', () => {
    const filePayload = { id: 'sheet-1', name: 'Invoices' };
    const rowPayload = { spreadsheetId: 'sheet-1', rowIndex: 3, row: ['a'] };
    const filter = { spreadsheetId: 'sheet-1' };
    assert.strictEqual(matchSheetsChangedFilter(filePayload, filter), true);
    assert.strictEqual(matchSheetsChangedFilter(rowPayload, filter), true);
    assert.strictEqual(matchSheetsChangedFilter({ id: 'other' }, filter), false);
});

test('nameContains narrows file-level events by spreadsheet name', () => {
    const payload = { id: 'sheet-1', name: 'Invoice tracker 2026' };
    assert.strictEqual(matchSheetsChangedFilter(payload, { nameContains: 'invoice' }), true);
    assert.strictEqual(matchSheetsChangedFilter(payload, { nameContains: 'payroll' }), false);
});
