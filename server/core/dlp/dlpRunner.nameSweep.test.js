/**
 * The DLP redact path end to end with the tokenizer's name sweep (BFSF-269).
 *
 * The reported leak: the detector found a name once, the other mentions of it
 * went to the model as plain text, and the badge said "1 item redacted". With
 * the sweep the prompt carries no mention of the person, the token map still
 * has one row for them (the badge counts distinct values), and the summary
 * counts every mention that was redacted, swept ones included.
 *
 * All names are synthetic.
 *
 * Run: cd server && node --test core/dlp/dlpRunner.nameSweep.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

process.env.NODE_ENV = 'test';

// Swap detectPii before dlpRunner captures it by destructuring. The stub
// reports the full name once and misses every other mention, the shape of
// the reported leak.
const piiDetection = require('../privacy/piiDetection');
piiDetection.detectPii = async (text) => {
    const at = String(text).indexOf('Hendrik Vos');
    const entities = at < 0 ? [] : [{
        text: 'Hendrik Vos', category: 'Person', label: 'Person Name', offset: at, length: 11, confidence: 0.9,
    }];
    return { hasPii: entities.length > 0, entities };
};

const classification = require('../providers/classification');
classification.classifyProvider = () => 'external';

const dlpRunner = require('./dlpRunner');

test('auto-redact replaces every mention of a person found once, and counts them', async () => {
    const text = 'Hendrik vroeg om uitstel. Namens de familie Vos, met vriendelijke groet, Hendrik Vos';
    const result = await dlpRunner.scan({
        messages: [{ role: 'user', content: text }],
        orgShieldConfig: { enabled: true, dlpEnabled: true, dlpScope: 'all', dlpMode: 'auto_redact', piiFailureMode: 'fail_open' },
        conversationId: `conv-${Math.random().toString(36).slice(2)}`,
        providerConfig: { provider: 'openai' },
    });

    assert.strictEqual(result.action, 'redact');
    assert.strictEqual(result.redactedText,
        '[person_1] vroeg om uitstel. Namens de familie [person_1], met vriendelijke groet, [person_1]');
    assert.deepStrictEqual(result.tokenMap, { '[person_1]': 'Hendrik Vos' },
        'one person is one row in the token map, however often they are mentioned');
    assert.deepStrictEqual(result.summary, { 'Person Name': 3 },
        'the summary counts the swept mentions next to the detected one');
});
