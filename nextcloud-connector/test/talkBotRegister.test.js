/**
 * Talk bot registration on restart (#281). AppAPI mints a new secret on every
 * registration and Talk refuses a second secret for the same bot URL with an
 * OCS 500, so every start after the first gets that 500:
 *   - no stored secret (fresh volume): remove the bot, register again, keep the
 *     new secret;
 *   - a stored secret: that is the bot Talk has; keep it, no DELETE (a delete
 *     would drop the bot from every conversation).
 * The two tests run in order on one module: the first one stores the secret
 * the second one relies on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
process.env.APP_PERSISTENT_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-talkbot-register-'));

const talkBot = require('../src/talkBot');

const CONFLICT = { ok: false, status: 500, text: async () => '{"ocs":{"meta":{"statuscode":996}}}', json: async () => ({}) };
const registered = (secret) => ({ ok: true, status: 200, text: async () => '', json: async () => ({ ocs: { data: { secret } } }) });

async function withFetch(answers, fn) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init = {}) => {
        calls.push(init.method || 'GET');
        const next = answers.shift();
        return typeof next === 'function' ? next() : next;
    };
    try {
        return { result: await fn(), calls };
    } finally {
        global.fetch = realFetch;
    }
}

test('a refused registration without a stored secret removes the bot and registers again', async () => {
    assert.equal(talkBot.loadSecret(), null);
    const { result, calls } = await withFetch([CONFLICT, { ok: true, status: 200 }, registered('fresh-secret')], () => talkBot.registerTalkBot());
    assert.deepEqual(calls, ['POST', 'DELETE', 'POST']);
    assert.equal(result.ok, true);
    assert.equal(talkBot.loadSecret(), 'fresh-secret');
});

test('a refused re-registration with a stored secret keeps it and deletes nothing', async () => {
    const { result, calls } = await withFetch([CONFLICT], () => talkBot.registerTalkBot());
    assert.deepEqual(calls, ['POST']);
    assert.deepEqual(result, { ok: true, reason: 'kept-existing' });
    assert.equal(talkBot.loadSecret(), 'fresh-secret');
});
