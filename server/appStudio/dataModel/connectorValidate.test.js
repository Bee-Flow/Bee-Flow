// @typecheck
'use strict';

/**
 * validateConnectors, error by error: for each connector shape, the exact list
 * of errors (text and order) the persisted-model gate reports. The App Studio
 * builder model reads these, so a refactor that rewords or reorders one fails
 * here.
 *
 * Run: node --test appStudio/dataModel/connectorValidate.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { validateConnectors } = require('./connectorValidate');
// The row cap is an environment setting; the cases follow whatever it is.
const { MAX_CONNECTOR_ROWS } = require('../connectors/shared');

/** @param {Record<string, any>} [o] */
const rest = (o = {}) => ({ id: 'conn_aaaa', kind: 'rest', url: 'https://api.example.com/items', ...o });
/** @param {Record<string, any>} [o] */
const tool = (o = {}) => ({ id: 'conn_bbbb', kind: 'integration_tool', tool: 'nc_list', ...o });
/**
 * @param {number} i
 * @param {Record<string, any>} [o]
 */
const mail = (i, o = {}) => ({ id: 'conn_m00' + i, kind: 'mailbox', ...o });

/** @type {Array<[string, Record<string, any>, string[]]>} [case, model, exact errors] */
const CASES = [
    ['no connectors', { tables: [] },
        []],
    ['not an array', { connectors: {} },
        [
            "model.connectors must be an array",
        ]],
    ['too many', { connectors: Array.from({ length: 51 }, (_, i) => rest({ id: 'conn_' + String(1000 + i) })) },
        [
            "too many connectors: 51 > 50",
        ]],
    ['not an object', { connectors: [5, null] },
        [
            "connectors[0] must be an object",
            "connectors[1] must be an object",
        ]],
    ['bad id', { connectors: [rest({ id: 'c1' }), rest({ id: 5 })] },
        [
            "connectors[0].id must match conn_<hex>",
            "connectors[1].id must match conn_<hex>",
        ]],
    ['duplicate id', { connectors: [rest(), rest()] },
        [
            "connectors[1].id \"conn_aaaa\" is duplicated",
        ]],
    ['unknown kind skips the rest', { connectors: [{ id: 'conn_aaaa', kind: 'ftp', apiKey: 'x' }] },
        [
            "connectors[0].kind \"ftp\" is not a known connector kind",
        ]],
    ['long name', { connectors: [rest({ name: 'n'.repeat(201) }), rest({ id: 'conn_cccc', name: 5 })] },
        [
            "connectors[0].name exceeds 120 chars",
        ]],
    ['params not array', { connectors: [rest({ params: {} })] },
        [
            "connectors[0].params must be an array of { key, type?, required? }",
        ]],
    ['params', { connectors: [rest({ params: [{ key: 'a' }, { key: 'a', type: 5 }, { key: '1x' }, 5, { key: 'b', type: 'string' }] })] },
        [
            "connectors[0].params[1].key \"a\" is duplicated",
            "connectors[0].params[1].type must be a string",
            "connectors[0].params[2].key must match /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/",
            "connectors[0].params[3].key must match /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/",
        ]],
    ['too many params', { connectors: [rest({ params: Array.from({ length: 21 }, (_, i) => ({ key: 'p' + i })) })] },
        [
            "connectors[0] has too many params: 21 > 20",
        ]],
    ['inline secrets', { connectors: [rest({ apiKey: 'x', token: 'y', auth: { type: 'bearer' }, headers: { Authorization: 'b', 'X-Ok': '1' } })] },
        [
            "connectors[0].apiKey looks like an inline secret — attach credentials via auth.credentialProvider instead",
            "connectors[0].token looks like an inline secret — attach credentials via auth.credentialProvider instead",
            "connectors[0].headers[\"Authorization\"] looks like a secret header — use auth.credentialProvider instead of an inline value",
        ]],
    ['headers not object', { connectors: [rest({ headers: 'Authorization: x' })] },
        []],
    ['chain fixedArgs secret', { connectors: [tool({ chain: [{ tool: 'b', fixedArgs: { password: 'x', q: 1 } }, 5, { fixedArgs: 5 }] })] },
        [
            "connectors[0].chain[0].fixedArgs.password looks like an inline secret — attach credentials via auth.credentialProvider instead",
            "connectors[0].chain[1] must be an object",
            "connectors[0].chain[2] requires a tool name",
            "connectors[0].chain[2].fixedArgs must be an object",
        ]],
    ['auth not object', { connectors: [rest({ auth: 'x' })] },
        [
            "connectors[0].auth must be an object { type, header?, credentialProvider }",
        ]],
    ['auth extra keys', { connectors: [rest({ auth: { type: 't', header: 'h', credentialProvider: 5, value: 'x', extra: 1 } })] },
        [
            "connectors[0].auth.value is not allowed — auth may only carry { type, header?, credentialProvider }",
            "connectors[0].auth.extra is not allowed — auth may only carry { type, header?, credentialProvider }",
            "connectors[0].auth.credentialProvider must be a string provider id",
        ]],
    ['auth ok', { connectors: [rest({ auth: { type: 't', header: 'h', credentialProvider: 'p' } })] },
        []],
    ['sync unknown table', { tables: [], connectors: [rest({ sync: { tableId: 'tbl_x', mode: 'replace' } })] },
        [
            "connectors[0].sync.tableId \"tbl_x\" is not a table in this app — the connector fills it, so it cannot be removed while the connector exists",
        ]],
    ['sync table', { tables: [{ id: 'tbl_a', name: 'A', fields: [{ key: 'id', type: 'text' }] }], connectors: [rest({ sync: { tableId: 'tbl_a', mode: 'replace' } })] },
        []],
    ['retention unreachable', { tables: [{ id: 'tbl_a', name: 'A', fields: [{ key: 'id', type: 'text' }] }], connectors: [rest({ sync: { tableId: 'tbl_a', mode: 'replace', retentionDays: 5 } })] },
        [
            "connectors[0].sync.retentionDays promises data is deleted after 5 days, but nothing would ever delete rows from  — give the table a date column, or set retentionCascade on the child so it is removed with its parent",
        ]],
    ['chain on rest', { connectors: [rest({ chain: [] })] },
        [
            "connectors[0].chain is only supported for app connectors (integration_tool)",
        ]],
    ['method on tool', { connectors: [tool({ method: 'GET' }), { id: 'conn_dddd', kind: 'automation', automationId: 'a', body: 'x' }] },
        [
            "connectors[0].method and .body are only supported for rest connectors",
            "connectors[1].method and .body are only supported for rest connectors",
        ]],
    ['tool required', { connectors: [tool({ tool: '' }), tool({ id: 'conn_eeee', tool: 5 })] },
        [
            "connectors[0] (integration_tool) requires a tool name",
            "connectors[1] (integration_tool) requires a tool name",
        ]],
    ['tool fields', { connectors: [tool({ fixedArgs: [], integrationId: 'bad id!', runAs: 'admin', rowsPath: 5 })] },
        [
            "connectors[0].fixedArgs must be an object",
            "connectors[0].integrationId must be a provider id (letters/digits/_/:/-)",
            "connectors[0].runAs must be 'owner' or 'viewer'",
            "connectors[0].rowsPath must be a string dot-path",
        ]],
    ['tool fields ok', { connectors: [tool({ fixedArgs: { a: 1 }, integrationId: 'nextcloud', runAs: 'viewer', rowsPath: 'a.b' })] },
        []],
    ['tool integrationId number', { connectors: [tool({ integrationId: 5, runAs: 'owner' })] },
        [
            "connectors[0].integrationId must be a provider id (letters/digits/_/:/-)",
        ]],
    ['tool chain', { connectors: [tool({ chain: [{ tool: 'next', bind: { id: 'rows.id' } }] }), tool({ id: 'conn_ffff', chain: 'x' })] },
        [
            "connectors[1].chain must be an array of follow-up steps",
        ]],
    ['automation', { connectors: [{ id: 'conn_dddd', kind: 'automation' }, { id: 'conn_eeee', kind: 'automation', automationId: 'a' }] },
        [
            "connectors[0] (automation) requires an automationId",
        ]],
    ['rest url missing', { connectors: [rest({ url: '' }), rest({ id: 'conn_cccc', url: 5 })] },
        [
            "connectors[0] (rest) requires a url template",
            "connectors[1] (rest) requires a url template",
        ]],
    ['rest url bad', { connectors: [rest({ url: 'http://x.example.com/' }), rest({ id: 'conn_cccc', url: 'not a url' }), rest({ id: 'conn_dddd', url: 'https://{host}.example.com/' }), rest({ id: 'conn_eeee', url: 'https://x.example.com/{q}' })] },
        [
            "connectors[0].url must be https",
            "connectors[1].url is not a valid https URL template",
            "connectors[2].url may not template the host",
            "connectors[2].url references undeclared param {host} — add it to params[]",
            "connectors[3].url references undeclared param {q} — add it to params[]",
        ]],
    ['rest url declared', { connectors: [rest({ url: 'https://x.example.com/{q}', params: [{ key: 'q' }] })] },
        []],
    ['rest maxRows', { connectors: [rest({ maxRows: 0 }), rest({ id: 'conn_cccc', maxRows: 1.5 }), rest({ id: 'conn_dddd', maxRows: '5' }), rest({ id: 'conn_eeee', maxRows: 1e9 }), rest({ id: 'conn_ffff', maxRows: MAX_CONNECTOR_ROWS }), rest({ id: 'conn_gggg', maxRows: MAX_CONNECTOR_ROWS + 1 })] },
        [
            "connectors[0].maxRows must be a positive integer",
            "connectors[1].maxRows must be a positive integer",
            "connectors[2].maxRows must be a positive integer",
            `connectors[3].maxRows 1000000000 exceeds the cap of ${MAX_CONNECTOR_ROWS}`,
            `connectors[5].maxRows ${MAX_CONNECTOR_ROWS + 1} exceeds the cap of ${MAX_CONNECTOR_ROWS}`,
        ]],
    ['rest method', { connectors: [rest({ method: 'PUT' }), rest({ id: 'conn_cccc', method: 'POST' })] },
        [
            "connectors[0].method must be 'GET' or 'POST'",
        ]],
    ['rest body', { connectors: [rest({ body: '{}' }), rest({ id: 'conn_cccc', method: 'POST', body: '{"q":"{q}"}' }), rest({ id: 'conn_dddd', method: 'POST', body: 5 })] },
        [
            "connectors[0].body needs method: 'POST'",
            "connectors[1].body must be a JSON object or array",
            "connectors[2].body must be a JSON object or array",
        ]],
    ['rest paths', { connectors: [rest({ rowsPath: 5, nextPagePath: 6 }), rest({ id: 'conn_cccc', rowsPath: 'a', nextPagePath: 'b' })] },
        [
            "connectors[0].rowsPath must be a string dot-path",
            "connectors[0].nextPagePath must be a string dot-path",
        ]],
    ['mailbox', { connectors: [mail(1)] },
        [
            "connectors[0].provider must be one of gmail, outlook",
            "connectors[0] (mailbox) requires a sync block naming the table to write messages into",
        ]],
    ['mailbox fields', { connectors: [mail(1, { provider: 'imap', mode: 'x', folder: '../x', address: 'nope', query: 'a"b' })] },
        [
            "connectors[0].provider must be one of gmail, outlook",
            "connectors[0].mode must be one of personal, shared",
            "connectors[0].folder must be a simple folder or label name",
            "connectors[0].query has an unpaired quote",
            "connectors[0] (mailbox) requires a sync block naming the table to write messages into",
        ]],
    ['four mailboxes', { connectors: [mail(1), mail(2), mail(3), mail(4)] },
        [
            "connectors[0].provider must be one of gmail, outlook",
            "connectors[0] (mailbox) requires a sync block naming the table to write messages into",
            "connectors[1].provider must be one of gmail, outlook",
            "connectors[1] (mailbox) requires a sync block naming the table to write messages into",
            "connectors[2].provider must be one of gmail, outlook",
            "connectors[2] (mailbox) requires a sync block naming the table to write messages into",
            "connectors[3].provider must be one of gmail, outlook",
            "connectors[3] (mailbox) requires a sync block naming the table to write messages into",
            "an app may have at most 3 mailbox connectors (found 4)",
        ]],
    ['everything wrong at once', { connectors: [{ id: 'conn_zzzz', kind: 'rest', url: 'http://h/{p}', name: 'n'.repeat(300), params: [{ key: 'p' }, { key: 'p' }], secretKey: 1, headers: { 'X-Api-Key': 1 }, auth: { x: 1 }, chain: [{ fixedArgs: { token: 1 } }], maxRows: -1, method: 'DELETE', body: 'b', rowsPath: 1, nextPagePath: 1, sync: { tableId: 'none' } }] },
        [
            "connectors[0].name exceeds 120 chars",
            "connectors[0].params[1].key \"p\" is duplicated",
            "connectors[0].secretKey looks like an inline secret — attach credentials via auth.credentialProvider instead",
            "connectors[0].headers[\"X-Api-Key\"] looks like a secret header — use auth.credentialProvider instead of an inline value",
            "connectors[0].chain[0].fixedArgs.token looks like an inline secret — attach credentials via auth.credentialProvider instead",
            "connectors[0].auth.x is not allowed — auth may only carry { type, header?, credentialProvider }",
            "connectors[0].sync.tableId \"none\" is not a table in this app — the connector fills it, so it cannot be removed while the connector exists",
            "connectors[0].chain is only supported for app connectors (integration_tool)",
            "connectors[0].url must be https",
            "connectors[0].maxRows must be a positive integer",
            "connectors[0].method must be 'GET' or 'POST'",
            "connectors[0].body needs method: 'POST'",
            "connectors[0].rowsPath must be a string dot-path",
            "connectors[0].nextPagePath must be a string dot-path",
        ]],
];

