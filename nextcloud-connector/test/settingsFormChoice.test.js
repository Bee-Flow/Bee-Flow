// The admin settings form (Nextcloud → Administration → Artificial
// Intelligence) and the choice of a Bee Flow server.
//
// The form does not choose by itself. Its default is "No change". While no
// server is chosen, the values Nextcloud holds at the first poll after a start
// are only noted; a value counts as a choice once it is changed after that. A
// first choice asks the address for /api/health before anything is saved or
// sent.
//
// The poll, the bootstrap and the setup route run for real; only the network
// is replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLOUD = 'https://server.beeflow.nl';
const OWN = 'https://bee-flow.example';
const NC = 'http://nc.test';
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-settings-form-'));
process.env.APP_SECRET = 'test-secret';
process.env.NEXTCLOUD_URL = NC;
process.env.BEEFLOW_TENANT_KEY = 'auto';
delete process.env.BEEFLOW_API_BASE_URL; // nothing chosen at install time
process.env.APP_PERSISTENT_STORAGE = storage;
process.env.BEEFLOW_BOOTSTRAP_RETRY_MS = '0';

const { installFakeWorld, ocs } = require('./support/fakeWorld');
const config = require('../src/config');
const bootstrap = require('../src/bootstrap');
const serverChoice = require('../src/serverChoice');
const setupConfig = require('../src/setupConfig');
const declarativeSettings = require('../src/declarativeSettings');

const HEALTHY = { 'GET /api/health': () => ({ status: 'ok' }) };
const BINDS = (tenantKey) => ({ ...HEALTHY, 'POST /auth/connector/bootstrap': () => ({ tenantKey, organizationId: `org-${tenantKey}` }) });
const CLOUD_FORM = [{ configkey: 'deployment_mode', configvalue: 'cloud' }];
const OWN_FORM = [{ configkey: 'deployment_mode', configvalue: 'self-hosted' }, { configkey: 'api_base_url', configvalue: OWN }];
const KEEP_FORM = [{ configkey: 'deployment_mode', configvalue: 'keep' }];

/** The connector right after a start: what is on disk decides the server. */
function start(files = {}) {
    setupConfig.init(storage);
    setupConfig.clear();
    for (const name of fs.readdirSync(storage)) fs.rmSync(path.join(storage, name), { force: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(storage, name), JSON.stringify(content));
    const choice = serverChoice.applyAtBoot(config, setupConfig.init(storage));
    config.organizationId = null;
    config.organizationName = null;
    config.ncInstanceId = null;
    config.pairingCode = null;
    declarativeSettings._resetForTests();
    return choice;
}

/**
 * A world in which Nextcloud holds `form.values` for the settings form.
 * @param {Record<string, Record<string, Function>>} servers
 */
function worldWith(servers, form) {
    return installFakeWorld({
        servers,
        nc: (_method, url) => (url.includes('/ex-app/config/get-values') ? ocs(form.values) : undefined),
    });
}

const poll = () => declarativeSettings.applyStoredValuesIfChanged();
const outsideNextcloud = (world) => world.calls.filter((c) => !c.url.startsWith(`${NC}/`)).map((c) => `${c.method} ${c.url}`);
const adminReads = (world) => world.count((c) => c.url.includes('/cloud/groups/admin/users'));

test.after(() => {
    declarativeSettings.stopPolling();
    require('../src/taskProcessing').stopPolling();
    require('../src/webhookListeners').stopRetry();
    fs.rmSync(storage, { recursive: true, force: true });
});

for (const [what, values] of [['Bee Flow Cloud', CLOUD_FORM], ['an own server', OWN_FORM]]) {
    test(`no server chosen, the form already holds ${what} at the start: poll after poll, nothing is sent`, async () => {
        assert.equal(start().source, 'none');
        const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, { values });
        try {
            for (let i = 0; i < 5; i++) await poll();

            assert.deepEqual(outsideNextcloud(world), [], 'no request to any Bee Flow host, not even /api/health');
            assert.equal(world.count((c) => c.url.includes('/ex-app/config/get-values')), 5, 'the form was read each time');
            assert.equal(adminReads(world), 0, 'the administrators are not read');
            assert.equal(config.apiBaseUrl, null);
            assert.equal(config.tenantKey, null);
            assert.equal(setupConfig.get(), null);
            assert.deepEqual(fs.readdirSync(storage), [], 'no file written');
            assert.equal(bootstrap._bootstrapRetryArmedForTests(), false);

            // The same after another start: the value is still not a choice.
            assert.equal(start().source, 'none');
            for (let i = 0; i < 3; i++) await poll();
            assert.deepEqual(outsideNextcloud(world), []);
            assert.equal(config.apiBaseUrl, null);
        } finally {
            world.restore();
        }
    });
}

