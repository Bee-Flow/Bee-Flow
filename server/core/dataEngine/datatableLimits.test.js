'use strict';

/**
 * The datatable storage envelope as configuration: every cap is an
 * environment variable with a generous default, 0 means unlimited, a typo
 * keeps the default; the two table counts (tables people make, spreadsheet
 * tabs) are separate caps; and a refusal says which limit it is and what to
 * do, in the reader's language.
 *
 * DB-free: every check here hands its usage in, so no store is loaded.
 *
 * Run: cd server && node --test core/dataEngine/datatableLimits.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const { datatableLimits, assertDatatableQuota, localizeQuotaError, DEFAULTS } = require('./datatableLimits');

const ORG = { kind: 'org', id: 'org-1' };
const USER = { kind: 'user', id: 'u-1' };
const VARS = Object.keys(DEFAULTS);
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));

afterEach(() => {
    for (const k of VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

const usage = (over = {}) => ({ tables: 0, sheetTables: 0, rows: 0, bytes: 0, ...over });

test('the defaults are generous, and every cap is read from its own variable', () => {
    assert.deepStrictEqual(datatableLimits({}), {
        maxTablesPerScope: 200,
        maxSheetTablesPerScope: 2000,
        maxRowsPerTable: 100_000,
        maxRowsPerScope: 500_000,
        maxBytesPerScope: 256 * 1024 * 1024,
    });
    const L = datatableLimits({
        DATATABLE_MAX_TABLES_PER_SCOPE: '75', DATATABLE_MAX_SHEET_TABLES_PER_SCOPE: '10',
        DATATABLE_MAX_ROWS_PER_TABLE: '5', DATATABLE_MAX_ROWS_PER_SCOPE: '6', DATATABLE_MAX_MB_PER_SCOPE: '2',
    });
    assert.deepStrictEqual(L, { maxTablesPerScope: 75, maxSheetTablesPerScope: 10, maxRowsPerTable: 5, maxRowsPerScope: 6, maxBytesPerScope: 2 * 1024 * 1024 });
});

test('a typo keeps the default rather than meaning "unlimited"', () => {
    for (const raw of ['', '  ', 'lots', '-3', 'NaN']) {
        assert.strictEqual(datatableLimits({ DATATABLE_MAX_TABLES_PER_SCOPE: raw }).maxTablesPerScope, 200, JSON.stringify(raw));
    }
});

test('the table cap refuses with a sentence that says what to do, per kind of scope', async () => {
    process.env.DATATABLE_MAX_TABLES_PER_SCOPE = '3';
    await assertDatatableQuota(ORG, { addTables: 1, usage: usage({ tables: 2 }) });
    await assert.rejects(assertDatatableQuota(ORG, { addTables: 1, usage: usage({ tables: 3 }) }), (e) => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.code, 'quota_exceeded');
        assert.strictEqual(e.errorClass, 'datatable_quota');
        assert.strictEqual(e.expose, true);
        assert.deepStrictEqual([e.limit, e.used], [3, 3]);
        assert.strictEqual(e.messageKey, 'datatables.quota_tables_org');
        assert.strictEqual(e.message, 'This organisation already has 3 datatables, the most allowed is 3. Delete tables you no longer need under Studio → Datatables, or ask your administrator to raise the limit.');
        return true;
    });
    await assert.rejects(assertDatatableQuota(USER, { addTables: 1, usage: usage({ tables: 3 }) }),
        (e) => e.messageKey === 'datatables.quota_tables_user' && /^You already have 3 personal datatables/.test(e.message));
});

test('spreadsheet tabs count on their own cap: a scope full of them can still make tables, and the reverse', async () => {
    process.env.DATATABLE_MAX_TABLES_PER_SCOPE = '3';
    process.env.DATATABLE_MAX_SHEET_TABLES_PER_SCOPE = '5';
    await assertDatatableQuota(USER, { addTables: 1, usage: usage({ tables: 0, sheetTables: 500 }) });
    await assertDatatableQuota(USER, { addSheetTables: 1, usage: usage({ tables: 3, sheetTables: 4 }) });
    await assert.rejects(assertDatatableQuota(USER, { addSheetTables: 1, usage: usage({ sheetTables: 5 }) }), (e) => {
        assert.strictEqual(e.messageKey, 'datatables.quota_sheet_tabs');
        assert.match(e.message, /^You already have 5 spreadsheet tabs, the most allowed is 5\. Remove tabs you no longer need/);
        assert.match(e.message, /ask your administrator to raise the limit/);
        return true;
    });
});

test('0 means unlimited for every cap', async () => {
    for (const k of VARS) process.env[k] = '0';
    const huge = usage({ tables: 1e6, sheetTables: 1e6, rows: 1e9, bytes: 1e13 });
    await assertDatatableQuota(ORG, { addTables: 10, usage: huge });
    await assertDatatableQuota(USER, { addSheetTables: 10, usage: huge });
    await assertDatatableQuota(ORG, { table: { name: 'Big', rowCount: 1e8 }, addRows: 1000, usage: huge });
});

test('rows and storage stay one guard over every table, spreadsheet tabs included', async () => {
    process.env.DATATABLE_MAX_ROWS_PER_TABLE = '10';
    process.env.DATATABLE_MAX_ROWS_PER_SCOPE = '100';
    process.env.DATATABLE_MAX_MB_PER_SCOPE = '1';
    await assert.rejects(assertDatatableQuota(ORG, { table: { name: 'Leads', rowCount: 10 }, addRows: 1, usage: usage() }),
        (e) => e.messageKey === 'datatables.quota_rows_table' && /^The datatable "Leads" is full \(10 rows\)\. Delete rows/.test(e.message));
    await assert.rejects(assertDatatableQuota(ORG, { table: { rowCount: 0 }, addRows: 1, usage: usage({ rows: 100 }) }),
        (e) => e.messageKey === 'datatables.quota_rows_scope' && /already hold 100 rows, the most allowed is 100/.test(e.message));
    await assert.rejects(assertDatatableQuota(USER, { addSheetTables: 1, usage: usage({ bytes: 1024 * 1024 }) }),
        (e) => e.messageKey === 'datatables.quota_bytes' && /storage limit of 1 MB\. Delete rows or tables/.test(e.message));
    // A delete or an update adds nothing, so a full scope can always empty itself.
    await assertDatatableQuota(ORG, { usage: usage({ tables: 1e6, sheetTables: 1e6, rows: 1e9, bytes: 1e13 }) });
});

test('a refusal is put in the reader\'s language, and left in English when that cannot be done', async () => {
    const refusal = () => Object.assign(new Error('English'), { code: 'quota_exceeded', messageKey: 'datatables.quota_sheet_tabs', messageVars: { used: 5, limit: 5 } });
    const calls = [];
    const translate = async (locale, key, vars) => { calls.push([locale, key, vars]); return `NL ${vars.used}/${vars.limit}`; };

    const nl = await localizeQuotaError(refusal(), 'u-1', { getUser: async () => ({ preferredLocale: 'nl' }), translate });
    assert.strictEqual(nl.message, 'NL 5/5');
    assert.deepStrictEqual(calls, [['nl', 'datatables.quota_sheet_tabs', { used: 5, limit: 5 }]]);

    assert.strictEqual((await localizeQuotaError(refusal(), 'u-1', { getUser: async () => ({ preferredLocale: 'en-GB' }), translate })).message, 'English');
    assert.strictEqual((await localizeQuotaError(refusal(), 'u-1', { getUser: async () => { throw new Error('db down'); }, translate })).message, 'English');
    assert.strictEqual((await localizeQuotaError(refusal(), null, { translate })).message, 'English');
    const other = Object.assign(new Error('Something else'), { code: 'key_taken' });
    assert.strictEqual(await localizeQuotaError(other, 'u-1', { getUser: async () => ({ preferredLocale: 'nl' }), translate }), other);
    assert.strictEqual(other.message, 'Something else');
});

test('the real Dutch catalogue entry fills the same numbers', async () => {
    const { NL_TRANSLATIONS } = require('../../migrations/add-nl-datatable-quota-translations');
    const { translate } = require('../../i18n/translate');
    const e = Object.assign(new Error('English'), { code: 'quota_exceeded', messageKey: 'datatables.quota_tables_user', messageVars: { used: 200, limit: 200 } });
    await localizeQuotaError(e, 'u-1', {
        getUser: async () => ({ preferredLocale: 'nl-NL' }),
        translate: (locale, key, vars) => translate(locale, key, vars, { getStrings: async () => ({ ...NL_TRANSLATIONS }) }),
    });
    assert.match(e.message, /^Je hebt al 200 persoonlijke datatabellen, het maximum is 200\..*vraag je beheerder de limiet te verhogen\.$/);
});
