// @typecheck
/**
 * #195: every nextcloud_* tool the product offers has a declared output schema
 * (shape + sample), so the builder binds real field names, builder_inspect_tool
 * answers with a shape, a forEach knows which list to walk, and a dry run of a
 * write previews the tool's real answer instead of a verb-suffix guess.
 *
 * The tools come from the product's own catalog (integrations/coreToolsets.js),
 * so a NEW nextcloud_* tool without an entry fails here, by name.
 *
 * Run: cd server && node --test automation/outputSchemas.nextcloudCoverage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TOOLSETS } = require('../integrations/coreToolsets');
const {
    OUTPUT_SCHEMAS, getOutputSchema, synthesizeDryRunOutput, iterableFieldsOf, describeShape, emptyDryRunOutput,
} = require('./outputSchemas');

/** Every nextcloud_* tool definition in the catalog, by name. */
function nextcloudTools() {
    /** @type {Map<string, any>} */
    const out = new Map();
    for (const list of Object.values(TOOLSETS)) {
        if (!Array.isArray(list)) continue;
        for (const t of /** @type {any[]} */ (list)) {
            const name = t?.function?.name || t?.name;
            if (typeof name === 'string' && name.startsWith('nextcloud_')) out.set(name, t.function || t);
        }
    }
    return out;
}

test('the catalog has the nextcloud tools (sanity: the walk found them)', () => {
    assert.ok(nextcloudTools().size > 100, `found ${nextcloudTools().size}`);
});

test('every nextcloud_* tool has an output schema with a shape and a sample', () => {
    const missing = [];
    for (const name of nextcloudTools().keys()) {
        const s = getOutputSchema(name);
        if (!s || !s.shape || s.sample === undefined) missing.push(name);
    }
    assert.deepEqual(missing, [], `no output schema for: ${missing.join(', ')} (add one to automation/outputSchemasNextcloud*.js, read off the handler's success return)`);
});

test('a sample carries every field its shape declares (except the optional ones)', () => {
    const bad = [];
    for (const name of nextcloudTools().keys()) {
        const { shape, sample } = OUTPUT_SCHEMAS[name];
        if (!sample || typeof sample !== 'object' || Array.isArray(sample) || shape._string) continue;
        for (const [k, desc] of Object.entries(shape)) {
            if (/undefined/.test(String(desc))) continue;
            if (!(k in sample)) bad.push(`${name}.${k}`);
        }
    }
    assert.deepEqual(bad, []);
});

test('an echo names an argument the tool declares, and a sample path that exists', () => {
    const bad = [];
    for (const [name, def] of nextcloudTools()) {
        const { echo, sample } = OUTPUT_SCHEMAS[name];
        if (!echo) continue;
        const params = def.parameters?.properties || {};
        for (const [path, arg] of Object.entries(echo)) {
            if (!(arg in params)) bad.push(`${name}: echo argument "${arg}" is not a parameter`);
            const parent = path.split('.').slice(0, -1).reduce((/** @type {any} */ at, k) => (at && typeof at === 'object' ? at[k] : undefined), sample);
            if (!parent || typeof parent !== 'object') bad.push(`${name}: echo path "${path}" has no parent in the sample`);
        }
    }
    assert.deepEqual(bad, []);
});

