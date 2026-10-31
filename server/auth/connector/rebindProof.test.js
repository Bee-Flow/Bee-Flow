// @typecheck
/**
 * Unit tests for connector/rebindProof.js: how a bootstrap for an already-
 * bound instance id proves the existing binding (recorded base URL, or a
 * request signed with the current tenant key), and the refusal when it does
 * not. The signature verifier is injected through the module's seam; no DB,
 * no fetch. The returning-bind branch itself is covered through the router
 * in ../connectorBootstrap.orgHealth.test.js.
 *
 * Run: cd server && node --test auth/connector/rebindProof.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseNcBaseUrl, provesExistingBinding, refuseRebind, _setDepsForTests } = require('./rebindProof');

const BOUND = { id: 'org-a', nc_base_url: 'https://cloud.acme.example' };
/** @type {any[]} */
let sigCalls = [];
/** @type {{ id: string } | null} */
let signedFor = null;

test.beforeEach(() => {
    sigCalls = [];
    signedFor = null;
    _setDepsForTests({ verifyConnectorSig: async (req) => { sigCalls.push(req); return signedFor; } });
});
test.after(() => _setDepsForTests());

const ctx = (/** @type {string} */ ncBaseUrl) => ({ req: /** @type {any} */ ({ headers: {} }), ncBaseUrl });

test('normaliseNcBaseUrl: host case, trailing slashes, query and fragment do not matter; scheme and port do', () => {
    assert.equal(normaliseNcBaseUrl('HTTPS://Cloud.Acme.Example/'), 'https://cloud.acme.example');
    assert.equal(normaliseNcBaseUrl('https://cloud.acme.example/nextcloud//?x=1#y'), 'https://cloud.acme.example/nextcloud');
    assert.notEqual(normaliseNcBaseUrl('http://cloud.acme.example'), normaliseNcBaseUrl('https://cloud.acme.example'));
    assert.notEqual(normaliseNcBaseUrl('https://cloud.acme.example:8443'), normaliseNcBaseUrl('https://cloud.acme.example'));
    assert.equal(normaliseNcBaseUrl('ftp://cloud.acme.example'), null);
    assert.equal(normaliseNcBaseUrl('not a url'), null);
    assert.equal(normaliseNcBaseUrl(null), null);
});

test('the recorded base URL proves the binding without a signature check', async () => {
    assert.equal(await provesExistingBinding(ctx('HTTPS://cloud.acme.example/'), BOUND), 'base_url');
    assert.equal(sigCalls.length, 0);
});

test('a different base URL needs a signature that verifies for THIS org', async () => {
    assert.equal(await provesExistingBinding(ctx('https://moved.acme.example'), BOUND), null);
    assert.equal(sigCalls.length, 1);
    signedFor = { id: 'org-z' };
    assert.equal(await provesExistingBinding(ctx('https://moved.acme.example'), BOUND), null);
    signedFor = { id: 'org-a' };
    assert.equal(await provesExistingBinding(ctx('https://moved.acme.example'), BOUND), 'tenant_key');
});

test('a binding without a recorded base URL cannot be proved by URL; a throwing verifier is no proof', async () => {
    assert.equal(await provesExistingBinding(ctx('https://cloud.acme.example'), { id: 'org-a', nc_base_url: null }), null);
    _setDepsForTests({ verifyConnectorSig: async () => { throw new Error('store down'); } });
    assert.equal(await provesExistingBinding(ctx('https://moved.acme.example'), BOUND), null);
});

test('refuseRebind: 403 NC_REBIND_PROOF_REQUIRED with a remediation, never a key', () => {
    /** @type {any} */
    let sent;
    const res = { status(/** @type {number} */ c) { sent = { status: c }; return this; }, json(/** @type {any} */ b) { sent.body = b; return this; } };
    refuseRebind({ req: /** @type {any} */ ({ headers: {} }), res: /** @type {any} */ (res), ncInstanceId: 'inst-a', ncBaseUrl: 'https://other.example' }, BOUND);
    assert.equal(sent.status, 403);
    assert.equal(sent.body.code, 'NC_REBIND_PROOF_REQUIRED');
    assert.match(sent.body.remediation, /pairing code/);
    assert.equal('tenantKey' in sent.body, false);
});