test('a value changed after the start is a choice: the address is asked first, then the connector binds', async () => {
    start();
    const form = { values: [] };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key') }, form);
    try {
        await poll();
        await poll();
        assert.deepEqual(outsideNextcloud(world), []);

        form.values = CLOUD_FORM; // the administrator picks Bee Flow Cloud
        await poll();
        assert.equal(config.apiBaseUrl, CLOUD);
        assert.equal(config.tenantKey, 'cloud-key');
        assert.equal(setupConfig.get()?.mode, 'cloud');
        assert.equal(config.serverSource, 'picker');

        const outside = outsideNextcloud(world);
        assert.equal(outside[0], `GET ${CLOUD}/api/health`, 'the first request outside Nextcloud');
        const probe = world.calls.find((c) => c.url === `${CLOUD}/api/health`);
        assert.equal(probe.body, null);
        assert.deepEqual(probe.headers, {});
        const order = world.calls.map((c) => c.url);
        assert.ok(order.findIndex((u) => u.includes('/cloud/groups/admin/users')) > order.indexOf(`${CLOUD}/api/health`),
            'the administrators are read after the server answered');

        await poll();
        await poll();
        assert.equal(world.count((c) => c.url === `${CLOUD}/auth/connector/bootstrap`), 1, 'applied once');
    } finally {
        world.restore();
    }
});

test('a value noted at the start and changed later is a choice like any other', async () => {
    start();
    const form = { values: CLOUD_FORM };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll();
        form.values = OWN_FORM;
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.deepEqual(outsideNextcloud(world).filter((c) => c.includes(CLOUD)), [], 'nothing went to the noted value');
    } finally {
        world.restore();
    }
});

test('a first choice at an address where no Bee Flow server answers: nothing saved, nothing sent, asked again later', async () => {
    start();
    const form = { values: [] };
    let up = false;
    const world = worldWith({
        [OWN]: {
            'GET /api/health': () => { if (!up) throw new TypeError('fetch failed'); return { status: 'ok' }; },
            'POST /auth/connector/bootstrap': () => ({ tenantKey: 'own-key', organizationId: 'org-own' }),
        },
    }, form);
    try {
        await poll();
        form.values = OWN_FORM;
        await poll();
        await poll();
        assert.deepEqual(outsideNextcloud(world), [`GET ${OWN}/api/health`, `GET ${OWN}/api/health`]);
        assert.equal(adminReads(world), 0);
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);
        assert.deepEqual(fs.readdirSync(storage), []);

        up = true; // the server is started
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
    } finally {
        world.restore();
    }
});

test('"No change" asks for nothing, with or without a server', async () => {
    start();
    const form = { values: [] };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll();
        form.values = KEEP_FORM;
        await poll();
        // Also with an address left in the field next to it.
        form.values = [...KEEP_FORM, { configkey: 'api_base_url', configvalue: OWN }];
        await poll();
        assert.deepEqual(outsideNextcloud(world), []);
        assert.equal(config.apiBaseUrl, null);
        assert.equal(setupConfig.get(), null);

        // Connected to an own server; the form on "No change" leaves it there.
        start({ 'tenant-key.json': { tenantKey: 'own-key', organizationId: 'org-own', ncInstanceId: 'inst-1', boundApiBaseUrl: OWN } });
        await bootstrap.bootstrapIfNeeded();
        assert.equal(config.apiBaseUrl, OWN);
        form.values = KEEP_FORM;
        await poll();
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.deepEqual(outsideNextcloud(world), []);
    } finally {
        world.restore();
    }
});

test('a value noted at the start does not move a server chosen on the setup page', async () => {
    start();
    const form = { values: CLOUD_FORM };
    const world = worldWith({ [CLOUD]: BINDS('cloud-key'), [OWN]: BINDS('own-key') }, form);
    try {
        await poll(); // notes "Cloud"
        await bootstrap.invalidateAndRebootstrap({ apiBaseUrl: OWN }); // the choice on the setup page
        assert.equal(config.apiBaseUrl, OWN);

        // Another field of the form changes; the server fields do not.
        form.values = [...CLOUD_FORM, { configkey: 'web_app_url', configvalue: 'https://app.bee-flow.example' }];
        for (let i = 0; i < 3; i++) await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.deepEqual(outsideNextcloud(world).filter((c) => c.includes(CLOUD)), [], 'nothing went to the noted value');
    } finally {
        world.restore();
    }
});

test('a failed read of the form at the start does not make the next one a choice', async () => {
    start();
    let fail = true;
    const real = installFakeWorld({
        servers: { [CLOUD]: BINDS('cloud-key') },
        nc: (_method, url) => {
            if (!url.includes('/ex-app/config/get-values')) return undefined;
            return fail ? new Response('down', { status: 503 }) : ocs(CLOUD_FORM);
        },
    });
    try {
        await poll(); // Nextcloud is still starting
        fail = false;
        for (let i = 0; i < 3; i++) await poll();
        assert.deepEqual(outsideNextcloud(real), []);
        assert.equal(config.apiBaseUrl, null);
    } finally {
        real.restore();
    }
});

test('an install that is connected follows the form as before, without a question first', async () => {
    assert.equal(start({
        'tenant-key.json': { tenantKey: 'cloud-key', organizationId: 'org-cloud', ncInstanceId: 'inst-1', boundApiBaseUrl: CLOUD },
    }).source, 'binding');
    await bootstrap.bootstrapIfNeeded();
    const world = worldWith({ [OWN]: BINDS('own-key') }, { values: OWN_FORM });
    try {
        await poll();
        assert.equal(config.apiBaseUrl, OWN);
        assert.equal(config.tenantKey, 'own-key');
        assert.equal(world.count((c) => c.url === `${OWN}/api/health`), 0);
    } finally {
        world.restore();
    }
});
