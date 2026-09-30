'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeChatCrypto } = require('./chatCrypto');
const { applyTokenMap, answerRecord, openTrace } = require('./chatTrace');

const box = makeChatCrypto({ getProjectKey: async () => crypto.randomBytes(32) }).forProject({ id: 'p1', organizationId: 'o1' });

test('placeholders go in for their values, the longest value first', () => {
    assert.strictEqual(applyTokenMap('mail a@b.c and a@b.co.uk', { '[email_1]': 'a@b.c', '[email_2]': 'a@b.co.uk' }), 'mail [email_1] and [email_2]');
    assert.strictEqual(applyTokenMap('call 0612345678 or 0612345678', { '[phone_1]': '0612345678' }), 'call [phone_1] or [phone_1]');
    assert.strictEqual(applyTokenMap('nothing here', { '[x]': '' }), 'nothing here');
    assert.strictEqual(applyTokenMap('plain', null), 'plain');
});

test('an answer with nothing replaced carries a small note and no trace', async () => {
    const { aiMeta, aiTrace } = answerRecord({
        model: { tier: 'fast', requestedTier: 'auto', modelId: 'm' }, outbound: { tokenMap: null }, triggerText: 'hi', rawAnswer: 'hello',
        box: await box, chatId: 'c1', messageId: 'm1',
    });
    assert.deepStrictEqual(aiMeta, { tier: 'fast', requestedTier: 'auto', redacted: 0, categories: [] });
    assert.strictEqual(aiTrace, null);
});

test('a replaced value gives a sealed trace: as written, as sent, the placeholders, and what came back', async () => {
    const sealer = await box;
    const { aiMeta, aiTrace } = answerRecord({
        model: { tier: 'pro', requestedTier: 'pro', modelId: 'claude-x' },
        outbound: { tokenMap: { '[email_1]': 'ann@example.test' }, categories: ['EMAIL'] },
        triggerText: 'my mail is ann@example.test', rawAnswer: 'Noted, [email_1].', box: sealer, chatId: 'c1', messageId: 'm1',
    });
    assert.strictEqual(aiMeta.redacted, 1);
    assert.ok(aiTrace && !aiTrace.includes('ann@example.test'), 'sealed, not plain');
    assert.deepStrictEqual(openTrace(sealer, 'c1', 'm1', aiTrace), {
        model: 'claude-x', tier: 'pro', categories: ['EMAIL'],
        original: 'my mail is ann@example.test', sent: 'my mail is [email_1]',
        tokenMap: { '[email_1]': 'ann@example.test' }, returned: 'Noted, [email_1].',
    });
    assert.throws(() => openTrace(sealer, 'c1', 'other', aiTrace), 'bound to its own message');
});
