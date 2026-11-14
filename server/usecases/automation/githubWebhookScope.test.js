'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { scopeOfGithubDelivery, orgSecretKey, INSTALLATION_SECRET_KEY } = require('./githubWebhookScope');

const raw = Buffer.from('{"zen":"x"}');
const sign = (secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const scope = (signature, config, orgIds) => scopeOfGithubDelivery({
    signature, raw,
    getConfig: async (key) => config[key] ?? null,
    listOrganizations: async () => orgIds.map((id) => ({ id })),
});

test('a delivery signed with an organisation\'s own secret belongs to that organisation', async () => {
    const config = { [orgSecretKey('acme')]: 's-acme', [orgSecretKey('globex')]: 's-globex', [INSTALLATION_SECRET_KEY]: 's-all' };
    assert.deepStrictEqual(await scope(sign('s-globex'), config, ['acme', 'globex']), { outcome: 'org', orgId: 'globex' });
});

test('the installation-wide secret is honoured with one organisation, and refused with more', async () => {
    const config = { [INSTALLATION_SECRET_KEY]: 's-all' };
    assert.deepStrictEqual(await scope(sign('s-all'), config, ['acme']), { outcome: 'installation' });
    assert.deepStrictEqual(await scope(sign('s-all'), config, []), { outcome: 'installation' });
    // it names no organisation: with two, the delivery would reach both
    assert.deepStrictEqual(await scope(sign('s-all'), config, ['acme', 'globex']), { outcome: 'needs_org_secret' });
});

test('a wrong signature and a missing configuration are told apart', async () => {
    assert.deepStrictEqual(await scope(sign('nope'), { [orgSecretKey('acme')]: 's-acme' }, ['acme']), { outcome: 'bad_signature' });
    assert.deepStrictEqual(await scope(sign('nope'), {}, ['acme']), { outcome: 'unconfigured' });
    assert.deepStrictEqual(await scope('', { [INSTALLATION_SECRET_KEY]: 's-all' }, ['acme']), { outcome: 'bad_signature' });
});
