/**
 * projects/chatShield.js — the Privacy Shield passage of the team chat
 * assistant, with the shield, the DLP runner and the PII validator injected.
 *
 * Proven:
 *   - DLP gate on: block stops the call; redact and ask (no one to ask →
 *     redact) hand back tokenised text and the map; a scan that throws blocks
 *     (fail closed);
 *   - DLP gate off: the PII passage runs only when the shield or the global
 *     flag says so, tokenises, blocks on "PII Detected" and on a fail-closed
 *     degraded detector, and fails open on any other detector error — the
 *     agent path's semantics;
 *   - a shield lookup that fails blocks;
 *   - hidden Unicode is stripped before anything is scanned;
 *   - the guardrail audit gets categories, never values;
 *   - the answer is un-tokenised, and the per-run map is dropped.
 *
 * Run: cd server && node --test projects/chatShield.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeChatShield, PrivacyBlocked } = require('./chatShield');

function harness({ shield = null, aiConfig = {}, scan, apply, validate, resolveThrows = false, source } = {}) {
    const calls = { scan: [], apply: [], validate: [], cleared: [], audit: [] };
    const s = makeChatShield({
        resolveShieldFor: async (args) => {
            if (resolveThrows) throw new Error('config store down');
            calls.resolved = args;
            return shield;
        },
        getAIConfig: async () => aiConfig,
        dlp: {
            async scan(args) { calls.scan.push(args); return scan(args); },
            async applyRedactionChoice(args) { calls.apply.push(args); return apply(args); },
            clearConversationState(id, opts) { calls.cleared.push(id); calls.clearOpts = opts; },
        },
        validateInputForPii: async (...args) => { calls.validate.push(args); return validate(...args); },
        logGuardrailEvent: async (ev) => { calls.audit.push(ev); },
        ...(source ? { source } : {}),
    });
    return { s, calls };
}

const base = { orgId: 'org1', userId: 'u1', conversationId: 'project-chat-c1-r1', providerConfig: { providerType: 'anthropic' } };

test('DLP gate on: block stops the call, and the audit names categories only', async () => {
    const shield = { enabled: true, dlpEnabled: true };
    const { s, calls } = harness({ shield, scan: () => ({ action: 'block', summary: { EMAIL: 1 }, findings: [{ label: 'EMAIL', text: 'a@b.c' }] }) });
    await assert.rejects(() => s.protect({ ...base, shield, text: 'mail a@b.c' }), (err) => err instanceof PrivacyBlocked && err.code === 'PRIVACY_BLOCKED');
    assert.strictEqual(calls.scan.length, 1);
    assert.deepStrictEqual(calls.scan[0].messages, [{ role: 'user', content: 'mail a@b.c' }]);
    assert.strictEqual(calls.scan[0].orgShieldConfig, shield);
    assert.strictEqual(calls.scan[0].conversationId, base.conversationId);
    assert.strictEqual(calls.validate.length, 0, 'the PII passage is the DLP gate\'s job here');
    assert.strictEqual(calls.audit[0].action_taken, 'blocked');
    assert.strictEqual(calls.audit[0].source, 'project_chat');
    assert.ok(!JSON.stringify(calls.audit).includes('a@b.c'));
});

test('DLP gate on: redact and ask both send tokenised text', async () => {
    const shield = { enabled: true, dlpEnabled: true };
    const redact = harness({ shield, scan: () => ({ action: 'redact', redactedText: 'mail [email_1]', tokenMap: { '[email_1]': 'a@b.c' }, summary: { EMAIL: 1 } }) });
    assert.deepStrictEqual(await redact.s.protect({ ...base, shield, text: 'mail a@b.c' }), { text: 'mail [email_1]', tokenMap: { '[email_1]': 'a@b.c' }, categories: ['EMAIL'] });

    const ask = harness({
        shield,
        scan: () => ({ action: 'ask', findings: [{ label: 'EMAIL' }] }),
        apply: () => ({ tokenizedText: 'mail [email_1]', tokenMap: { '[email_1]': 'a@b.c' } }),
    });
    assert.deepStrictEqual(await ask.s.protect({ ...base, shield, text: 'mail a@b.c' }), { text: 'mail [email_1]', tokenMap: { '[email_1]': 'a@b.c' }, categories: ['EMAIL'] });
    assert.strictEqual(ask.calls.apply.length, 1, 'nobody to ask, so the conservative choice');

    const allow = harness({ shield, scan: () => ({ action: 'allow' }) });
    assert.deepStrictEqual(await allow.s.protect({ ...base, shield, text: 'hello' }), { text: 'hello', tokenMap: null });
});

test('DLP gate on: a scan that throws blocks (fail closed)', async () => {
    const shield = { enabled: true, dlpEnabled: true };
    const { s } = harness({ shield, scan: () => { throw new Error('guard down'); } });
    await assert.rejects(() => s.protect({ ...base, shield, text: 'hello' }), { code: 'PRIVACY_BLOCKED', reason: 'scan_failed' });
});

test('shield off and no global flag: nothing is scanned', async () => {
    const { s, calls } = harness({ shield: null, aiConfig: { piiDetectionEnabled: false }, validate: () => { throw new Error('must not run'); } });
    assert.deepStrictEqual(await s.protect({ ...base, shield: null, text: 'hello there' }), { text: 'hello there', tokenMap: null });
    assert.strictEqual(calls.validate.length, 0);
    assert.strictEqual(calls.scan.length, 0);
});

test('PII passage: tokenise, the agent path\'s arguments', async () => {
    const shield = { enabled: true, dlpEnabled: false };
    const { s, calls } = harness({
        shield,
        validate: () => ({ tokenizedText: 'call [phone_1]', tokenMap: { '[phone_1]': '0612345678' }, entities: [{ label: 'PHONE' }] }),
    });
    const out = await s.protect({ ...base, shield, text: 'call 0612345678' });
    assert.deepStrictEqual(out, { text: 'call [phone_1]', tokenMap: { '[phone_1]': '0612345678' }, categories: ['PHONE'] });
    const [messages, orgPiiEnabled, cfg, override, existing, opts] = calls.validate[0];
    assert.deepStrictEqual(messages, [{ role: 'user', content: 'call 0612345678' }]);
    assert.strictEqual(orgPiiEnabled, true);
    assert.strictEqual(cfg, shield);
    assert.strictEqual(override, null);
    assert.strictEqual(existing, null);
    assert.deepStrictEqual(opts, { vaultUserId: 'u1' });
    assert.strictEqual(calls.audit[0].violation_categories, 'PHONE');
    assert.ok(!JSON.stringify(calls.audit).includes('0612345678'));
});

test('PII passage: the global flag alone switches it on', async () => {
    const { s, calls } = harness({ shield: null, aiConfig: { piiDetectionEnabled: true }, validate: () => null });
    assert.deepStrictEqual(await s.protect({ ...base, shield: null, text: 'hello there' }), { text: 'hello there', tokenMap: null });
    assert.strictEqual(calls.validate.length, 1);
    assert.strictEqual(calls.validate[0][1], false);
});

test('PII passage: a block and a fail-closed degraded detector stop the call; other errors fail open', async () => {
    const shield = { enabled: true };
    const blocked = harness({ shield, validate: () => { throw Object.assign(new Error('PII Detected: EMAIL'), { piiEntities: [{ label: 'EMAIL', text: 'a@b.c' }] }); } });
    await assert.rejects(() => blocked.s.protect({ ...base, shield, text: 'a@b.c' }), { code: 'PRIVACY_BLOCKED', reason: 'pii_block' });
    assert.ok(!JSON.stringify(blocked.calls.audit).includes('a@b.c'));

    const degraded = harness({ shield, validate: () => { throw Object.assign(new Error('guard degraded'), { privacyUnavailable: true }); } });
    await assert.rejects(() => degraded.s.protect({ ...base, shield, text: 'hello there' }), { code: 'PRIVACY_BLOCKED', reason: 'pii_unavailable' });

    const broken = harness({ shield, validate: () => { throw new Error('socket hang up'); } });
    assert.deepStrictEqual(await broken.s.protect({ ...base, shield, text: 'hello there' }), { text: 'hello there', tokenMap: null });
});

test('a shield lookup that fails blocks', async () => {
    const { s } = harness({ resolveThrows: true });
    await assert.rejects(() => s.resolve({ orgId: 'org1', userId: 'u1' }), { code: 'PRIVACY_BLOCKED', reason: 'shield_unavailable' });
    const ok = harness({ shield: { enabled: true } });
    assert.deepStrictEqual(await ok.s.resolve({ orgId: null, userId: 'u1' }), { enabled: true });
    assert.deepStrictEqual(ok.calls.resolved, { orgId: null, userId: 'u1' });
});

test('hidden Unicode is stripped before the scan sees the text', async () => {
    const shield = { enabled: true, dlpEnabled: true };
    const { s, calls } = harness({ shield, scan: () => ({ action: 'allow' }) });
    const smuggled = `hello${String.fromCodePoint(0xE0041, 0xE0042)} there`;
    const out = await s.protect({ ...base, shield, text: smuggled });
    assert.strictEqual(out.text, 'hello there');
    assert.strictEqual(calls.scan[0].messages[0].content, 'hello there');
});

test('restore puts the values back; release drops the run\'s map; the addendum lists tokens', () => {
    const { s, calls } = harness();
    assert.strictEqual(s.restore('Hi [name_1], see [email_1].', { '[name_1]': 'Anna', '[email_1]': 'anna@example.test' }), 'Hi Anna, see anna@example.test.');
    assert.strictEqual(s.restore('unchanged', null), 'unchanged');
    s.release('project-chat-c1-r1');
    assert.deepStrictEqual(calls.cleared, ['project-chat-c1-r1']);
    assert.strictEqual(s.tokenAddendum(null), '');
    assert.match(s.tokenAddendum({ '[name_1]': 'Anna' }), /\[name_1\]/);
});

test('the relevance gate audits under its own source', async () => {
    const shield = { enabled: true, dlpEnabled: true };
    const { s, calls } = harness({ shield, source: 'project_chat_gate', scan: () => ({ action: 'block', summary: { EMAIL: 1 } }) });
    await assert.rejects(() => s.protect({ ...base, shield, text: 'mail a@b.c' }));
    assert.strictEqual(calls.audit[0].source, 'project_chat_gate');
});

test('every DLP call runs on an ephemeral scope: no write-through, no owner lookup, no database clear', async () => {
    // The ids are per-run scopes with no conversation row; the write-through
    // meant for real conversations cost ~9 wasted queries, a WARN and a
    // permanent set entry per call (core/dlp/dlpRunner.ephemeral.test.js).
    const shield = { enabled: true, dlpEnabled: true };
    const ask = harness({
        shield,
        scan: () => ({ action: 'ask', findings: [{ label: 'EMAIL' }] }),
        apply: () => ({ tokenizedText: 'mail [email_1]', tokenMap: { '[email_1]': 'a@b.c' } }),
    });
    await ask.s.protect({ ...base, shield, text: 'mail a@b.c' });
    assert.strictEqual(ask.calls.scan[0].ephemeral, true);
    assert.strictEqual(ask.calls.apply[0].ephemeral, true);
    ask.s.release(base.conversationId);
    assert.deepStrictEqual(ask.calls.clearOpts, { ephemeral: true });
});
