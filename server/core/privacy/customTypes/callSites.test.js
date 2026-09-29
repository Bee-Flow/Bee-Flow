'use strict';
/**
 * One fixture, every door: an org with two of its own data types, and NO
 * guard installed (words and patterns need none). The same values must come
 * out as the admin's placeholders whichever way the text arrives: the chat
 * DLP scan, a routine step, a composed prompt, an attachment, a tool result.
 * Plus the layers around them: the tokenizer and restore, the neutraliser,
 * the allowlist, the ledger's row format, and the human labels.
 *
 * Real modules throughout; the database is an empty recorder, so nothing
 * here needs Postgres.
 *
 * Run: cd server && node --test core/privacy/customTypes/callSites.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'ci-session-secret-value-at-least-32-chars-long';
delete process.env.PII_SERVICE_URL;
require('../../http/routeHarness').recordDb();

const registry = require('./registry');
const { ALL_PII_CATEGORY_IDS } = require('../piiDetection/categories');
const pii = require('../piiDetection');
const { _resetLegacyRunner } = require('./legacyRunner');

const PROJ = 'cdt_00000000a1';
const CUST = 'cdt_00000000b2';
const TYPES = [
    { id: PROJ, name: 'Project code names', method: 'words', tokenKey: 'project_code', words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } },
    { id: CUST, name: 'Customer numbers', method: 'pattern', tokenKey: 'customer_number', pattern: { source: 'KL-\\d{5}', caseSensitive: false, engine: 're2' } },
];
const TEXT = 'Status of Falcon for customer KL-12345, please';
const SHIELD = {
    enabled: true, privacyScanEnabled: true, dlpEnabled: true, dlpScope: 'all', dlpMode: 'auto_redact',
    piiDetectionAction: 'tokenize', privacyAction: 'redact', piiFailureMode: 'fail_open',
    piiDetectionCategories: [...ALL_PII_CATEGORY_IDS, PROJ, CUST],
    toolPiiPolicy: { external: { blockCategories: [CUST] }, internal: { blockCategories: [] } },
    customTypesDigest: 'digest-1',
};

test.before(() => { registry._resetRegistry(); registry.syncOrg('org1', TYPES); });
test.after(() => _resetLegacyRunner());

const hidden = (s) => !s.includes('Falcon') && !s.includes('KL-12345');

test('tokenizer: the admin\'s placeholder, restored exactly, neutralised as confidential', () => {
    const entities = [
        { category: PROJ, label: 'Project code names', offset: 10, length: 6, text: 'Falcon' },
        { category: CUST, label: 'Customer numbers', offset: 30, length: 8, text: 'KL-12345' },
    ];
    const { tokenizedText, tokenMap } = pii.tokenizeText(TEXT, entities);
    assert.equal(tokenizedText, 'Status of [project_code_1] for customer [customer_number_1], please');
    assert.equal(pii.restoreTokens(tokenizedText, tokenMap), TEXT);
    assert.equal(pii.restoreTokens('see [projectcode1]', tokenMap), 'see Falcon', 'the model\'s drift restores too');
    assert.equal(pii._tokenCategoryKey({ category: PROJ }), 'project_code', 'the vault keys on the same prefix');
    assert.equal(pii._tokenCategoryKey({ category: 'cdt_00000000ff' }), 'custom', 'an unknown id never borrows a key');
    assert.equal(pii.neutraliseTokens('Ask [project_code_1] about [customer_number_1]'), 'Ask a confidential detail about a confidential detail');
    assert.equal(pii.neutraliseTokens('[client2_code_3] and [customterm_1]'), 'a personal detail and a confidential term',
        'a key with digits inside is still a token, never left for another reader\'s restore');
});

test('chat DLP: found without a guard; fail_open redacts, fail_closed blocks', async () => {
    const dlp = require('../../dlp/dlpRunner');
    const run = (over) => dlp.scan({
        messages: [{ role: 'user', content: TEXT }], orgShieldConfig: { ...SHIELD, ...over },
        conversationId: `conv-${Math.random()}`, providerConfig: {},
    });
    const open = await run({});
    assert.equal(open.action, 'redact');
    assert.equal(open.redactedText, 'Status of [project_code_1] for customer [customer_number_1], please');
    assert.equal(open.scanStatus, 'ok');
    assert.deepEqual(open.findings.map(f => f.source), ['custom', 'custom']);
    const closed = await run({ piiFailureMode: 'fail_closed' });
    assert.equal(closed.action, 'block');
    assert.equal(closed.reason, 'guard_not_installed', 'no guard is still a scan failure for the policy');
});

test('routines: the same placeholders in a step\'s input', async () => {
    const safety = require('../../automationRunner/safety');
    const { createTokenVault } = require('../../automationRunner/tokenVault');
    const ctx = { tokenVault: createTokenVault({}) };
    const policy = {
        shield: SHIELD, orgId: 'org1', piiEnabled: true, action: 'tokenize', regexRules: [], monitorIntegrations: true,
        scope: { toolInput: true }, privacyScope: 'external', confidence: 0.7, categories: SHIELD.piiDetectionCategories,
        failureMode: 'fail_open', largeInputPolicy: 'fail_open',
    };
    const r = await safety.guardToolInput({ body: TEXT }, policy, { organization_id: 'org1', step_id: 's1' }, 'live', ctx);
    assert.equal(r.value.body, 'Status of [project_code_1] for customer [customer_number_1], please');
    assert.equal(ctx.tokenVault.all()['[customer_number_1]'], 'KL-12345');
});

test('a composed prompt and an attachment: tokenised the same way', async () => {
    const { composeScan } = require('../../dlp/composeScan');
    const composed = await composeScan({ units: [TEXT, 'Falcon again'], orgShield: SHIELD });
    assert.ok(composed.units.every(hidden), JSON.stringify(composed.units));
    assert.equal(composed.units[1], '[project_code_1] again', 'one value, one token across units');

    const { scanAttachmentText } = require('../../dlp/attachmentScanner');
    const att = await scanAttachmentText({ text: TEXT, filename: 'a.txt', orgShield: SHIELD });
    assert.equal(att.action, 'tokenize');
    assert.ok(hidden(att.text), att.text);
    assert.deepEqual(Object.keys(att.summary.byCategory).sort(), ['Customer numbers', 'Project code names']);
});

test('a tool result: blocked by the type\'s switch, marked with its placeholder name', () => {
    const { redactAndTokenizeToolResult } = require('../../dlp/toolResultRedact');
    const entities = [
        { category: PROJ, label: 'Project code names', offset: 10, length: 6, text: 'Falcon' },
        // A span a custom type won from Organization: blocked through alsoCategories.
        { category: CUST, label: 'Customer numbers', offset: 30, length: 8, text: 'KL-12345', alsoCategories: ['Organization'] },
    ];
    const r = redactAndTokenizeToolResult(TEXT, entities, new Set(['Organization']), {});
    assert.equal(r.content, 'Status of [project_code_1] for customer [blocked:customer_number], please');
    assert.deepEqual(r.redactedLabels, ['Customer numbers']);
    assert.deepEqual(r.redactedLogLabels, [CUST], 'log lines get the id, never the name');
});

test('the allowlist never lets an org\'s own type through', () => {
    const { buildAllowMatcher, filterAllowedEntities } = require('../../dlp/allowTerms');
    const m = buildAllowMatcher({ piiAllowTerms: ['Falcon'] });
    const r = filterAllowedEntities([
        { category: PROJ, text: 'Falcon' },
        { category: 'Organization', text: 'Falcon' },
    ], m);
    assert.deepEqual(r.entities.map(e => e.category), [PROJ]);
});

test('the ledger stores a custom span by id and names it on the way out', () => {
    const { _pack, _unpack } = require('../../dlp/scanLedger');
    const row = _pack({ offset: 10, length: 6, category: PROJ, label: 'Project code names', confidence: 1, alsoCategories: ['Organization'] });
    assert.deepEqual(row, { o: 10, l: 6, c: PROJ, cf: 1, ac: ['Organization'] });
    assert.deepEqual(_unpack(row, 5), { offset: 15, length: 6, category: PROJ, label: 'Project code names', confidence: 1, alsoCategories: ['Organization'] });
    const builtIn = _pack({ offset: 1, length: 2, category: 'Person', label: 'Person Name', confidence: 0.9 });
    assert.deepEqual(builtIn, { o: 1, l: 2, c: 'Person', lb: 'Person Name', cf: 0.9 }, 'a built-in row packs exactly as before');
    assert.deepEqual(_unpack(builtIn, 0), { offset: 1, length: 2, category: 'Person', label: 'Person Name', confidence: 0.9 });
});

test('human labels: knowledge base refusals and memory scrubbing use the type\'s name', async () => {
    const { blockReason } = require('../../kb/ingestPrivacy');
    assert.equal(blockReason({ reason: 'pii' }, [PROJ, 'Email']),
        'Contains personal data (Project code names, Email) and this organisation does not store it');
    const { scrubMemoryContext } = require('../../memory/scrubMemoryContext');
    const r = await scrubMemoryContext('User works on Falcon.', SHIELD);
    assert.equal(r.scrubbed, 'User works on [Project code names].');
});

test('attachment cache: an edited type (a new digest) is a fresh scan, not a cache hit', async () => {
    const { scanAttachmentText } = require('../../dlp/attachmentScanner');
    const text = 'Falcon only, twice scanned';
    await scanAttachmentText({ text, filename: 'b.txt', orgShield: SHIELD });
    const hit = await scanAttachmentText({ text, filename: 'b.txt', orgShield: SHIELD });
    assert.equal(hit.summary.cacheHit, true);
    const miss = await scanAttachmentText({ text, filename: 'b.txt', orgShield: { ...SHIELD, customTypesDigest: 'digest-2' } });
    assert.equal(miss.summary.cacheHit, undefined);
});
