/**
 * Mailbox connector: validation, canonicalisation and cadence.
 *
 * Lives beside dataModel.test.js rather than inside it because it spans two
 * modules — the model contract and the scheduler that reads it.
 *
 * Run: cd server && node --test appStudio/mailboxModel.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const dataModel = require('./dataModel');
const connectorSync = require('./connectorSync');

const TABLE = {
    id: 'tbl_msgs',
    key: 'messages',
    name: 'Messages',
    fields: [
        { id: 'fld_aa01', key: 'provider_message_id', name: 'Message id', type: 'text', unique: true },
        { id: 'fld_bb02', key: 'received_at', name: 'Received', type: 'datetime' },
    ],
};

function mailbox(extra = {}) {
    return {
        id: 'conn_ab12cd',
        kind: 'mailbox',
        name: 'Support inbox',
        provider: 'gmail',
        mode: 'personal',
        sync: {
            tableId: TABLE.id,
            mode: 'upsert',
            keyField: 'provider_message_id',
            // The stamp retention is measured from. Spelled out because these
            // fixtures are validated RAW — canonicalizeMailboxConnector fills it
            // in on the save path, and a model that promises retentionDays with
            // no way to compute an age is now refused rather than accepted and
            // quietly never enforced.
            incremental: { field: 'received_at', format: 'iso' },
            retentionDays: 90,
            schedule: { everyMinutes: 2 },
        },
        ...extra,
    };
}

function validate(connectors) {
    const model = { modelVersion: 1, tables: [TABLE], roles: [], roleMapping: { default: 'app', byGroup: {} }, connectors };
    return dataModel.validateDataModel(model);
}

function errorsFor(connectors) {
    const res = validate(connectors);
    return Array.isArray(res) ? res : (res.errors || []);
}

// ── Happy path ───────────────────────────────────────────────────────────────

test('a minimal mailbox connector validates', () => {
    assert.deepStrictEqual(errorsFor([mailbox()]), []);
});

test('a shared Outlook mailbox validates when it names the address', () => {
    assert.deepStrictEqual(
        errorsFor([mailbox({ provider: 'outlook', mode: 'shared', address: 'support@acme.nl' })]),
        [],
    );
});

// ── Required fields ──────────────────────────────────────────────────────────

test('the provider is restricted to the two we can actually speak', () => {
    assert.ok(errorsFor([mailbox({ provider: 'imap' })]).some((e) => /provider must be one of/.test(e)));
    assert.ok(errorsFor([mailbox({ provider: undefined })]).some((e) => /provider must be one of/.test(e)));
});

test('a shared mailbox without an address is refused', () => {
    const errs = errorsFor([mailbox({ mode: 'shared' })]);
    assert.ok(errs.some((e) => /address must be the shared mailbox/.test(e)));
});

test('a mailbox without a sync block has nowhere to put its messages', () => {
    const c = mailbox();
    delete c.sync;
    assert.ok(errorsFor([c]).some((e) => /requires a sync block/.test(e)));
});

test('retention is REQUIRED — ingesting mail copies personal data', () => {
    const c = mailbox();
    delete c.sync.retentionDays;
    assert.ok(errorsFor([c]).some((e) => /retentionDays is required/.test(e)));

    c.sync.retentionDays = 0;
    assert.ok(errorsFor([c]).some((e) => /retentionDays must be a whole number/.test(e)));

    c.sync.retentionDays = 5000;
    assert.ok(errorsFor([c]).some((e) => /retentionDays must be a whole number/.test(e)));
});

test('the sync mode and key field are pinned', () => {
    // 'replace' would delete the conversation history on every run; any other
    // key field would turn the upsert into an append.
    const replace = mailbox();
    replace.sync.mode = 'replace';
    assert.ok(errorsFor([replace]).some((e) => /must be 'upsert'/.test(e)));

    const wrongKey = mailbox();
    wrongKey.sync.keyField = 'rfc822_message_id';
    assert.ok(errorsFor([wrongKey]).some((e) => /keyField must be 'provider_message_id'/.test(e)));
});

// ── Injection guards ─────────────────────────────────────────────────────────

test('folder is a URL segment, so traversal is refused', () => {
    for (const folder of ['../../users/ceo@acme.nl', 'in/box', 'inbox?$top=1', '']) {
        assert.ok(
            errorsFor([mailbox({ folder })]).some((e) => /folder must be a simple folder or label/.test(e)),
            `folder ${JSON.stringify(folder)} must be rejected`,
        );
    }
    assert.deepStrictEqual(errorsFor([mailbox({ folder: 'archive-2026' })]), []);
});

test('a quote in the query would break out of Graph $search="..."', () => {
    assert.ok(errorsFor([mailbox({ query: 'x" OR 1=1 "' })]).some((e) => /may not contain quotes/.test(e)));
    assert.ok(errorsFor([mailbox({ query: 'a'.repeat(600) })]).some((e) => /query exceeds/.test(e)));
    // A normal query with spaces is perfectly fine.
    assert.deepStrictEqual(errorsFor([mailbox({ query: 'from:klant.nl has:attachment' })]), []);
});

test('an author cannot claim a sharedMode the runtime cannot deliver', () => {
    // Gmail cannot reach a delegated mailbox at all, so this field is derived.
    assert.ok(
        errorsFor([mailbox({ sharedMode: 'delegated_mailbox' })]).some((e) => /sharedMode is derived from the provider/.test(e)),
    );
    // …but the value canonicalize stamps must validate, or validating a
    // canonical model would fail — which every save does.
    assert.deepStrictEqual(errorsFor([mailbox({ sharedMode: 'delivered_alias' })]), []);
    assert.deepStrictEqual(
        errorsFor([mailbox({ provider: 'outlook', sharedMode: 'delegated_mailbox' })]),
        [],
    );
});

test('a mailbox carries no credentials of its own', () => {
    assert.ok(
        errorsFor([mailbox({ auth: { credentialProvider: 'x' } })]).some((e) => /auth is not used by a mailbox/.test(e)),
    );
});

test('bounds on the pull window', () => {
    assert.ok(errorsFor([mailbox({ lookbackDays: 0 })]).some((e) => /lookbackDays/.test(e)));
    assert.ok(errorsFor([mailbox({ lookbackDays: 400 })]).some((e) => /lookbackDays/.test(e)));
    assert.ok(errorsFor([mailbox({ maxPerRun: 0 })]).some((e) => /maxPerRun/.test(e)));
    assert.ok(errorsFor([mailbox({ runAs: 'somebody' })]).some((e) => /runAs/.test(e)));
});

test('an app may not stack unlimited mailboxes', () => {
    const many = Array.from({ length: dataModel.MAX_MAILBOX_CONNECTORS + 1 }, (_, i) => mailbox({ id: `conn_aa${i}00` }));
    assert.ok(errorsFor(many).some((e) => /at most .* mailbox connectors/.test(e)));
});

test('chaining stays an integration_tool concept', () => {
    assert.ok(errorsFor([mailbox({ chain: [{ tool: 'x' }] })]).some((e) => /chain is only supported/.test(e)));
});

// ── Canonicalisation ─────────────────────────────────────────────────────────

test('defaults are filled and sharedMode is derived from the provider', () => {
    const { model } = dataModel.canonicalizeDataModel({
        tables: [TABLE],
        connectors: [{ id: 'conn_ab12cd', kind: 'mailbox', provider: 'outlook', address: 'Support@ACME.nl', sync: { tableId: TABLE.id } }],
    });
    const c = model.connectors[0];

    assert.strictEqual(c.mode, 'personal');
    assert.strictEqual(c.folder, 'inbox');
    assert.strictEqual(c.lookbackDays, 7);
    assert.strictEqual(c.maxPerRun, 100);
    assert.strictEqual(c.includeBody, true);
    assert.strictEqual(c.runAs, 'owner');
    assert.strictEqual(c.address, 'support@acme.nl', 'addresses are normalised');
    assert.strictEqual(c.integrationId, 'outlook', 'drives the viewer connect banner');
    assert.strictEqual(c.sharedMode, 'delegated_mailbox');
    assert.strictEqual(c.sync.mode, 'upsert');
    assert.strictEqual(c.sync.keyField, 'provider_message_id');
    assert.strictEqual(c.sync.retentionDays, 90);
});

test('gmail is canonicalised as a delivered alias, never a delegated mailbox', () => {
    const { model } = dataModel.canonicalizeDataModel({
        tables: [TABLE],
        connectors: [{ id: 'conn_ab12cd', kind: 'mailbox', provider: 'gmail', mode: 'shared', address: 'support@acme.nl', sync: { tableId: TABLE.id } }],
    });
    assert.strictEqual(model.connectors[0].sharedMode, 'delivered_alias');
});

test('an author-supplied sharedMode is replaced and reported', () => {
    const { model, repairs } = dataModel.canonicalizeDataModel({
        tables: [TABLE],
        connectors: [{ id: 'conn_ab12cd', kind: 'mailbox', provider: 'gmail', sharedMode: 'delegated_mailbox', sync: { tableId: TABLE.id } }],
    });
    assert.strictEqual(model.connectors[0].sharedMode, 'delivered_alias');
    assert.ok(repairs.some((r) => /sharedMode is server-derived/.test(r)));
});

// ── Retention actually reaches the data ──────────────────────────────────────
// The gap this closes: a mailbox promised 90 days, the purge could only find a
// date column on the ticket ROLL-UP, and every message body, sender address and
// attachment sat in child tables it skipped with a console.warn.

const THREAD_TABLE = {
    id: 'tbl_thr1', key: 'tickets', name: 'Tickets',
    fields: [
        { id: 'fld_cc01', key: 'thread_key', name: 'Conversation', type: 'text', unique: true },
        { id: 'fld_cc02', key: 'last_message_at', name: 'Last message', type: 'datetime' },
    ],
};
const ATT_TABLE = {
    id: 'tbl_att1', key: 'attachments', name: 'Attachments',
    fields: [
        { id: 'fld_dd01', key: 'message', name: 'Message', type: 'relation', relation: { table: TABLE.id } },
        { id: 'fld_dd02', key: 'filename', name: 'Filename', type: 'text' },
    ],
};

function threadedMailbox(childOverrides = {}, attOverrides = {}) {
    return {
        id: 'conn_ab12cd', kind: 'mailbox', provider: 'gmail', mode: 'personal',
        groupIntoThreads: true,
        sync: {
            tableId: THREAD_TABLE.id, mode: 'upsert', keyField: 'thread_key',
            incremental: { field: 'last_message_at', format: 'iso' },
            retentionDays: 90,
            children: [
                { tableId: TABLE.id, level: 1, relationField: 'ticket', keyField: 'provider_message_id', ...childOverrides },
                { tableId: ATT_TABLE.id, level: 2, parentLevel: 1, relationField: 'message', ...attOverrides },
            ],
        },
    };
}

const THREADED_TABLES = [
    THREAD_TABLE,
    { ...TABLE, fields: [...TABLE.fields, { id: 'fld_aa03', key: 'ticket', name: 'Ticket', type: 'relation', relation: { table: THREAD_TABLE.id } }] },
    ATT_TABLE,
];

function planFor(connector) {
    return connectorSync.planRetention({ tables: THREADED_TABLES }, connector);
}

test('planRetention reaches a child with its own date column, and one that cascades', () => {
    const plan = planFor(threadedMailbox({ retentionCascade: true }, { retentionCascade: true }));
    assert.deepStrictEqual(plan.unreachable, [], 'every table is covered');
    assert.deepStrictEqual(
        plan.steps.map((s) => [s.table.key, s.mode]),
        [['tickets', 'column'], ['messages', 'cascade'], ['attachments', 'cascade']],
        'parent-first: a cascade child runs only after its parent is gone',
    );
    assert.strictEqual(plan.steps[2].parentTable.key, 'messages', 'an attachment cascades from its MESSAGE, not the ticket');
});

test('planRetention names the tables nothing would ever delete from', () => {
    // No cascade, no date column of their own — exactly the shipped state that
    // kept every message body forever behind a 90-day promise.
    const plan = planFor(threadedMailbox());
    assert.deepStrictEqual(plan.unreachable, ['messages', 'attachments']);
    assert.deepStrictEqual(plan.steps.map((s) => s.table.key), ['tickets']);
});

test('a declared retentionField must exist on that table — no silent fallback', () => {
    const plan = planFor(threadedMailbox({ retentionField: 'sent_at' }, { retentionCascade: true }));
    assert.ok(plan.unreachable.includes('messages'), 'a typo must not resolve to the sync stamp behind the author\'s back');
});

test('a retention promise no purge can keep is refused at save time', () => {
    const model = {
        modelVersion: 1, tables: THREADED_TABLES, roles: [], roleMapping: { default: 'app', byGroup: {} },
        connectors: [threadedMailbox()],
    };
    const errors = dataModel.validateDataModel(model).errors;
    assert.ok(
        errors.some((e) => /nothing would ever delete rows from messages, attachments/.test(e)),
        `expected a retention-gap error, got: ${JSON.stringify(errors)}`,
    );
});

test('canonicalize defaults every mailbox child to cascading retention', () => {
    const { model } = dataModel.canonicalizeDataModel({ tables: THREADED_TABLES, connectors: [threadedMailbox()] });
    const children = model.connectors[0].sync.children;
    assert.strictEqual(children[0].retentionCascade, true);
    assert.strictEqual(children[1].retentionCascade, true);
    assert.deepStrictEqual(dataModel.validateDataModel(model).errors, [], 'the canonical form passes the gate');
});

test('canonicalize leaves a child that names its own retention column alone', () => {
    const { model } = dataModel.canonicalizeDataModel({
        tables: THREADED_TABLES,
        connectors: [threadedMailbox({ retentionField: 'received_at' })],
    });
    const children = model.connectors[0].sync.children;
    assert.strictEqual(children[0].retentionCascade, undefined);
    assert.strictEqual(children[0].retentionField, 'received_at');
});

test('a child cannot both cascade and name its own column', () => {
    const model = {
        modelVersion: 1, tables: THREADED_TABLES, roles: [], roleMapping: { default: 'app', byGroup: {} },
        connectors: [threadedMailbox({ retentionCascade: true, retentionField: 'received_at' }, { retentionCascade: true })],
    };
    assert.ok(dataModel.validateDataModel(model).errors.some((e) => /cannot both cascade/.test(e)));
});

// ── Cadence ──────────────────────────────────────────────────────────────────

test('a mailbox may poll every 2 minutes; everything else keeps the 15-minute floor', () => {
    assert.strictEqual(dataModel.minSyncMinutes('mailbox'), 2);
    assert.strictEqual(dataModel.minSyncMinutes('rest'), dataModel.MIN_SYNC_MINUTES);
    assert.strictEqual(dataModel.minSyncMinutes(null), dataModel.MIN_SYNC_MINUTES);

    // REGRESSION GUARD: lowering the mailbox floor must never lower it for a
    // REST connector pointed at somebody else's API.
    const rest = {
        id: 'conn_rest01', kind: 'rest', url: 'https://example.com/feed',
        sync: { tableId: TABLE.id, mode: 'replace', schedule: { everyMinutes: 2 } },
    };
    assert.ok(errorsFor([rest]).some((e) => /at least 15/.test(e)));
    assert.deepStrictEqual(errorsFor([mailbox()]), [], 'but 2 is fine for a mailbox');
});

test('nextRunFor uses the per-kind floor', () => {
    const from = Date.UTC(2026, 7, 5, 12, 0, 0);
    const sync = { schedule: { everyMinutes: 2 } };

    assert.strictEqual(connectorSync.nextRunFor(sync, from, 'mailbox'), new Date(from + 2 * 60_000).toISOString());
    // No kind → the old floor, so existing callers behave exactly as before.
    assert.strictEqual(connectorSync.nextRunFor(sync, from), new Date(from + dataModel.MIN_SYNC_MINUTES * 60_000).toISOString());
});

test('repeated failures back off, and a success clears the streak', () => {
    const from = Date.UTC(2026, 7, 5, 12, 0, 0);
    const sync = { schedule: { everyMinutes: 2 } };

    const first = connectorSync.nextRunFor(sync, from, 'mailbox', { consecutiveErrors: 1 });
    const third = connectorSync.nextRunFor(sync, from, 'mailbox', { consecutiveErrors: 3 });
    assert.strictEqual(first, new Date(from + 4 * 60_000).toISOString());
    assert.strictEqual(third, new Date(from + 16 * 60_000).toISOString());

    // Bounded, so a long-dead connector still retries hourly rather than never.
    const many = connectorSync.nextRunFor(sync, from, 'mailbox', { consecutiveErrors: 50 });
    assert.strictEqual(many, new Date(from + 60 * 60_000).toISOString());

    assert.strictEqual(
        connectorSync.nextRunFor(sync, from, 'mailbox'),
        new Date(from + 2 * 60_000).toISOString(),
        'a clean run returns to the normal cadence immediately',
    );
});

test("a provider's Retry-After outranks our own schedule", () => {
    const from = Date.UTC(2026, 7, 5, 12, 0, 0);
    const sync = { schedule: { everyMinutes: 2 } };
    const next = connectorSync.nextRunFor(sync, from, 'mailbox', { retryAfterMs: 10 * 60_000 });
    assert.strictEqual(next, new Date(from + 10 * 60_000).toISOString());
});

test('staleness follows the same per-kind floor', () => {
    const sync = { schedule: { everyMinutes: 2 } };
    assert.strictEqual(connectorSync.stalenessMs(sync, 'mailbox'), 2 * 60_000);
    assert.strictEqual(connectorSync.stalenessMs(sync), dataModel.MIN_SYNC_MINUTES * 60_000);
});

// ── Retention ────────────────────────────────────────────────────────────────

test('retention compiles to a bounded, parameterised delete', () => {
    // retentionDays is REQUIRED on a mailbox connector, so it has to actually
    // delete something — a required compliance field that did nothing would be
    // worse than no field at all.
    const queryCompiler = require('./queryCompiler');
    const owner = { where: '1=1', params: [] };
    const cutoff = '2026-05-07T00:00:00.000Z';

    const del = queryCompiler.compileDeleteOlderThan(TABLE, owner, { field: 'received_at', cutoffIso: cutoff });
    assert.match(del.sql, /^DELETE FROM "messages" WHERE 1=1 AND "received_at" IS NOT NULL AND "received_at" < \?$/);
    assert.deepStrictEqual(del.params, [cutoff]);
});

test('retention refuses an unknown column or a missing cutoff', () => {
    const queryCompiler = require('./queryCompiler');
    const owner = { where: '1=1', params: [] };
    assert.throws(
        () => queryCompiler.compileDeleteOlderThan(TABLE, owner, { field: 'nope', cutoffIso: '2026-05-07T00:00:00Z' }),
        /nope|unknown/i,
    );
    assert.throws(
        () => queryCompiler.compileDeleteOlderThan(TABLE, owner, { field: 'received_at', cutoffIso: '' }),
        /cutoff/i,
    );
});
