/**
 * Unit tests for server/core/dlp/attachmentScanner.js — DB-free.
 *
 * Run: cd server && node --test --test-timeout=20000 core/dlp/__tests__/attachmentScanner.test.js
 *
 * Two doubles, both installed before the module under test is required:
 *
 *  1. `../db` / `../../db` → the shared recording double (testUtils/mockDb).
 *     The scanner itself never queries, but its require graph does:
 *     piiDetection → stores/configStore, and dlpRunner lazily → `../../db`
 *     (token-map write-through) and stores/guardrailEventStore. Loading the
 *     real `db.js` constructs a pg Pool, so every scan sprayed
 *     ECONNREFUSED 127.0.0.1:5432 and the process never exited — the suite
 *     passed its 23 assertions and then died on the runner's timeout.
 *     Note the two spellings: installResolveStub matches the require string
 *     AS WRITTEN in each module ('../db' in the stores, '../../db' in
 *     dlpRunner); a missing spelling fails silently and loads the real pool.
 *
 *  2. `detectPii` on the piiDetection module object. The real detector needs
 *     Azure creds or a running guard-service. Everything else in that module
 *     stays real — tokenizeText, LEGACY_CATEGORY_ALIASES and the budget
 *     helpers are part of what these contracts pin.
 *
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../../../testUtils/stubRequire');
const { createRecordingDb } = require('../../../testUtils/mockDb');

// No seeded tables: no conversation row is ever read, so dlpRunner's owner
// lookup returns null and the vault/encryption paths stay out of the way.
// The token-map write-through is answered as "row updated" so the double
// behaves like a database that has the conversation, rather than warning about
// a missing row on every scan.
const mockDb = createRecordingDb({
    onQuery: (sql) => (/^UPDATE\s+(agent_conversations|direct_conversations|notebooks)\b/i.test(sql)
        ? { rows: [], rowCount: 1 }
        : undefined),
});
const restoreDbStub = installResolveStub({
    '../db': mockDb.db,      // stores/configStore, stores/guardrailEventStore, stores/piiVaultStore
    '../../db': mockDb.db,   // core/dlp/dlpRunner
});

// ── Mock detectPii ─────────────────────────────────────────────────
// We install a tiny mock that pretends to detect every email-like and
// IBAN-like substring. The real Azure call would burn quota and need
// network — both unacceptable for unit tests.
const azurePii = require('../../privacy/piiDetection');
const realDetectPii = azurePii.detectPii;

// `mockDelayMs` lets a single test inject artificial latency without
// re-requiring the scanner. The scanner captured `detectPii` via
// destructuring at require time, so we can't swap the function reference
// after the fact — we have to keep the same closure and toggle a flag.
let mockDelayMs = 0;
let mockDegraded = false;   // when true, every scan returns degraded=true
let lastCategories;         // category list the scanner asked the detector for
function mockDetectPii(text, categories) {
    lastCategories = categories;
    const entities = [];
    const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const ibanRegex = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g;
    let m;
    while ((m = emailRegex.exec(text))) {
        entities.push({ text: m[0], category: 'Email', offset: m.index, length: m[0].length, confidence: 0.95, label: 'Email Address' });
    }
    while ((m = ibanRegex.exec(text))) {
        entities.push({ text: m[0], category: 'InternationalBankingAccountNumber', offset: m.index, length: m[0].length, confidence: 0.95, label: 'IBAN' });
    }
    const payload = { hasPii: entities.length > 0, entities, redactedText: text };
    if (mockDegraded) { payload.degraded = true; payload.degradedReason = 'model_not_ready: test'; }
    if (mockDelayMs > 0) {
        return new Promise(resolve => setTimeout(() => resolve(payload), mockDelayMs));
    }
    return Promise.resolve(payload);
}
azurePii.detectPii = mockDetectPii;
// `attachmentScanner` captured a reference to `detectPii` at require time
// — re-require it AFTER patching so it sees the mock.
delete require.cache[require.resolve('../attachmentScanner')];

const { scanAttachmentText, applyAttachmentRedactionChoice, AttachmentPrivacyBlock, _resolveAction } = require('../attachmentScanner');
const dlpRunner = require('../dlpRunner');

after(() => {
    // Restore so other suites in the same process see the real fn.
    azurePii.detectPii = realDetectPii;
    restoreDbStub();
});

const SHIELD_TOKENIZE = {
    enabled: true,
    azurePiiEnabled: false,
    localPiiEnabled: true,
    piiDetectionAction: 'tokenize',
    piiDetectionCategories: [],
    privacyAction: 'redact',
    privacyScanEnabled: true,
};
const SHIELD_BLOCK = { ...SHIELD_TOKENIZE, piiDetectionAction: 'block', privacyAction: 'block' };
const SHIELD_OFF = { enabled: false, azurePiiEnabled: false, localPiiEnabled: false, privacyScanEnabled: false };
// Admin opted into hard-block on un-scannable large input.
const SHIELD_TOKENIZE_FAILCLOSED = { ...SHIELD_TOKENIZE, attachmentLargeInputPolicy: 'fail_closed' };
const SHIELD_BLOCK_FAILOPEN = { ...SHIELD_BLOCK, attachmentLargeInputPolicy: 'fail_open' };
// Admin opted OUT of hard-block: an incomplete scan yields a truncated document
// rather than a block. Must be explicit now — the default follows piiFailureMode,
// which is fail_closed, so a shield that says nothing blocks.
const SHIELD_TOKENIZE_FAILOPEN = { ...SHIELD_TOKENIZE, attachmentLargeInputPolicy: 'fail_open' };
// dlpMode:'ask' — the interactive review path (Fase 2). piiDetectionAction is
// deliberately left at its 'tokenize' default alongside it: _resolveAction
// must prefer dlpMode over the legacy field, not just work when the legacy
// field is absent.
const SHIELD_ASK = { ...SHIELD_TOKENIZE, dlpEnabled: true, dlpMode: 'ask' };
const SHIELD_ASK_FAILOPEN = { ...SHIELD_ASK, attachmentLargeInputPolicy: 'fail_open' };

test('passes when shield disabled', async () => {
    const r = await scanAttachmentText({
        text: 'Contact me at john@example.com',
        filename: 'note.txt',
        orgShield: SHIELD_OFF,
    });
    assert.strictEqual(r.action, 'pass');
    assert.strictEqual(r.text, 'Contact me at john@example.com');
    assert.deepStrictEqual(r.findings, []);
});

test('tokenises whole-text path', async () => {
    const conversationId = 'conv-' + Date.now();
    dlpRunner.clearConversationState(conversationId);
    const r = await scanAttachmentText({
        text: 'Reach out to alice@x.com or bob@y.com',
        filename: 'mail.txt',
        orgShield: SHIELD_TOKENIZE,
        conversationId,
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.ok(!/alice@x\.com/.test(r.text), 'tokenised text must not contain raw email');
    assert.ok(!/bob@y\.com/.test(r.text), 'tokenised text must not contain raw email');
    assert.strictEqual(r.findings.length, 2);
    // Tokens were merged into the conversation map.
    const map = dlpRunner.getConversationTokenMap(conversationId);
    const values = Object.values(map);
    assert.ok(values.includes('alice@x.com'));
    assert.ok(values.includes('bob@y.com'));
});

test('per-page offsets resolve correctly', async () => {
    const pages = [
        { pageNumber: 1, text: 'cover page no pii' },
        { pageNumber: 2, text: 'contact: jane@example.org for invoices' },
        { pageNumber: 3, text: 'IBAN NL91ABNA0417164300 attached' },
    ];
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'invoice.pdf',
        orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-pp-' + Date.now(),
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.strictEqual(r.findings.length, 2);
    const byPage = {};
    for (const f of r.findings) byPage[f.page] = (byPage[f.page] || 0) + 1;
    assert.strictEqual(byPage[2], 1, 'email expected on page 2');
    assert.strictEqual(byPage[3], 1, 'IBAN expected on page 3');
    // Tokens replaced in the flat text at the correct positions.
    assert.ok(!r.text.includes('jane@example.org'));
    assert.ok(!r.text.includes('NL91ABNA0417164300'));
    // Per-page summary populated.
    assert.ok(r.summary.pages[2]);
    assert.ok(r.summary.pages[3]);
});

test('empty pages do not drift later-page offsets', async () => {
    // Mimic the pdfExtractor return shape exactly: empty pages are kept in
    // the `pages` array, but `text` only contains non-empty pages joined by
    // '\n\n'. The scanner must walk only the non-empty pages so the rebuilt
    // offsets match `text` — otherwise tokenizeText would splice into the
    // wrong characters.
    const pages = [
        { pageNumber: 1, text: 'first page no pii' },
        { pageNumber: 2, text: '' }, // empty (image-only / blank)
        { pageNumber: 3, text: '' },
        { pageNumber: 4, text: 'real content with kate@x.com inside' },
    ];
    const flat = pages.filter(p => p.text).map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'sparse.pdf',
        orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-sparse-' + Date.now(),
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].page, 4);
    // The token must replace the email exactly — meaning offsets line up with
    // `flat`. If empty pages had drifted the offset, the email substring
    // would remain in r.text.
    assert.ok(!r.text.includes('kate@x.com'), 'email must be replaced (offset must match flat text)');
});

test('parallel scan yields the same findings as sequential', async () => {
    // Each page contains exactly one email; the scanner must find one
    // finding per page regardless of execution order under concurrency.
    const pages = Array.from({ length: 8 }, (_, i) => ({
        pageNumber: i + 1,
        text: `page ${i + 1} content email user${i + 1}@x.com here`,
    }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'parallel.pdf',
        orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-par-' + Date.now(),
        concurrency: 4,
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.strictEqual(r.findings.length, 8);
    const pagesHit = new Set(r.findings.map(f => f.page));
    assert.strictEqual(pagesHit.size, 8, 'every page should have exactly one finding');
    for (let i = 1; i <= 8; i++) assert.ok(pagesHit.has(i), `page ${i} missing from findings`);
});

test('scan deadline blocks by default (follows piiFailureMode)', async () => {
    // Inject 200 ms latency per page. With concurrency=2 and a 100 ms ceiling,
    // every page overshoots the budget and the scan is incomplete.
    //
    // This test used to assert `action === 'pass'` and, explicitly,
    // "text returned unchanged on timeout" — i.e. it locked in the leak. A
    // shield that expresses no opinion now follows piiFailureMode (fail_closed),
    // so an unfinished scan blocks instead of shipping unchecked pages.
    mockDelayMs = 200;
    try {
        const pages = Array.from({ length: 4 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));
        const flat = pages.map(p => p.text).join('\n\n');
        const r = await scanAttachmentText({
            text: flat,
            pages,
            filename: 'slow.pdf',
            orgShield: SHIELD_TOKENIZE,
            conversationId: 'conv-deadline-' + Date.now(),
            concurrency: 2,
            maxScanMs: 100,
        });
        assert.strictEqual(r.action, 'block');
        assert.strictEqual(r.reason, 'timeout');
        assert.strictEqual(r.summary.timeout, true);
        assert.strictEqual(r.summary.held, true);
        assert.strictEqual(r.text, null, 'a blocked attachment must carry no text');
    } finally {
        mockDelayMs = 0;
    }
});

test('timeout under fail_open truncates instead of leaking the tail', async () => {
    // The incident, as a regression test. Pages 1..k are scanned before the
    // deadline; the rest were never checked. Under fail_open the user still
    // gets an answer, but the unchecked tail must NOT be in the outgoing text.
    mockDelayMs = 200;
    try {
        const pages = Array.from({ length: 8 }, (_, i) => ({
            pageNumber: i + 1,
            text: i === 0 ? 'first page, harmless' : `SECRET-TAIL-${i + 1} confidential`,
        }));
        const flat = pages.map(p => p.text).join('\n\n');
        const r = await scanAttachmentText({
            text: flat, pages, filename: 'tail.pdf',
            orgShield: SHIELD_TOKENIZE_FAILOPEN,
            conversationId: 'conv-trunc-' + Date.now(),
            concurrency: 1, maxScanMs: 250,
        });
        assert.ok(r.action === 'pass' || r.action === 'tokenize', 'fail_open must not block');
        assert.strictEqual(r.summary.timeout, true);
        assert.ok(r.summary.scannedPages < pages.length, 'precondition: scan really was partial');
        assert.strictEqual(r.summary.truncated, true);
        // The heart of it: nothing from an unscanned page may survive.
        for (let i = r.summary.scannedPages; i < pages.length; i++) {
            assert.ok(
                !r.text.includes(`SECRET-TAIL-${i + 1}`),
                `page ${i + 1} was never scanned and must not appear in the outgoing text`,
            );
        }
        // Length is not the invariant — the marker can outweigh a short tail on
        // a small fixture. What must hold is how much of the SOURCE travelled.
        assert.ok(r.summary.sentChars < r.summary.totalChars,
            `only the scanned prefix may travel (${r.summary.sentChars} of ${r.summary.totalChars} chars)`);
        assert.ok(/truncated/i.test(r.text), 'the model must be told the document was cut');
    } finally {
        mockDelayMs = 0;
    }
});

test('per-page budget scales with page count', async () => {
    // The regression that caused the incident: the budget was a flat number for
    // the whole document, so page count alone decided whether pages got scanned.
    // 12 pages x 40ms of latency cannot fit in a 100ms document budget, but does
    // fit comfortably when each page carries its own allowance.
    mockDelayMs = 40;
    try {
        const pages = Array.from({ length: 12 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1} text` }));
        const flat = pages.map(p => p.text).join('\n\n');
        const r = await scanAttachmentText({
            text: flat, pages, filename: 'many-pages.pdf',
            orgShield: SHIELD_TOKENIZE,
            conversationId: 'conv-perpage-' + Date.now(),
            concurrency: 2,
            perPageBudgetMs: 200,   // 12 x 200 = 2400ms of allowance
            maxScanMs: 10_000,
        });
        assert.strictEqual(r.summary.timeout, false, 'a per-page budget must not time out on page count alone');
        assert.strictEqual(r.summary.scannedPages, 12, 'every page must be scanned');
    } finally {
        mockDelayMs = 0;
    }
});

test('count is distinct values, not occurrences', async () => {
    // The badge must equal the number of rows in the TOKEN MAPPING table.
    // One person mentioned on every page is ONE value, not ten mentions.
    const pages = Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        text: `line ${i + 1}: contact repeat@same.com for details`,
    }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat, pages, filename: 'repeat.pdf',
        orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-distinct-' + Date.now(),
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.strictEqual(r.summary.mentions, 10, 'ten occurrences');
    assert.strictEqual(r.summary.count, 1, 'but one distinct value');
    assert.strictEqual(Object.keys(r.tokenMap).length, r.summary.count,
        'the badge number must equal the number of token-mapping rows');
});

test('block-mode short-circuits', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        text: i === 1 ? 'leak: dan@oops.com' : `page ${i + 1} no pii`,
    }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'report.pdf',
        orgShield: SHIELD_BLOCK,
        conversationId: 'conv-blk-' + Date.now(),
    });
    assert.strictEqual(r.action, 'block');
    assert.strictEqual(r.text, null);
    assert.ok(r.findings.length >= 1);
    // First hit is on page 2; scanner should not have walked past it.
    assert.ok(r.findings.every(f => f.page <= 2), 'block-mode scanner should short-circuit on first hit');
});

test('overflow flag set past maxPages', async () => {
    const pages = Array.from({ length: 55 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat,
        pages,
        filename: 'big.pdf',
        orgShield: SHIELD_TOKENIZE_FAILOPEN,
        maxPages: 50,
    });
    assert.strictEqual(r.action, 'pass');
    assert.strictEqual(r.summary.overflow, true);
    // Pages past the cap were never scanned, so they must not travel.
    assert.strictEqual(r.summary.truncated, true);
    assert.ok(!r.text.includes('page 55'), 'a page beyond the cap must not appear in the outgoing text');
});

test('cache hit reuses prior scan + merges tokens to new conv', async () => {
    const text = 'Repeat scan: zoe@cache.com';
    const filename = 'cache.txt';
    const conversationA = 'conv-cache-a';
    const conversationB = 'conv-cache-b';
    dlpRunner.clearConversationState(conversationA);
    dlpRunner.clearConversationState(conversationB);

    const r1 = await scanAttachmentText({ text, filename, orgShield: SHIELD_TOKENIZE, conversationId: conversationA });
    assert.strictEqual(r1.action, 'tokenize');
    assert.ok(!r1.summary.cacheHit, 'first scan must be a miss');

    const r2 = await scanAttachmentText({ text, filename, orgShield: SHIELD_TOKENIZE, conversationId: conversationB });
    assert.strictEqual(r2.action, 'tokenize');
    assert.strictEqual(r2.summary.cacheHit, true, 'second scan must be a cache hit');
    // Cache hit still propagates tokens to the new conversation's map.
    const mapB = dlpRunner.getConversationTokenMap(conversationB);
    assert.ok(Object.values(mapB).includes('zoe@cache.com'));
});

test('cache hit does not rebind the new conversation\'s tokens', async () => {
    // The cache key is a process-wide hash of (text + policy) — no conversation
    // in it. Replaying the FIRST conversation's token map into a second one
    // rebound tokens the second conversation had already minted for a different
    // value: [email_1] stopped meaning bob@corp.com, which both mis-restores
    // already-stored turns and drops bob@corp.com out of the outbound
    // re-tokeniser, so later text containing it goes to the provider in clear.
    const text = 'Attached invoice, contact zoe@rebind.com for questions.';
    const convA = 'conv-rebind-a-' + Date.now();
    const convB = 'conv-rebind-b-' + Date.now();
    dlpRunner.clearConversationState(convA);
    dlpRunner.clearConversationState(convB);

    // A scans the attachment first and mints [email_1] for zoe.
    await scanAttachmentText({ text, filename: 'rebind.txt', orgShield: SHIELD_TOKENIZE, conversationId: convA });

    // B already minted [email_1] for a different person on an earlier turn.
    dlpRunner.mergeTokenMap(convB, { '[email_1]': 'bob@corp.com' });

    // B uploads the same attachment → cache hit.
    const r = await scanAttachmentText({ text, filename: 'rebind.txt', orgShield: SHIELD_TOKENIZE, conversationId: convB });
    assert.strictEqual(r.summary.cacheHit, true, 'second scan must be a cache hit');

    const mapB = dlpRunner.getConversationTokenMap(convB);
    assert.strictEqual(mapB['[email_1]'], 'bob@corp.com',
        'a cache hit must not rebind a token this conversation already minted');
    assert.ok(Object.values(mapB).includes('zoe@rebind.com'),
        'the attachment value must still be tokenised into this conversation');
    // And the tokenised text must use B's token for zoe, not A's.
    const zoeToken = Object.keys(mapB).find(t => mapB[t] === 'zoe@rebind.com');
    assert.ok(!r.text.includes('zoe@rebind.com'), 'raw value must not survive tokenisation');
    assert.ok(r.text.includes(zoeToken),
        `tokenised text must carry this conversation's token (${zoeToken}), got: ${r.text}`);

    // The outbound invariant: every value in the map is still re-tokenisable.
    const { buildReverseReplacer } = require('../applyTokenMapToOutbound');
    assert.strictEqual(buildReverseReplacer(mapB)('mail bob@corp.com'), 'mail [email_1]',
        'evicting a value from the map lets it reach the provider unredacted');
});

test('legacy category id is aliased, not dropped', async () => {
    // A shield saved before the category rename still stores
    // `EUNationalIdentificationNumber`. The chat path aliases it to the
    // canonical id; this path used to filter it out, so the same BSN was
    // redacted when typed and forwarded in the clear when uploaded.
    const { LEGACY_CATEGORY_ALIASES } = require('../../privacy/piiDetection');
    const legacyId = 'EUNationalIdentificationNumber';
    const canonical = LEGACY_CATEGORY_ALIASES[legacyId];
    assert.ok(canonical, 'fixture assumes this legacy alias still exists');

    lastCategories = undefined;
    await scanAttachmentText({
        text: 'Mijn BSN is 123456782 en mijn mail is jan@example.nl',
        filename: 'legacy-shield.txt',
        orgShield: { ...SHIELD_TOKENIZE, piiDetectionCategories: ['Email', legacyId] },
        conversationId: 'conv-legacy-' + Date.now(),
    });
    assert.ok(Array.isArray(lastCategories), 'the detector should have been called');
    assert.ok(lastCategories.includes(canonical),
        `legacy id must resolve to ${canonical}; got ${JSON.stringify(lastCategories)}`);
    assert.ok(!lastCategories.includes(legacyId),
        'the legacy id itself must not be sent — the guard ignores ids it does not know');
    assert.ok(lastCategories.includes('Email'), 'other selected categories must survive');
});

test('block error carries metadata', async () => {
    const err = new AttachmentPrivacyBlock({
        filename: 'x.pdf',
        summary: { byCategory: { Email: 2 }, count: 2 },
        findings: [],
    });
    assert.strictEqual(err.code, 'ATTACHMENT_PII_BLOCKED');
    assert.ok(err.message.includes('x.pdf'));
});

// ── New: large-input policy matrix (no silent leaks) ────────────────────

test('fail_closed overflow blocks/holds', async () => {
    // Admin set fail_closed: a doc past the page cap must be HELD, not passed.
    const pages = Array.from({ length: 55 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat, pages, filename: 'big.pdf',
        orgShield: SHIELD_TOKENIZE_FAILCLOSED, maxPages: 50,
    });
    assert.strictEqual(r.action, 'block');
    assert.strictEqual(r.reason, 'overflow');
    assert.strictEqual(r.text, null);
    assert.strictEqual(r.summary.held, true);
    assert.strictEqual(r.summary.totalPages, 55);
});

test('fail_closed timeout blocks/holds', async () => {
    mockDelayMs = 200;
    try {
        const pages = Array.from({ length: 4 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));
        const flat = pages.map(p => p.text).join('\n\n');
        const r = await scanAttachmentText({
            text: flat, pages, filename: 'slow.pdf',
            orgShield: SHIELD_TOKENIZE_FAILCLOSED, concurrency: 2, maxScanMs: 100,
        });
        assert.strictEqual(r.action, 'block');
        assert.strictEqual(r.reason, 'timeout');
        assert.strictEqual(r.summary.held, true);
    } finally {
        mockDelayMs = 0;
    }
});

test('fail_open timeout tokenises partial findings (leak fix)', async () => {
    // On timeout under tokenize+fail_open, findings collected before the
    // deadline are still tokenised (not discarded), and the unchecked tail is
    // cut rather than forwarded.
    mockDelayMs = 200;
    try {
        // Page 1 (scanned before the deadline trips) carries an email.
        const pages = Array.from({ length: 6 }, (_, i) => ({
            pageNumber: i + 1,
            text: i === 0 ? 'urgent: leak@partial.com here' : `page ${i + 1} no pii`,
        }));
        const flat = pages.map(p => p.text).join('\n\n');
        const r = await scanAttachmentText({
            text: flat, pages, filename: 'partial.pdf',
            orgShield: SHIELD_TOKENIZE_FAILOPEN, conversationId: 'conv-partial-' + Date.now(),
            concurrency: 2, maxScanMs: 250,
        });
        assert.strictEqual(r.action, 'tokenize', 'partial findings must be tokenised, not dropped');
        assert.strictEqual(r.summary.timeout, true);
        assert.ok(r.findings.length >= 1, 'the email scanned before the deadline must be a finding');
        assert.ok(!r.text.includes('leak@partial.com'), 'scanned PII must be redacted even on timeout');
        assert.strictEqual(Object.keys(r.tokenMap).length, r.summary.count,
            'count must match the token-mapping rows on the partial path too');
    } finally {
        mockDelayMs = 0;
    }
});

test('fail_open block-action overflow blocks on finding', async () => {
    // block-action + fail_open + overflow: PII found in the scanned pages → block.
    const pages = Array.from({ length: 55 }, (_, i) => ({
        pageNumber: i + 1,
        text: i === 0 ? 'leak dan@oops.com' : `page ${i + 1}`,
    }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r = await scanAttachmentText({
        text: flat, pages, filename: 'blk-overflow.pdf',
        orgShield: SHIELD_BLOCK_FAILOPEN, maxPages: 50,
    });
    assert.strictEqual(r.action, 'block');
});

test('degraded under fail_closed blocks', async () => {
    // A degraded detector result under fail_closed must block, not leak.
    mockDegraded = true;
    try {
        const r = await scanAttachmentText({
            text: 'some text with alice@x.com inside',
            filename: 'degraded.txt',
            orgShield: SHIELD_TOKENIZE_FAILCLOSED,
            conversationId: 'conv-degraded-' + Date.now(),
        });
        assert.strictEqual(r.action, 'block');
        assert.strictEqual(r.reason, 'degraded');
    } finally {
        mockDegraded = false;
    }
});

test('incomplete outcomes are not cached', async () => {
    // Overflow (fail_open pass) must NOT be cached — a later re-upload with a
    // higher budget/tier may fully scan.
    const pages = Array.from({ length: 55 }, (_, i) => ({ pageNumber: i + 1, text: `pg ${i + 1}` }));
    const flat = pages.map(p => p.text).join('\n\n');
    const r1 = await scanAttachmentText({ text: flat, pages, filename: 'nocache.pdf', orgShield: SHIELD_TOKENIZE_FAILOPEN, maxPages: 50 });
    assert.strictEqual(r1.action, 'pass');
    assert.strictEqual(r1.summary.overflow, true);
    const r2 = await scanAttachmentText({ text: flat, pages, filename: 'nocache.pdf', orgShield: SHIELD_TOKENIZE_FAILOPEN, maxPages: 50 });
    assert.ok(!r2.summary.cacheHit, 'incomplete (overflow) outcome must not be cached');
});

// Re-require the scanner with a given env so the module-level budget constants
// (evaluated once, at require time) are recomputed. Returns the fresh export.
function _reloadScannerWithEnv(env) {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[require.resolve('../attachmentScanner')];
    const mod = require('../attachmentScanner');
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return mod;
}

test('DLP_ATTACHMENT_SCAN_BUDGET_MS overrides the scan deadline', async () => {
    // The deployment-level budget must apply WITHOUT the caller passing
    // maxScanMs — that is the whole point: chatStream calls the scanner with
    // no overrides, so a slow guard could only be accommodated from env.
    mockDelayMs = 200;
    try {
        const pages = Array.from({ length: 4 }, (_, i) => ({ pageNumber: i + 1, text: `page ${i + 1}` }));
        const flat = pages.map(p => p.text).join('\n\n');

        const tight = _reloadScannerWithEnv({ DLP_ATTACHMENT_SCAN_BUDGET_MS: '100' });
        const r1 = await tight.scanAttachmentText({
            text: flat, pages, filename: 'envbudget.pdf', orgShield: SHIELD_TOKENIZE,
            conversationId: 'conv-envbudget-' + Date.now(),
        });
        assert.strictEqual(r1.summary.timeout, true, '100ms budget must trip on 200ms/page');

        // A garbage value must fall back to the 30s default, not to 0 — a 0ms
        // budget would time out every single scan.
        const bogus = _reloadScannerWithEnv({ DLP_ATTACHMENT_SCAN_BUDGET_MS: 'nonsense' });
        const r2 = await bogus.scanAttachmentText({
            text: flat, pages, filename: 'envbudget2.pdf', orgShield: SHIELD_TOKENIZE,
            conversationId: 'conv-envbudget2-' + Date.now(),
        });
        assert.strictEqual(r2.summary.timeout, false, 'invalid budget must fall back to the default');
    } finally {
        mockDelayMs = 0;
        // Leave the require cache holding a default-env instance.
        _reloadScannerWithEnv({ DLP_ATTACHMENT_SCAN_BUDGET_MS: undefined });
    }
});

test('DLP_ATTACHMENT_MAX_PAGES overrides the page cap', async () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({ pageNumber: i + 1, text: `pg ${i + 1}` }));
    const flat = pages.map(p => p.text).join('\n\n');
    const capped = _reloadScannerWithEnv({ DLP_ATTACHMENT_MAX_PAGES: '3' });
    const r = await capped.scanAttachmentText({
        text: flat, pages, filename: 'envpages.pdf', orgShield: SHIELD_TOKENIZE,
        conversationId: 'conv-envpages-' + Date.now(),
    });
    assert.strictEqual(r.summary.overflow, true, '6 pages over a 3-page env cap must flag overflow');
    assert.strictEqual(r.summary.totalPages, 6);
    _reloadScannerWithEnv({ DLP_ATTACHMENT_MAX_PAGES: undefined });
});

// ── New: dlpMode 'ask' — attachments joining the interactive review (Fase 2) ─

test('_resolveAction: allowAsk gates dlpMode "ask" — off by default, on when the caller opts in', () => {
    // Before this fix, resolveOrgShield ALWAYS populates piiDetectionAction
    // (falls back to 'block'), so the legacy branch matched first and dlpMode
    // was dead code for attachments — an org running interactive DLP saw its
    // attachments silently auto-tokenize/block, never pause.
    assert.strictEqual(_resolveAction(SHIELD_ASK, true), 'ask');
    assert.strictEqual(_resolveAction(SHIELD_ASK), 'tokenize',
        'allowAsk defaults to false — a caller that never opts in must see the pre-Fase-2 behaviour, unchanged, regardless of dlpMode');
    assert.strictEqual(_resolveAction(SHIELD_ASK, false), 'tokenize');
    assert.strictEqual(_resolveAction({ ...SHIELD_ASK, dlpEnabled: false }, true), 'tokenize',
        'dlpEnabled must gate the carve-out — dlpMode alone is not enough');
    assert.strictEqual(_resolveAction(SHIELD_TOKENIZE, true), 'tokenize', 'unaffected when dlpMode is absent');
});

test('a caller that does not pass allowAsk gets the legacy outcome even under dlpMode "ask" (no unrecognised action can leak raw text)', async () => {
    // The other four scanAttachmentText callers (webpage/template/notebook
    // chat, notebook ingestion) only check `action === 'block'` and otherwise
    // trust `result.text` — this is the safety net that keeps them exactly as
    // they behaved before Fase 2, with zero code changes on their side.
    const r = await scanAttachmentText({
        text: 'contact notinteractive@example.com',
        filename: 'not-interactive.txt',
        orgShield: SHIELD_ASK,
        conversationId: 'conv-noallowask-' + Date.now(),
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.ok(!r.text.includes('notinteractive@example.com'));
});

test('ask: pauses instead of tokenising — text unchanged, findings carried, tokenMap null', async () => {
    const conversationId = 'conv-ask-' + Date.now();
    dlpRunner.clearConversationState(conversationId);
    const text = 'Reach out to ask@example.com for details';
    const r = await scanAttachmentText({
        text, filename: 'ask.txt', orgShield: SHIELD_ASK, conversationId, allowAsk: true,
    });
    assert.strictEqual(r.action, 'ask');
    assert.strictEqual(r.text, text, 'the ask outcome must not redact — the caller pauses first');
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.tokenMap, null);
});

test('ask: zero findings still passes straight through (no forced pause on a clean attachment)', async () => {
    const r = await scanAttachmentText({
        text: 'nothing sensitive in this file at all',
        filename: 'clean.txt',
        orgShield: SHIELD_ASK,
        allowAsk: true,
    });
    assert.strictEqual(r.action, 'pass');
    assert.deepStrictEqual(r.findings, []);
});

test('ask + remembered "redact": resolves straight to tokenize, no repeat pause', async () => {
    const conversationId = 'conv-ask-remember-redact-' + Date.now();
    dlpRunner.clearConversationState(conversationId);
    dlpRunner.setConversationPref(conversationId, 'redact');
    const r = await scanAttachmentText({
        text: 'contact remembered@example.com',
        filename: 'remembered.txt',
        orgShield: SHIELD_ASK,
        conversationId,
        allowAsk: true,
    });
    assert.strictEqual(r.action, 'tokenize');
    assert.ok(!r.text.includes('remembered@example.com'));
});

test('ask + remembered "allow": passes through UNREDACTED but still reports findings (audit)', async () => {
    const conversationId = 'conv-ask-remember-allow-' + Date.now();
    dlpRunner.clearConversationState(conversationId);
    dlpRunner.setConversationPref(conversationId, 'allow');
    const text = 'contact allowed@example.com';
    const r = await scanAttachmentText({
        text, filename: 'allowed.txt', orgShield: SHIELD_ASK, conversationId, allowAsk: true,
    });
    assert.strictEqual(r.action, 'pass');
    assert.strictEqual(r.text, text, 'remembered allow must not redact');
    assert.strictEqual(r.findings.length, 1, 'findings still reported for audit even though nothing was redacted');
});

test('applyAttachmentRedactionChoice: tokenises the given findings and merges into the conversation map', async () => {
    const conversationId = 'conv-apply-' + Date.now();
    dlpRunner.clearConversationState(conversationId);
    const text = 'call me: applyme@example.com';
    const scan = await scanAttachmentText({ text, filename: 'apply.txt', orgShield: SHIELD_ASK, conversationId, allowAsk: true });
    assert.strictEqual(scan.action, 'ask');

    const applied = await applyAttachmentRedactionChoice({
        text, findings: scan.findings, conversationId, filename: 'apply.txt',
    });
    assert.strictEqual(applied.action, 'tokenize');
    assert.ok(!applied.text.includes('applyme@example.com'));
    assert.strictEqual(Object.keys(applied.tokenMap).length, 1);
    const map = dlpRunner.getConversationTokenMap(conversationId);
    assert.ok(Object.values(map).includes('applyme@example.com'), 'must merge into the shared conversation token map');
});

test('applyAttachmentRedactionChoice: a manually-added finding (caller-merged) redacts alongside the auto hit', async () => {
    // Mirrors how the caller (attachmentIntake/attachmentProcessor) merges a
    // user-marked span before calling this — this test only pins that
    // applyAttachmentRedactionChoice itself has no special-casing that would
    // treat a manual-shaped finding differently from an auto one.
    const conversationId = 'conv-apply-manual-' + Date.now();
    dlpRunner.clearConversationState(conversationId);
    const text = 'hello Alice, no auto hits here';
    const manualFinding = { category: 'UserMarked', label: 'UserMarked', offset: 6, length: 5, text: 'Alice', source: 'manual', severity: 'high' };
    const applied = await applyAttachmentRedactionChoice({
        text, findings: [manualFinding], conversationId, filename: 'manual.txt',
    });
    assert.strictEqual(applied.action, 'tokenize');
    assert.ok(!applied.text.includes('Alice'));
    assert.strictEqual(applied.summary.count, 1);
});

test('ask on an incomplete (timed-out) fail_open scan: reviews only the scanned prefix, never the unscanned tail', async () => {
    // Bounds-critical (see the comment at the call site): the "ask" payload
    // for a partial scan must be the TRUNCATED text, so a manual addition
    // the user makes in the review UI can never reference content that was
    // genuinely never checked.
    mockDelayMs = 200;
    try {
        const pages = Array.from({ length: 8 }, (_, i) => ({
            pageNumber: i + 1,
            text: i === 0 ? 'urgent: scanned@partial.com here' : `SECRET-TAIL-${i + 1} confidential`,
        }));
        const flat = pages.map(p => p.text).join('\n\n');
        const r = await scanAttachmentText({
            text: flat, pages, filename: 'ask-partial.pdf',
            orgShield: SHIELD_ASK_FAILOPEN,
            conversationId: 'conv-ask-partial-' + Date.now(),
            concurrency: 1, maxScanMs: 250, allowAsk: true,
        });
        assert.strictEqual(r.action, 'ask');
        assert.strictEqual(r.summary.timeout, true);
        assert.ok(r.summary.scannedPages < pages.length, 'precondition: scan really was partial');
        for (let i = r.summary.scannedPages; i < pages.length; i++) {
            assert.ok(!r.text.includes(`SECRET-TAIL-${i + 1}`), `page ${i + 1} was never scanned and must not be in the review text`);
        }
        assert.ok(r.text.includes('scanned@partial.com'), 'the scanned part is shown for review (not yet redacted)');
    } finally {
        mockDelayMs = 0;
    }
});

test('a cache hit still yields "ask" when the CURRENT org is in ask mode, even if the cached scan was under tokenize', async () => {
    // The cache holds only the detection ({findings, summary}), never the
    // action — action is resolved fresh from the CURRENT org config on every
    // call, cache hit or not.
    const text = 'Repeat scan for ask: zoe@ask-cache.com';
    const filename = 'ask-cache.txt';
    const convTokenize = 'conv-ask-cache-tok-' + Date.now();
    const convAsk = 'conv-ask-cache-ask-' + Date.now();
    dlpRunner.clearConversationState(convTokenize);
    dlpRunner.clearConversationState(convAsk);

    const r1 = await scanAttachmentText({ text, filename, orgShield: SHIELD_TOKENIZE, conversationId: convTokenize });
    assert.strictEqual(r1.action, 'tokenize');

    const r2 = await scanAttachmentText({ text, filename, orgShield: SHIELD_ASK, conversationId: convAsk, allowAsk: true });
    assert.strictEqual(r2.summary.cacheHit, true, 'second scan must reuse the cached detection');
    assert.strictEqual(r2.action, 'ask', 'the action must reflect the CURRENT org, not whatever produced the cache entry');
    assert.strictEqual(r2.text, text, 'ask must not have redacted anything');
});
