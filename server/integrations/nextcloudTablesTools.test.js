/**
 * Nextcloud Tables tools.
 *
 * The interesting surface is the column-title ↔ column-id translation. The API
 * addresses cells by numeric column id; agents and routine bindings speak
 * titles. Getting that wrong in the silent direction — dropping a value whose
 * column the caller mis-spelled — would make a routine look like it stored a
 * form submission when it stored half of one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    NEXTCLOUD_TABLES_TOOLS,
    isNextcloudTablesTool,
    resolveValues,
    mapRow,
} = require('./nextcloudTablesTools');

const COLUMNS = [
    { id: 11, title: 'Company', type: 'text' },
    { id: 12, title: 'Year', type: 'number' },
    { id: 13, title: 'Status', type: 'selection' },
];

test('the prefix test matches this module and nothing broader', () => {
    assert.equal(isNextcloudTablesTool('nextcloud_tables_list_rows'), true);
    assert.equal(isNextcloudTablesTool('nextcloud_list_files'), false);
    assert.equal(isNextcloudTablesTool('nextcloud_talk_send_message'), false);
    assert.equal(isNextcloudTablesTool(undefined), false);
});

test('every tool declares a name, description and parameters object', () => {
    for (const t of NEXTCLOUD_TABLES_TOOLS) {
        assert.equal(t.type, 'function');
        assert.match(t.function.name, /^nextcloud_tables_/);
        assert.ok(t.function.description.length > 20, `${t.function.name} needs a real description`);
        assert.equal(t.function.parameters.type, 'object');
    }
});

test('values are resolved by column title, case-insensitively', () => {
    const out = resolveValues({ Company: 'Acme BV', status: 'active' }, COLUMNS);
    assert.deepEqual(out.data, [
        { columnId: 11, value: 'Acme BV' },
        { columnId: 13, value: 'active' },
    ]);
});

test('a numeric column id is accepted directly', () => {
    const out = resolveValues({ 12: 2026 }, COLUMNS);
    assert.deepEqual(out.data, [{ columnId: 12, value: 2026 }]);
});

test('an unknown column is an error, never a silent drop', () => {
    const out = resolveValues({ Company: 'Acme BV', Revenue: 100 }, COLUMNS);
    assert.ok(!out.data, 'must not return a partial write');
    assert.match(out.error, /Revenue/);
    assert.match(out.error, /Company, Year, Status/, 'tells the caller what is available');
});

test('rows come back keyed by column title', () => {
    const row = mapRow({
        id: 7,
        tableId: 34,
        createdBy: 'carol',
        data: [
            { columnId: 11, value: 'Acme BV' },
            { columnId: 13, value: 'active' },
        ],
    }, COLUMNS);
    assert.equal(row.id, 7);
    assert.equal(row.createdBy, 'carol');
    assert.deepEqual(row.values, { Company: 'Acme BV', Status: 'active' });
});

test('a value for a column that no longer exists is surfaced, not dropped', () => {
    // A column deleted between the read of the schema and the read of the rows
    // would otherwise vanish from the output with no trace.
    const row = mapRow({ id: 8, data: [{ columnId: 99, value: 'orphan' }] }, COLUMNS);
    assert.deepEqual(row.values, { column_99: 'orphan' });
});

test('a row with no cells produces an empty value map rather than throwing', () => {
    assert.deepEqual(mapRow({ id: 9 }, COLUMNS).values, {});
});