test('the shapes the live rounds tripped over (#195)', () => {
    // A create answers with the object under a key, not flat.
    assert.match(describeShape('nextcloud_notes_create'), /note: object/);
    assert.equal(synthesizeDryRunOutput('nextcloud_notes_create', {}).id, undefined);
    assert.equal(typeof synthesizeDryRunOutput('nextcloud_notes_create', {}).note.id, 'number');
    assert.equal(typeof synthesizeDryRunOutput('nextcloud_forms_create', {}).form.id, 'number');
    assert.equal(typeof synthesizeDryRunOutput('nextcloud_deck_create_stack', {}).stack.id, 'number');
    // An upload has a path; the event read is flat (dtstart, not event.summary).
    assert.deepEqual(Object.keys(OUTPUT_SCHEMAS.nextcloud_upload_file.shape), ['success', 'path', 'bytes', 'created', 'updated']);
    const ev = synthesizeDryRunOutput('nextcloud_calendar_get_event', {});
    assert.ok('summary' in ev && 'dtstart' in ev && !('event' in ev));
    // Lists a forEach can walk.
    assert.deepEqual(iterableFieldsOf('nextcloud_mail_search'), ['messages']);
    assert.deepEqual(iterableFieldsOf('nextcloud_tables_list_rows').sort(), ['columns', 'rows']);
    assert.deepEqual(iterableFieldsOf('nextcloud_notes_list'), ['notes']);
    assert.deepEqual(iterableFieldsOf('nextcloud_deck_list_cards'), ['cards']);
    assert.deepEqual(iterableFieldsOf('nextcloud_search_files'), ['items']);
});

test('nextcloud_deck_list_boards declares what the handler returns: labels, permissions and owner, no stacks', () => {
    const { shape, sample } = OUTPUT_SCHEMAS.nextcloud_deck_list_boards;
    assert.doesNotMatch(shape.boards, /stacks/);
    assert.match(shape.boards, /labels/);
    assert.match(shape.boards, /permissions/);
    assert.match(shape.boards, /owner/);
    const board = /** @type {any} */ (sample).boards[0];
    assert.ok(!('stacks' in board));
    assert.ok(['labels', 'permissions', 'owner'].every((k) => k in board));
});

test('a dry-run sample echoes the inputs it was given', () => {
    const up = synthesizeDryRunOutput('nextcloud_upload_file', { path: '/Reports/q3.pdf', content: 'x' });
    assert.equal(up.path, '/Reports/q3.pdf');
    const mail = synthesizeDryRunOutput('nextcloud_mail_send', { to: 'someone@example.test', subject: 'Your invoice' });
    assert.equal(mail.to, 'someone@example.test');
    assert.equal(mail.subject, 'Your invoice');
    const note = synthesizeDryRunOutput('nextcloud_notes_create', { title: 'Standup 28 Oct', content: '…' });
    assert.equal(note.note.title, 'Standup 28 Oct');
    // An absent, empty or structured argument leaves the sample's own value.
    assert.equal(synthesizeDryRunOutput('nextcloud_upload_file', {}).path, '/Reports/report.txt');
    assert.equal(synthesizeDryRunOutput('nextcloud_upload_file', { path: '' }).path, '/Reports/report.txt');
    assert.equal(synthesizeDryRunOutput('nextcloud_upload_file', { path: { kind: 'ref' } }).path, '/Reports/report.txt');
    // The sample itself is never changed by an echo.
    assert.equal(OUTPUT_SCHEMAS.nextcloud_upload_file.sample.path, '/Reports/report.txt');
});

test('an empty read in the tool\'s own shape: every list empty, counts 0, nothing from the sample', () => {
    assert.deepEqual(emptyDryRunOutput('nextcloud_notes_list', null), { count: 0, notes: [] });
    assert.deepEqual(emptyDryRunOutput('nextcloud_mail_search', { mailboxId: 3, count: 0, messages: [] }), { mailboxId: 3, count: 0, messages: [] });
    assert.deepEqual(emptyDryRunOutput('nextcloud_search_files', { query: 'x', count: 0 }), { query: 'x', count: 0, items: [] });
    const rows = /** @type {any} */ (emptyDryRunOutput('nextcloud_tables_list_rows', ''));
    assert.deepEqual(rows.rows, []);
    assert.equal(rows.tableId, null, 'a field the live answer did not carry is null, not the sample value');
    // A tool without a schema: the live answer stands.
    assert.equal(emptyDryRunOutput('no_such_tool', null), null);
});
