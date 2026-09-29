/**
 * App Studio — connector shape detection.
 *
 * This module is the reason setting up a connector-filled table is one click
 * instead of a form, so the tests are about what it INFERS from a real payload:
 * the columns, the row identity, whether incremental loading is possible at all,
 * and which sibling action supplies a parameter the chosen one requires.
 *
 * The payload shapes below are the real ones from server/automation/
 * outputSchemas.js and the integration modules — Google's { results, total },
 * vPlan's { data, count, … }, Nextcloud's { count, activities }.
 *
 * Run: cd server && node --test appStudio/connectorSchema.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const cs = require('./connectorSchema');

// ── field inference ─────────────────────────────────────────────────

test('inferFields types each column from the sample and slugifies the key', () => {
    const fields = cs.inferFields([
        { id: 'm1', subject: 'Hi', modifiedTime: '2026-08-01T10:00:00Z', unread: true, sizeEstimate: 2048, dueDate: '2026-09-01' },
        { id: 'm2', subject: 'Yo', modifiedTime: '2026-08-02T10:00:00Z', unread: false, sizeEstimate: 512, dueDate: '2026-09-02' },
    ]);
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    // `id` is a system column on every table, so the upstream one is stored as
    // source_id — see the reserved-column tests below.
    assert.strictEqual(byKey.source_id.type, 'text');
    assert.strictEqual(byKey.subject.type, 'text');
    assert.strictEqual(byKey.modified_time.type, 'datetime', 'camelCase → snake_case, ISO string → datetime');
    assert.strictEqual(byKey.unread.type, 'bool');
    assert.strictEqual(byKey.size_estimate.type, 'number');
    assert.strictEqual(byKey.due_date.type, 'date', 'a date-only string is not a datetime');
    // The original upstream key is kept so the sync engine can map rows back.
    assert.strictEqual(byKey.modified_time.sourcePath, 'modifiedTime');
});

test('inferFields flattens one level of nesting and JSON-encodes the rest', () => {
    const fields = cs.inferFields([{ id: 1, sender: { name: 'A', email: 'a@b.nl' }, labels: ['INBOX'] }]);
    const keys = fields.map((f) => f.key);
    assert.ok(keys.includes('sender_name') && keys.includes('sender_email'), 'nested scalars get their own columns');
    assert.strictEqual(fields.find((f) => f.key === 'sender_email').sourcePath, 'sender.email');
    assert.strictEqual(fields.find((f) => f.key === 'labels').type, 'text', 'an array is stored as JSON text');
});

test('inferFields widens a column whose type differs between rows', () => {
    // A sync must never fail on row 400 because row 1 looked numeric.
    const fields = cs.inferFields([{ v: 12 }, { v: 'n/a' }]);
    assert.strictEqual(fields[0].type, 'text');
});

test('inferFields keeps a column that is null throughout rather than dropping it', () => {
    const fields = cs.inferFields([{ id: 'a', note: null }, { id: 'b', note: null }]);
    assert.strictEqual(fields.find((f) => f.key === 'note').type, 'text');
});

test('inferFields ignores runtime metadata and non-object rows', () => {
    const fields = cs.inferFields([{ id: 'a', _error: 'boom', _partial: true }, 'not an object']);
    assert.deepStrictEqual(fields.map((f) => f.sourcePath), ['id']);
});

// ── reserved system columns ─────────────────────────────────────────
// Every App Studio table already has id/created_at/updated_at/created_by/org_id,
// and validateDataModel rejects a declared field that claims one. Practically
// every upstream list has an `id`, so before this the proposal could not be
// saved AT ALL — propose, accept, save, 422.

test('inferFields renames a column that would claim a system column', () => {
    const { SYSTEM_COLUMNS } = require('./dataModel');
    const row = Object.fromEntries(SYSTEM_COLUMNS.map((c) => [c, 'v']));
    const fields = cs.inferFields([{ ...row, subject: 'Hi' }]);

    for (const f of fields) {
        assert.ok(!SYSTEM_COLUMNS.includes(f.key), `${f.key} must not be a system column`);
    }
    const byPath = Object.fromEntries(fields.map((f) => [f.sourcePath, f]));
    assert.strictEqual(byPath.id.key, 'source_id', 'readable, not a counter');
    assert.strictEqual(byPath.created_at.key, 'source_created_at');
    // Only the COLUMN moves: the sync engine maps on sourcePath and the author
    // still sees the upstream name.
    assert.strictEqual(byPath.id.sourcePath, 'id');
    assert.strictEqual(byPath.id.name, 'id');
});

test('inferFields still separates two upstream fields that both want source_id', () => {
    const fields = cs.inferFields([{ id: 'a', source_id: 'b' }]);
    const keys = fields.map((f) => f.key);
    assert.strictEqual(new Set(keys).size, 2, `distinct columns, got ${keys.join(', ')}`);
    assert.ok(keys.every((k) => k !== 'id'));
});

test('a proposed table from an id-bearing payload passes validateDataModel', () => {
    const { validateDataModel, newConnectorId } = require('./dataModel');
    const rows = [
        { id: 'm1', subject: 'Hi', created_at: '2026-08-01T10:00:00Z' },
        { id: 'm2', subject: 'Yo', created_at: '2026-08-02T10:00:00Z' },
    ];
    const shape = cs.inspectRows(rows, { name: 'Gmail — gmail search' });
    const { errors } = validateDataModel({
        modelVersion: 1,
        tables: [shape.suggestedTable],
        connectors: [{
            id: newConnectorId(), name: 'Gmail', kind: 'integration_tool',
            integrationId: 'gmail', tool: 'gmail_search',
            sync: { tableId: shape.suggestedTable.id, mode: 'upsert', keyField: shape.keyField },
        }],
    });
    assert.deepStrictEqual(errors, [], 'the exact model the editor saves must validate');
    // The upsert key is a SOURCE path, so it is unaffected by the column rename.
    assert.strictEqual(shape.keyField, 'id');
});

test('relationKeyFor never lands on a system column', () => {
    const set = cs.proposeTableSet([
        { level: 0, tool: 'x_list', rows: [{ name: 'a' }] },
        { level: 1, tool: 'x_get', parentLevel: 0, rows: [{ v: 1, _parentIndex: 0 }] },
    ], { name: 'org' });
    // The parent table is keyed `org`, so the naive `<parent>_ref` is fine — but
    // a parent keyed so the ref collides must still produce a legal column.
    assert.ok(!['id', 'created_at', 'updated_at', 'created_by', 'org_id'].includes(set.children[0].relationField));
});

// ── identity ────────────────────────────────────────────────────────

test('detectIdentity prefers a well-known id key', () => {
    const rows = [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }];
    assert.strictEqual(cs.detectIdentity(rows, cs.inferFields(rows)).sourcePath, 'id');
});

test('detectIdentity refuses a key that repeats — it would collapse rows on upsert', () => {
    const rows = [{ id: 'same', ref: 'r1' }, { id: 'same', ref: 'r2' }];
    assert.strictEqual(cs.detectIdentity(rows, cs.inferFields(rows)).sourcePath, 'ref');
});

test('detectIdentity refuses a key that is ever missing or empty', () => {
    const rows = [{ id: '', slug: 'a' }, { id: 'b', slug: 'b' }];
    assert.strictEqual(cs.detectIdentity(rows, cs.inferFields(rows)).sourcePath, 'slug');
});

test('detectIdentity answers null when nothing identifies a row', () => {
    const rows = [{ status: 'open' }, { status: 'open' }];
    assert.strictEqual(cs.detectIdentity(rows, cs.inferFields(rows)), null);
});

// ── watermark ───────────────────────────────────────────────────────

test('detectWatermark prefers an update stamp over a creation stamp', () => {
    const rows = [{ created_at: '2026-01-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }];
    assert.strictEqual(cs.detectWatermark(cs.inferFields(rows), rows).sourcePath, 'updated_at');
});

test('detectWatermark only trusts a name whose SAMPLE actually parses as a date', () => {
    // An upstream `date: 'every monday'` must not become a watermark.
    const rows = [{ id: 'a', date: 'every monday' }];
    assert.strictEqual(cs.detectWatermark(cs.inferFields(rows), rows), null);
});

test('detectWatermark refuses a plain counter that Date.parse would accept', () => {
    // Date.parse('2') is a valid date in V8 — a naive check would call this a
    // timestamp and every sync would compare integers as dates.
    const rows = [{ id: 'a', sequence: 2 }, { id: 'b', sequence: 3 }];
    assert.strictEqual(cs.detectWatermark(cs.inferFields(rows), rows), null);
});

test('detectWatermark accepts unix seconds inside a plausible range', () => {
    const rows = [{ id: 'a', updated: 1754042400 }];
    assert.strictEqual(cs.detectWatermark(cs.inferFields(rows), rows).sourcePath, 'updated');
});

// ── since-param ─────────────────────────────────────────────────────

test('detectSinceParam finds the request-side watermark parameter and its format', () => {
    assert.deepStrictEqual(cs.detectSinceParam({ properties: { updatedAfter: { type: 'string' } } }),
        { param: 'updatedAfter', format: 'iso' });
    assert.deepStrictEqual(cs.detectSinceParam({ properties: { since: { type: 'integer', description: 'Unix timestamp' } } }),
        { param: 'since', format: 'unix' });
    assert.deepStrictEqual(cs.detectSinceParam({ properties: { since: { type: 'string', description: 'Date, YYYY-MM-DD' } } }),
        { param: 'since', format: 'date' });
});

test('detectSinceParam REFUSES pagination cursors', () => {
    // Passing a stored watermark into a page token would resume from a stale
    // offset while looking like incremental loading worked.
    assert.strictEqual(cs.detectSinceParam({ properties: { pageToken: { type: 'string' } } }), null);
    assert.strictEqual(cs.detectSinceParam({ properties: { cursor: { type: 'string' } } }), null);
    assert.strictEqual(cs.detectSinceParam({ properties: { after: { type: 'string', description: 'Pagination cursor from a previous response.' } } }), null);
    assert.strictEqual(cs.detectSinceParam({ properties: { offset: { type: 'integer' } } }), null);
});

test('detectSinceParam answers null for an action with no parameters at all', () => {
    assert.strictEqual(cs.detectSinceParam(null), null);
    assert.strictEqual(cs.detectSinceParam({ properties: { query: { type: 'string' } } }), null);
});

// ── the three incremental tiers ─────────────────────────────────────

test("tier 'request': a watermark field AND a since-param", () => {
    const rows = [{ id: 'a', updated_at: '2026-08-01T00:00:00Z' }];
    const inc = cs.detectIncremental({ properties: { updatedAfter: { type: 'string' } } }, cs.inferFields(rows), rows);
    assert.deepStrictEqual(inc, { mode: 'request', field: 'updated_at', param: 'updatedAfter', format: 'iso' });
});

test("tier 'client': a watermark field but nothing to filter on", () => {
    const rows = [{ id: 'a', modifiedTime: '2026-08-01T00:00:00Z' }];
    const inc = cs.detectIncremental({ properties: { query: { type: 'string' } } }, cs.inferFields(rows), rows);
    assert.deepStrictEqual(inc, { mode: 'client', field: 'modifiedTime', param: null, format: 'iso' });
});

test("tier 'none': no timestamp anywhere → the option must not be offered", () => {
    const rows = [{ id: 'a', name: 'x' }];
    const inc = cs.detectIncremental({ properties: { updatedAfter: { type: 'string' } } }, cs.inferFields(rows), rows);
    assert.strictEqual(inc.mode, 'none', 'a since-param is useless without a field to compare');
});

// ── chain suggestion (the headline case) ────────────────────────────

test('suggestChain names the sibling action that supplies a required parameter', () => {
    const read = {
        name: 'gmail_read', label: 'gmail read',
        inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
    };
    const search = { name: 'gmail_search', label: 'gmail search', outputSample: { results: [{ id: '18f1', subject: 'Hi' }], total: 1 } };

    const { missing, suggestions } = cs.suggestChain(read, {}, [search]);
    assert.deepStrictEqual(missing, ['messageId']);
    assert.strictEqual(suggestions[0].tool, 'gmail_search');
    assert.strictEqual(suggestions[0].field, 'id', 'messageId ← the message list’s own id');
    assert.match(suggestions[0].why, /needs messageId/);
    assert.match(suggestions[0].why, /gmail search/);
});

test('suggestChain never proposes a WRITING action as a lookup', () => {
    const read = { name: 'x_read', inputSchema: { properties: { thingId: { type: 'string' } }, required: ['thingId'] } };
    const writer = { name: 'x_create', label: 'x create', sideEffect: true, outputSample: { id: 'new' } };
    const { suggestions } = cs.suggestChain(read, {}, [writer]);
    assert.deepStrictEqual(suggestions, []);
});

test('suggestChain says nothing about a parameter already pinned, asked or bound', () => {
    const read = { name: 'gmail_read', inputSchema: { properties: { messageId: { type: 'string' } }, required: ['messageId'] } };
    const search = { name: 'gmail_search', outputSample: { results: [{ id: 'a' }] } };
    assert.deepStrictEqual(cs.suggestChain(read, { fixedArgs: { messageId: 'm1' } }, [search]).missing, []);
    assert.deepStrictEqual(cs.suggestChain(read, { viewerParams: [{ key: 'messageId' }] }, [search]).missing, []);
});

test('suggestChain binds to the CURRENT rows when they already carry the field', () => {
    // Already have message rows in hand → no second action needed, just a binding.
    const read = { name: 'gmail_read', inputSchema: { properties: { messageId: { type: 'string' } }, required: ['messageId'] } };
    const { missing, suggestions } = cs.suggestChain(read, { fields: [{ sourcePath: 'id' }] }, []);
    assert.deepStrictEqual(missing, []);
    assert.strictEqual(suggestions[0].tool, null);
    assert.strictEqual(suggestions[0].field, 'id');
});

test('suggestChain reaches a field nested in an array (attachments[].id)', () => {
    const download = { name: 'gmail_download_attachment', label: 'download', inputSchema: { properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'] } };
    const read = { name: 'gmail_read', label: 'gmail read', outputSample: { attachments: [{ id: 'a1', name: 'x.pdf' }] } };
    const { suggestions } = cs.suggestChain(download, {}, [read]);
    assert.strictEqual(suggestions[0].tool, 'gmail_read');
    assert.ok(/id/.test(suggestions[0].field));
});

test('suggestChain falls back to a LIVE sample for a tool with no declared schema', () => {
    // vPlan, AFAS, NMBRS, Nextcloud and friends have no OUTPUT_SCHEMAS entry, so
    // a registry-only approach would fail for exactly those.
    const detail = { name: 'vplan_get_card', label: 'get card', inputSchema: { properties: { cardId: { type: 'string' } }, required: ['cardId'] } };
    const list = { name: 'vplan_list_cards', label: 'list cards' };   // no outputSample
    const live = { vplan_list_cards: [{ id: 'c1', subject: 'Job' }] };
    const { suggestions } = cs.suggestChain(detail, {}, [list], live);
    assert.strictEqual(suggestions[0].tool, 'vplan_list_cards');
    assert.strictEqual(suggestions[0].field, 'id');
});

// ── the whole proposal ──────────────────────────────────────────────

test('inspectRows proposes a table whose identity column is unique-indexed', () => {
    const rows = [
        { id: 'm1', subject: 'Hi', modifiedTime: '2026-08-01T10:00:00Z' },
        { id: 'm2', subject: 'Yo', modifiedTime: '2026-08-02T10:00:00Z' },
    ];
    const r = cs.inspectRows(rows, { name: 'Recent emails', inputSchema: { properties: { query: { type: 'string' } } } });

    assert.strictEqual(r.suggestedTable.key, 'recent_emails');
    assert.strictEqual(r.identity, 'id');
    assert.strictEqual(r.keyField, 'id');
    assert.strictEqual(r.defaultMode, 'upsert');
    const idCol = r.suggestedTable.fields.find((f) => f.sourcePath === 'id');
    assert.strictEqual(idCol.unique, true, 'a unique index is both the upsert lookup and the duplicate guard');
    assert.notStrictEqual(idCol.required, true, 'but not required — a later row missing it must not fail the sync');
    assert.strictEqual(r.incremental.mode, 'client');
});

test('inspectRows falls back to replace-mode when nothing identifies a row', () => {
    const r = cs.inspectRows([{ status: 'open' }, { status: 'open' }], { name: 'Statuses' });
    assert.strictEqual(r.identity, null);
    assert.strictEqual(r.defaultMode, 'replace');
});

test('inspectRows avoids colliding with a table key the app already has', () => {
    const r = cs.inspectRows([{ id: 'a' }], { name: 'Emails', existingKeys: ['emails', 'emails_2'] });
    assert.strictEqual(r.suggestedTable.key, 'emails_3');
});

test('inspectRows survives an empty result without throwing', () => {
    const r = cs.inspectRows([], { name: 'Nothing' });
    assert.deepStrictEqual(r.fields, []);
    assert.strictEqual(r.identity, null);
    assert.strictEqual(r.incremental.mode, 'none');
});

// ── Withings: the end-to-end shape a health sync depends on ─────────
// The Withings tools normalise on purpose (server/integrations/withingsTools.js)
// so that this inference lands on the right answer. These pin the contract
// between the two: change either side and one of these fails.

const WITHINGS_ROWS = [
    {
        measurement_key: 'withings:meas:900:1', source: 'withings', type: 'weight', type_id: 1,
        label: 'Weight', value: 81.3, unit: 'kg', measured_at: '2026-08-19T06:31:00.000Z',
        modified: 1_755_580_260, group_id: 900, device_id: 'dev-1', category: 'real',
    },
    {
        measurement_key: 'withings:meas:900:6', source: 'withings', type: 'fat_ratio', type_id: 6,
        label: 'Fat ratio', value: 18.55, unit: '%', measured_at: '2026-08-19T06:31:00.000Z',
        modified: 1_755_580_260, group_id: 900, device_id: 'dev-1', category: 'real',
    },
];

// The tool's declared parameters, trimmed to what detection reads.
const WITHINGS_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        types: { type: 'array', items: { type: 'string' } },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        lastupdate: { type: 'integer', description: 'Only return entries added or changed after this Unix timestamp (seconds).' },
        limit: { type: 'integer' },
    },
};

test('withings rows identify on measurement_key, so a re-sync upserts instead of duplicating', () => {
    const r = cs.inspectRows(WITHINGS_ROWS, { name: 'Measurements' });
    assert.strictEqual(r.keyField, 'measurement_key');
    assert.strictEqual(r.defaultMode, 'upsert');
});

test('withings pairs `modified` with `lastupdate` for request-tier incremental loading', () => {
    const fields = cs.inferFields(WITHINGS_ROWS);
    const inc = cs.detectIncremental(WITHINGS_INPUT_SCHEMA, fields, WITHINGS_ROWS);
    assert.strictEqual(inc.mode, 'request', 'client-tier would refetch the whole history every hour');
    assert.strictEqual(inc.field, 'modified');
    assert.strictEqual(inc.param, 'lastupdate');
    // Withings wants epoch seconds; an ISO string here is rejected as a bad param.
    assert.strictEqual(inc.format, 'unix');
});

test('epoch-second watermarks are recognised as timestamps at all', () => {
    // A plain integer only reads as a date inside looksLikeTimestamp's narrow
    // window — the guard that stops a row count being mistaken for one.
    assert.strictEqual(cs.looksLikeTimestamp(1_755_580_260), true);
    assert.strictEqual(cs.looksLikeTimestamp(42), false);
});

test('withings columns keep their real types (value numeric, measured_at a datetime)', () => {
    const byKey = Object.fromEntries(cs.inferFields(WITHINGS_ROWS).map((f) => [f.key, f]));
    assert.strictEqual(byKey.value.type, 'number');
    assert.strictEqual(byKey.measured_at.type, 'datetime');
    assert.strictEqual(byKey.type.type, 'text');
});
