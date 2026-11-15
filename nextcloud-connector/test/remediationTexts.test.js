// What the connector tells an administrator after a failed connect: every text
// names the setup page or the administrator's own Bee Flow server, and the
// server's refusal of the reported Nextcloud address has a category.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = 'http://nc.test';
process.env.BEEFLOW_API_BASE_URL = 'http://beeflow.test';

test('the texts for a failed connect name the setup page, not a file to delete or a fixed address', () => {
    const config = require('../src/config');
    const { remediationFor } = require('../src/bootstrap');
    const categories = ['saas_unreachable', 'nc_not_publicly_reachable', 'admin_lookup_failed', 'admin_email_missing',
        'saas_auth_rejected', 'tenant_already_provisioned', 'pairing_required', 'version_mismatch',
        'appstore_signature_invalid', 'unknown'];
    const saved = config.apiBaseUrl;
    try {
        for (const server of [null, 'https://bee.example.org']) {
            config.apiBaseUrl = server;
            for (const category of categories) {
                const text = remediationFor(category);
                assert.doesNotMatch(text, /server\.beeflow\.nl|tenant-key\.json|\brm\b|BEEFLOW_TENANT_KEY/, category);
            }
        }
        config.apiBaseUrl = 'https://bee.example.org';
        assert.match(remediationFor('saas_unreachable'), /^Your Bee Flow server .*https:\/\/bee\.example\.org\/api\/health/);
        assert.match(remediationFor('nc_not_publicly_reachable'), /^Your Bee Flow server \(https:\/\/bee\.example\.org\)/);
        assert.match(remediationFor('nc_not_publicly_reachable'), /setup page/);
        assert.match(remediationFor('nc_not_publicly_reachable'), /NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1/);
        assert.match(remediationFor('tenant_already_provisioned'), /pairing code.*setup page/);
        config.apiBaseUrl = null;
        assert.match(remediationFor('saas_unreachable'), /<your Bee Flow server>/);
    } finally {
        config.apiBaseUrl = saved;
    }
});

test('a refused callback address is the same situation as an unreachable Nextcloud', () => {
    const { categoriseError } = require('../src/bootstrap');
    const refused = Object.assign(new Error('bootstrap HTTP 400: Connector callback URL rejected'), { code: 'invalid_callback_url', status: 400 });
    assert.equal(categoriseError(refused, 'saas_post'), 'nc_not_publicly_reachable');
    const unreachable = Object.assign(new Error('bootstrap HTTP 403'), { code: 'nc_capabilities_unreachable', status: 403 });
    assert.equal(categoriseError(unreachable, 'saas_post'), 'nc_not_publicly_reachable');
});

test('every pairing text names the place in Bee Flow where the code is generated', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { remediationFor } = require('../src/bootstrap');
    const { CONNECT_ERRORS } = require('../src/setupTexts');
    const place = 'Admin dashboard → Connections → Nextcloud → Pair a new Nextcloud';
    const texts = {
        tenant_already_provisioned: remediationFor('tenant_already_provisioned'),
        pairing_required: remediationFor('pairing_required'),
        pairing_code_invalid: remediationFor('pairing_code_invalid'),
        connect_pairing_code_required: CONNECT_ERRORS.pairing_code_required,
        connect_pairing_code_invalid: CONNECT_ERRORS.pairing_code_invalid,
    };
    for (const [name, text] of Object.entries(texts)) assert.ok(text.includes(place), name);
    const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup.html'), 'utf8').replace(/\s+/g, ' ');
    assert.equal(page.split(`<em>${place}</em>`).length - 1, 2, 'the pairing-code hint and the Bind to existing organisation card');
    assert.ok(!page.includes('Settings → Organisation'));
});
