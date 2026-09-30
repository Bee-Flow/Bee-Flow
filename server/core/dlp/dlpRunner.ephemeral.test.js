/**
 * Ephemeral DLP scopes: the per-run ids of server-side AI calls (a project
 * chat answer, a relevance gate, a comment answer) that have no conversation
 * row behind them.
 *
 * Before, every such call took the write-through path meant for real
 * conversations: three owner SELECTs (caching `null` and pushing a real
 * conversation's owner out of the 500-entry cache), three UPDATEs that match
 * nothing, a WARN, a permanent entry in the "already warned" set, and three
 * more UPDATEs on release. With the relevance gate running in the background
 * all day, that was a steady stream of wasted queries and an unbounded set.
 *
 * Proven:
 *   - an ephemeral scan and an ephemeral "ask" redaction touch no database at
 *     all, and releasing the scope does not either; the map is still built and
 *     dropped on release;
 *   - a non-ephemeral id is still written through (unchanged behaviour), and
 *     clearing it forgets it, so the warned set does not grow without bound.
 *
 * The detector and the database helpers are swapped on their module objects
 * (the pattern of dlpRunner.nameSweep.test.js); nothing is resolved to a stub.
 *
 * Run: cd server && node --test core/dlp/dlpRunner.ephemeral.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

const EMAIL = 'anna@example.test';

// Swap detectPii before dlpRunner captures it by destructuring.
const piiDetection = require('../privacy/piiDetection');
piiDetection.detectPii = async (text) => {
    const at = String(text).indexOf(EMAIL);
    const entities = at < 0 ? [] : [{ text: EMAIL, category: 'Email', label: 'Email', offset: at, length: EMAIL.length, confidence: 0.99 }];
    return { hasPii: entities.length > 0, entities };
};

const db = require('../../db');
const queries = [];
db.run = async (sql) => { queries.push(String(sql)); return { rowCount: 0 }; };
db.getOne = async (sql) => { queries.push(String(sql)); return null; };
db.getAll = async (sql) => { queries.push(String(sql)); return []; };

const log = require('../../telemetry/log');
const warnings = [];
const originalWarn = log.warn;
log.warn = (...args) => {
    const line = args.join(' ');
    if (line.includes('[DlpRunner]')) warnings.push(line);
    else originalWarn.apply(log, args);
};

const dlpRunner = require('./dlpRunner');

const SHIELD = { enabled: true, dlpEnabled: true, dlpScope: 'all', piiFailureMode: 'fail_open' };
const PROVIDER = { providerType: 'anthropic', url: 'https://api.anthropic.com', displayName: 'Anthropic' };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => { queries.length = 0; warnings.length = 0; });

test('an ephemeral scope never reaches the database: not on redact, not on ask, not on release', async () => {
    const id = `project-chat-c1-${Math.random().toString(36).slice(2)}`;
    const scanned = await dlpRunner.scan({
        messages: [{ role: 'user', content: `mail ${EMAIL} please` }],
        orgShieldConfig: { ...SHIELD, dlpMode: 'auto_redact' },
        conversationId: id, providerConfig: PROVIDER, ephemeral: true,
    });
    assert.strictEqual(scanned.action, 'redact');
    assert.strictEqual(scanned.redactedText, 'mail [email_1] please');

    const asked = await dlpRunner.scan({
        messages: [{ role: 'user', content: `and ${EMAIL} again` }],
        orgShieldConfig: { ...SHIELD, dlpMode: 'ask' },
        conversationId: id, providerConfig: PROVIDER, ephemeral: true,
    });
    assert.strictEqual(asked.action, 'ask');
    const applied = await dlpRunner.applyRedactionChoice({ conversationId: id, text: `and ${EMAIL} again`, findings: asked.findings, ephemeral: true });
    assert.strictEqual(applied.tokenizedText, 'and [email_1] again', 'the run reuses its own token');
    assert.deepStrictEqual(dlpRunner.getConversationTokenMap(id), { '[email_1]': EMAIL });

    dlpRunner.clearConversationState(id, { ephemeral: true });
    await settle();
    assert.deepStrictEqual(queries, [], 'no owner lookup, no write-through, no clear');
    assert.deepStrictEqual(warnings, [], 'no "no conversation row" warning');
    assert.deepStrictEqual(dlpRunner.getConversationTokenMap(id), {}, 'the map is dropped on release');
});

test('a real conversation id is still written through, and clearing it forgets it', async () => {
    const id = `conv-${Math.random().toString(36).slice(2)}`;
    const redact = () => dlpRunner.applyRedactionChoice({
        conversationId: id, text: `mail ${EMAIL}`,
        findings: [{ text: EMAIL, category: 'Email', label: 'Email', offset: 5, length: EMAIL.length }],
    });

    await redact();
    await settle();
    assert.ok(queries.some((q) => /UPDATE agent_conversations SET pii_token_map/.test(q)), 'unchanged: the map is written through');
    assert.strictEqual(warnings.filter((w) => w.includes(id)).length, 1);

    // Warned once per id while it lives...
    await redact();
    await settle();
    assert.strictEqual(warnings.filter((w) => w.includes(id)).length, 1);

    // ...and forgotten when it is cleared, so the set cannot only grow.
    dlpRunner.clearConversationState(id);
    await settle();
    assert.ok(queries.some((q) => /UPDATE agent_conversations SET pii_token_map = NULL/.test(q)), 'a real conversation is still cleared in the database');
    await redact();
    await settle();
    assert.strictEqual(warnings.filter((w) => w.includes(id)).length, 2);
    dlpRunner.clearConversationState(id);
});
