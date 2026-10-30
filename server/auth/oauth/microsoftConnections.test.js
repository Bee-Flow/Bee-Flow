// @typecheck strict
/**
 * The Microsoft sign-in connections (auth/oauth/microsoftConnections.mts): the
 * primary app registration as every installation has it, plus the additional
 * tenants with their own credentials, label and logo. What this pins:
 *
 *   - an existing configuration (clientId/clientSecret/tenantId, nothing else)
 *     is the primary connection unchanged: one default button, its credentials;
 *   - an additional connection is only offered when it has an id and a secret,
 *     and a sign-in through it gets THAT connection's credentials and tenant;
 *   - a token refresh without a connection on record picks by the account's
 *     verified tenant, and the primary when nothing is pinned to it;
 *   - a logo is a small image data URL or an https URL, nothing else.
 *
 * Run: cd server && node --test auth/oauth/microsoftConnections.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ms = require('./microsoftConnections.mts');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const PRIMARY = { clientId: 'primary-id', clientSecret: 'primary-secret', tenantId: TENANT_A };
const SUB = { id: 'sub', label: 'Subsidiary', logo: 'https://logo.example/s.png', clientId: 'sub-id', clientSecret: 'sub-secret', tenantId: TENANT_B };
/** @param {import('./microsoftConnections.mts').MicrosoftProviderConfig} microsoft */
const config = (microsoft) => ({ providers: { microsoft } });

test('a configuration from before connections is the primary, unchanged', () => {
    assert.deepStrictEqual(ms.listMicrosoftLogins(config(PRIMARY)), [{ id: 'default', label: '', logo: '' }]);
    assert.deepStrictEqual(ms.microsoftCredentialsFor(config(PRIMARY)), PRIMARY);
    assert.deepStrictEqual(ms.microsoftCredentialsFor(config(PRIMARY), 'default'), PRIMARY);
    assert.strictEqual(ms.microsoftCredentialsFor(config({ clientId: 'only-id' })), null, 'no secret: not configured');
    assert.deepStrictEqual(ms.listMicrosoftLogins(config({})), []);
    assert.deepStrictEqual(ms.listMicrosoftLogins(null), []);
});

test('an additional connection is its own button with its own credentials', () => {
    const cfg = config({ ...PRIMARY, label: 'Head office', logo: 'https://logo.example/h.png', connections: [SUB] });
    assert.deepStrictEqual(ms.listMicrosoftLogins(cfg), [
        { id: 'default', label: 'Head office', logo: 'https://logo.example/h.png' },
        { id: 'sub', label: 'Subsidiary', logo: 'https://logo.example/s.png' },
    ]);
    assert.deepStrictEqual(ms.microsoftCredentialsFor(cfg, 'sub'), { clientId: 'sub-id', clientSecret: 'sub-secret', tenantId: TENANT_B });
    assert.strictEqual(ms.microsoftCredentialsFor(cfg, 'nope'), null, 'an unknown connection is refused, never the primary');
});

test('a connection without a secret yet is neither offered nor usable', () => {
    const cfg = config({ ...PRIMARY, connections: [{ ...SUB, clientSecret: undefined, hasClientSecret: false }] });
    assert.deepStrictEqual(ms.listMicrosoftLogins(cfg).map((l) => l.id), ['default']);
    assert.strictEqual(ms.microsoftCredentialsFor(cfg, 'sub'), null);
    // The stored metadata only says whether a secret exists; that is enough to list it.
    const stored = config({ clientId: 'p', hasClientSecret: true, connections: [{ ...SUB, clientSecret: undefined, hasClientSecret: true }] });
    assert.deepStrictEqual(ms.listMicrosoftLogins(stored).map((l) => l.id), ['default', 'sub']);
});

test('a refresh without a connection on record follows the account\'s verified tenant', () => {
    const cfg = config({ ...PRIMARY, connections: [SUB, { ...SUB, id: 'open', tenantId: 'common' }] });
    assert.strictEqual(ms.microsoftCredentialsForTenant(cfg, TENANT_B)?.clientId, 'sub-id');
    assert.strictEqual(ms.microsoftCredentialsForTenant(cfg, TENANT_A)?.clientId, 'primary-id');
    assert.strictEqual(ms.microsoftCredentialsForTenant(cfg, '33333333-3333-3333-3333-333333333333')?.clientId, 'primary-id', 'nothing pinned: the primary');
    assert.strictEqual(ms.microsoftCredentialsForTenant(cfg, null)?.clientId, 'primary-id');
});

test('tenant ids, connection ids and logos are checked the same way everywhere', () => {
    assert.strictEqual(ms.normalizeTenantId(''), 'common');
    assert.strictEqual(ms.normalizeTenantId(' Organizations '), 'organizations');
    assert.strictEqual(ms.normalizeTenantId(TENANT_A.toUpperCase()), TENANT_A);
    assert.strictEqual(ms.normalizeTenantId('contoso'), null);
    assert.ok(ms.isValidConnectionId('sub-1'));
    assert.ok(!ms.isValidConnectionId('default'), 'the primary\'s id is reserved');
    assert.ok(!ms.isValidConnectionId('Has Spaces'));
    assert.match(ms.newConnectionId(), /^[0-9a-f]{12}$/);
    assert.ok(ms.isValidLogo(''));
    assert.ok(ms.isValidLogo('https://logo.example/a.svg'));
    assert.ok(ms.isValidLogo(`data:image/png;base64,${Buffer.from('tiny').toString('base64')}`));
    assert.ok(!ms.isValidLogo('http://logo.example/a.svg'), 'plain http would be mixed content on the login page');
    assert.ok(!ms.isValidLogo('javascript:alert(1)'));
    assert.ok(!ms.isValidLogo('data:text/html;base64,PGI+'));
    assert.ok(!ms.isValidLogo(`data:image/png;base64,${Buffer.alloc(ms.MAX_LOGO_BYTES + 1).toString('base64')}`), 'over the ceiling');
});
