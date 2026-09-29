/**
 * The shipped mailbox table shapes, and the two places that hand them out.
 *
 * The shapes live in a leaf module so the editor catalog (componentSpecs.js)
 * can serve them without loading the connector. Both must still hand out the
 * SAME frozen objects: a copy in either place could drift from what the
 * connector writes, and a table created from the catalog would then miss the
 * columns (or the UNIQUE key) a sync run relies on. The shapes themselves are
 * tested in mailboxConnector.test.js.
 *
 * Run: cd server && node --test appStudio/mailboxTableTemplates.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const templates = require('./mailboxTableTemplates');
const mailboxConnector = require('./mailboxConnector');
const { buildCatalog } = require('./componentSpecs');

test('mailboxConnector re-exports the leaf module, not a copy', () => {
    const keys = [
        'MAILBOX_TABLE_TEMPLATE',
        'MAILBOX_THREAD_TABLE_TEMPLATE',
        'MAILBOX_ATTACHMENT_TABLE_TEMPLATE',
        'MAILBOX_TABLE_TEMPLATES',
    ];
    assert.deepStrictEqual(Object.keys(templates), keys);
    for (const key of keys) assert.strictEqual(mailboxConnector[key], templates[key], key);
});

test('the editor catalog serves the same frozen shapes', () => {
    const { mailboxTables } = buildCatalog();
    assert.strictEqual(mailboxTables, templates.MAILBOX_TABLE_TEMPLATES);
    assert.deepStrictEqual(Object.keys(mailboxTables), ['message', 'thread', 'attachment']);
    assert.strictEqual(mailboxTables.message, templates.MAILBOX_TABLE_TEMPLATE);
    assert.strictEqual(mailboxTables.thread, templates.MAILBOX_THREAD_TABLE_TEMPLATE);
    assert.strictEqual(mailboxTables.attachment, templates.MAILBOX_ATTACHMENT_TABLE_TEMPLATE);
    for (const shape of [mailboxTables, ...Object.values(mailboxTables)]) assert.ok(Object.isFrozen(shape));
});