test('validateConnectors reports exactly these errors, in this order', () => {
    for (const [name, model, want] of CASES) {
        /** @type {string[]} */
        const errors = [];
        validateConnectors(model, errors);
        assert.deepStrictEqual(errors, want, name);
    }
});

/** @param {Record<string, any>} [o] */
const sync = (o = {}) => ({ tableId: 'tbl_m', mode: 'upsert', keyField: 'provider_message_id', retentionDays: 30, ...o });
/** @param {Record<string, any>} [o] */
const m = (o = {}) => ({ id: 'conn_m001', kind: 'mailbox', provider: 'gmail', sync: sync(), ...o });
const MAILBOX_TABLES = [
    { id: 'tbl_m', name: 'Mail', fields: [{ key: 'provider_message_id', type: 'text' }, { key: 'thread_key', type: 'text' }, { key: 'received_at', type: 'datetime' }] },
    { id: 'tbl_c', name: 'Msgs', fields: [{ key: 'message_id', type: 'text' }] },
];

/** @type {Array<[string, Record<string, any>, string[]]>} [case, mailbox connector, exact errors] */
const MAILBOX_CASES = [
    ['mailbox baseline', m(),
        []],
    ['provider outlook', m({ provider: 'outlook' }),
        []],
    ['provider unknown', m({ provider: 'imap' }),
        [
            "connectors[0].provider must be one of gmail, outlook",
        ]],
    ['mode unknown', m({ mode: 'team' }),
        [
            "connectors[0].mode must be one of personal, shared",
        ]],
    ['shared without address', m({ mode: 'shared' }),
        [
            "connectors[0].address must be the shared mailbox's e-mail address",
        ]],
    ['shared bad address', m({ mode: 'shared', address: 'nope' }),
        [
            "connectors[0].address must be the shared mailbox's e-mail address",
        ]],
    ['shared address', m({ mode: 'shared', address: 'team@example.com' }),
        []],
    ['personal', m({ mode: 'personal', address: 5 }),
        []],
    ['sharedMode wrong for gmail', m({ sharedMode: 'delegated_mailbox' }),
        [
            "connectors[0].sharedMode is derived from the provider and must be \"delivered_alias\"",
        ]],
    ['sharedMode gmail', m({ sharedMode: 'delivered_alias' }),
        []],
    ['sharedMode outlook', m({ provider: 'outlook', sharedMode: 'delegated_mailbox' }),
        []],
    ['sharedMode wrong for outlook', m({ provider: 'outlook', sharedMode: 'x' }),
        [
            "connectors[0].sharedMode is derived from the provider and must be \"delegated_mailbox\"",
        ]],
    ['sharedMode null', m({ sharedMode: null }),
        []],
    ['folder ok', m({ folder: 'INBOX' }),
        []],
    ['folder traversal', m({ folder: '../x' }),
        [
            "connectors[0].folder must be a simple folder or label name",
        ]],
    ['folder number', m({ folder: 5 }),
        [
            "connectors[0].folder must be a simple folder or label name",
        ]],
    ['query number', m({ query: 5 }),
        [
            "connectors[0].query must be a string",
        ]],
    ['query long', m({ query: 'q'.repeat(1001) }),
        [
            "connectors[0].query exceeds 512 chars",
        ]],
    ['query control', m({ query: 'a\u0001b' }),
        [
            "connectors[0].query may not contain control characters",
        ]],
    ['query odd quote', m({ query: 'label:"a' }),
        [
            "connectors[0].query has an unpaired quote",
        ]],
    ['query paired quotes', m({ query: 'label:"a b"' }),
        []],
    ['outlook query', m({ provider: 'outlook', query: 'from:a@example.com' }),
        []],
    ['outlook query unsplittable', m({ provider: 'outlook', query: 'label:"x" OR (' }),
        [
            "connectors[0].query: The search ends where a term was expected.",
        ]],
    ['lookback', m({ lookbackDays: 0 }),
        [
            "connectors[0].lookbackDays must be a whole number between 1 and 90",
        ]],
    ['lookback 91', m({ lookbackDays: 91 }),
        [
            "connectors[0].lookbackDays must be a whole number between 1 and 90",
        ]],
    ['lookback fraction', m({ lookbackDays: 1.5 }),
        [
            "connectors[0].lookbackDays must be a whole number between 1 and 90",
        ]],
    ['lookback ok', m({ lookbackDays: 90 }),
        []],
    ['maxPerRun 0', m({ maxPerRun: 0 }),
        [
            `connectors[0].maxPerRun must be a whole number between 1 and ${MAX_CONNECTOR_ROWS}`,
        ]],
    ['maxPerRun string', m({ maxPerRun: '5' }),
        [
            `connectors[0].maxPerRun must be a whole number between 1 and ${MAX_CONNECTOR_ROWS}`,
        ]],
    ['maxPerRun ok', m({ maxPerRun: 10 }),
        []],
    ['flags', m({ includeBody: 'yes', includeAttachmentMeta: 1, groupIntoThreads: false }),
        [
            "connectors[0].includeBody must be true or false",
            "connectors[0].includeAttachmentMeta must be true or false",
        ]],
    ['onNewRecord junk', m({ onNewRecord: 'x' }),
        [
            "connectors[0].onNewRecord must be { actionId, target }",
        ]],
    ['onNewRecord object', m({ onNewRecord: { actionId: 'a', extra: 1 } }),
        [
            "connectors[0].onNewRecord.extra is not a setting; use actionId and target",
            "connectors[0].onNewRecord.target must be one of thread, inbound_message",
        ]],
    ['runAs', m({ runAs: 'admin' }),
        [
            "connectors[0].runAs must be 'owner' or 'viewer'",
        ]],
    ['runAs viewer', m({ runAs: 'viewer' }),
        []],
    ['integrationId mismatch', m({ integrationId: 'outlook' }),
        [
            "connectors[0].integrationId is derived from the provider and must match it",
        ]],
    ['integrationId match', m({ integrationId: 'gmail' }),
        []],
    ['auth', m({ auth: { type: 'x' } }),
        [
            "connectors[0].auth is not used by a mailbox — it runs on the connected account",
        ]],
    ['no sync', m({ sync: undefined }),
        [
            "connectors[0] (mailbox) requires a sync block naming the table to write messages into",
        ]],
    ['sync not object', m({ sync: 'x' }),
        [
            "connectors[0].sync must be an object",
            "connectors[0] (mailbox) requires a sync block naming the table to write messages into",
        ]],
    ['sync replace', m({ sync: sync({ mode: 'replace' }) }),
        [
            "connectors[0].sync.mode must be 'upsert' — replace would delete the conversation history on every run",
        ]],
    ['keyField wrong', m({ sync: sync({ keyField: 'id' }) }),
        [
            "connectors[0].sync.keyField must be 'provider_message_id' — it is what makes a re-listed row an update instead of a duplicate",
        ]],
    ['threads no children', m({ groupIntoThreads: true }),
        [
            "connectors[0].sync.keyField must be 'thread_key' — it is what makes a re-listed row an update instead of a duplicate",
            "connectors[0].sync.children must name the table the individual messages go into when groupIntoThreads is on",
        ]],
    ['threads keyField wrong', m({ groupIntoThreads: true, sync: sync({ keyField: 'message_id', children: [{ tableId: 'tbl_c', keyField: 'x' }] }) }),
        [
            "connectors[0].sync.children[0].level must be the grain this table stores (1 or higher)",
            "connectors[0].sync.children[0].relationField must be the column holding the parent's record",
            "connectors[0].sync.retentionDays promises data is deleted after 30 days, but nothing would ever delete rows from  — give the table a date column, or set retentionCascade on the child so it is removed with its parent",
            "connectors[0].sync.keyField must be 'thread_key' — it is what makes a re-listed row an update instead of a duplicate",
            "connectors[0].sync.children[0].keyField must be 'provider_message_id'",
        ]],
    ['threads child ok', m({ groupIntoThreads: true, sync: sync({ children: [{ tableId: 'tbl_c' }] }) }),
        [
            "connectors[0].sync.children[0].level must be the grain this table stores (1 or higher)",
            "connectors[0].sync.children[0].relationField must be the column holding the parent's record",
            "connectors[0].sync.retentionDays promises data is deleted after 30 days, but nothing would ever delete rows from  — give the table a date column, or set retentionCascade on the child so it is removed with its parent",
            "connectors[0].sync.keyField must be 'thread_key' — it is what makes a re-listed row an update instead of a duplicate",
        ]],
    ['retention missing', m({ sync: sync({ retentionDays: undefined }) }),
        [
            "connectors[0].sync.retentionDays is required for a mailbox — set how long messages are kept",
        ]],
    ['retention null', m({ sync: sync({ retentionDays: null }) }),
        [
            "connectors[0].sync.retentionDays is required for a mailbox — set how long messages are kept",
        ]],
    ['retention 0', m({ sync: sync({ retentionDays: 0 }) }),
        [
            "connectors[0].sync.retentionDays must be a whole number between 1 and 730",
        ]],
    ['retention too long', m({ sync: sync({ retentionDays: 100000 }) }),
        [
            "connectors[0].sync.retentionDays must be a whole number between 1 and 730",
        ]],
    ['retention string', m({ sync: sync({ retentionDays: '30' }) }),
        [
            "connectors[0].sync.retentionDays must be a whole number between 1 and 730",
        ]],
];

test('a mailbox connector reports exactly these errors, in this order', () => {
    for (const [name, connector, want] of MAILBOX_CASES) {
        /** @type {string[]} */
        const errors = [];
        validateConnectors({ tables: MAILBOX_TABLES, connectors: [connector] }, errors);
        assert.deepStrictEqual(errors, want, name);
    }
});
