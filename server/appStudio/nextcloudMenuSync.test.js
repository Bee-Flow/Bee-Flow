/**
 * nextcloudMenuSync — the SaaS → connector "sync the app menu now" push.
 *
 * Pinned here:
 *   - the wire contract with nextcloud-connector/src/studioAppMenus.js
 *     (mountPushHook): POST <callback>/hooks/studio-menus, ids-only JSON body,
 *     `X-Beeflow-Sig` = HMAC(tenantKey, `${ts}\nPOST\n/hooks/studio-menus\n\n${sha256(body)}`)
 *     — the /nc/* v2 form the connector's verifyHmac already checks;
 *   - the outcome mapping the publish dialog relies on ('synced' only when the
 *     connector confirmed);
 *   - that an org row is read by its REAL column names (the old ncConnected
 *     hint read `org.ncInstanceId`, which getOrganization never produces, and
 *     was therefore always false);
 *   - coalescing + cooldowns, so a burst of toggles is one extra push and an
 *     old connector (401) is not hammered — every 401 is a bruteforce mark
 *     against the SaaS on the customer's Nextcloud.
 *
 * Fake stores + fetch; no Postgres, no network.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');

const TENANT_KEY = 't'.repeat(64);
const CALLBACK = 'https://cloud.example.com/index.php/apps/app_api/proxy/bee_flow';
const orgs = new Map();

function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../stores/userStore.js', {
    getOrganization: async (id) => orgs.get(id) || null,
});
inject('../stores/configStore.js', {
    getSecret: async (k) => (['connector_tenant_key_org-1', 'connector_tenant_key_org-3'].includes(k) ? TENANT_KEY : null),
});

const sync = require('./nextcloudMenuSync');

// ── fetch stub ──────────────────────────────────────────────────────────────
let requests = [];
let answer = () => new Response(JSON.stringify({ ok: true, added: 1, removed: 0, updated: 0 }), { status: 200 });
global.fetch = async (url, opts = {}) => {
    requests.push({ url: String(url), method: opts.method, headers: opts.headers || {}, body: opts.body });
    return answer(String(url), opts);
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const quiet = { log: console.log, warn: console.warn };

beforeEach(() => {
    requests = [];
    orgs.clear();
    // Raw row shape, as getOrganization returns it: snake_case, no camelCase twins.
    orgs.set('org-1', { id: 'org-1', connector_callback_url: `${CALLBACK}/`, nc_instance_id: 'nc-host:cloud' });
    orgs.set('org-none', { id: 'org-none', name: 'No Nextcloud' });
    answer = () => new Response(JSON.stringify({ ok: true, added: 1, removed: 0, updated: 0 }), { status: 200 });
    sync._resetForTests();
    console.log = () => {};
    console.warn = () => {};
});
test.after(() => { console.log = quiet.log; console.warn = quiet.warn; });

test('a push is a signed, ids-only POST to <callback>/hooks/studio-menus, and "synced" means the connector said ok', async () => {
    const out = await sync.requestMenuSync('org-1', { reason: 'nextcloud_menu', appId: 'app-1' });
    assert.equal(out.outcome, 'synced');
    assert.deepEqual(out.result, { added: 1, removed: 0, updated: 0 });

    assert.equal(requests.length, 1);
    const req = requests[0];
    // Trailing slash on the stored callback URL is normalised away.
    assert.equal(req.url, `${CALLBACK}/hooks/studio-menus`);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['Content-Type'], 'application/json');
    assert.equal(req.headers['X-Beeflow-NC-Uid'], '', 'service-level: no user is impersonated');

    // Ids only — the connector fetches names itself; nothing personal or
    // app-descriptive rides on this call. And NOT under the key `appId`: the
    // AppAPI proxy route is /proxy/{appId}/{other}, and Nextcloud lets a JSON
    // body's top-level keys override those URL parameters — an `appId` in the
    // body replaced `bee_flow` and Nextcloud answered 404/400 for the ExApp
    // named in the body, before the connector saw anything.
    const body = JSON.parse(req.body);
    assert.deepEqual(Object.keys(body).sort(), ['reason', 'sentAt', 'studioAppId']);
    assert.equal(body.studioAppId, 'app-1');
    assert.equal(body.reason, 'nextcloud_menu');
    assert.ok(!('appId' in body) && !('other' in body), 'no key that names a route parameter of the NC proxy');

    // The cross-repo signature vector (nextcloud-connector/test/studioMenusHook.test.js).
    const [ts, sig] = req.headers['X-Beeflow-Sig'].split('.');
    const expected = crypto.createHmac('sha256', TENANT_KEY)
        .update(`${ts}\nPOST\n/hooks/studio-menus\n\n${sha256(req.body)}`).digest('hex');
    assert.equal(sig, expected);
});

test('an org without a paired connector is not_connected and makes no call', async () => {
    assert.equal((await sync.requestMenuSync('org-none', { reason: 'x' })).outcome, 'not_connected');
    assert.equal((await sync.requestMenuSync('org-unknown', { reason: 'x' })).outcome, 'not_connected');
    assert.equal((await sync.requestMenuSync(null, { reason: 'x' })).outcome, 'not_connected');
    // A callback URL without a tenant key is equally unusable.
    orgs.set('org-2', { id: 'org-2', connector_callback_url: CALLBACK, nc_instance_id: 'nc-host:x' });
    assert.equal((await sync.requestMenuSync('org-2', { reason: 'x' })).outcome, 'not_connected');
    assert.equal(requests.length, 0);
});

test('the camelCase org shape is accepted too, so a normalised org is not mistaken for an unpaired one', async () => {
    orgs.set('org-1', { id: 'org-1', connectorCallbackUrl: CALLBACK, ncInstanceId: 'nc-host:cloud' });
    assert.equal((await sync.requestMenuSync('org-1', { reason: 'x' })).outcome, 'synced');
});

test('connector answers map to outcomes the dialog can act on', async () => {
    const cases = [
        [() => new Response('{"error":"nope"}', { status: 404 }), 'unsupported'],
        [() => new Response('{"error":"sig"}', { status: 401 }), 'unauthorized'],
        [() => new Response('{"error":"sig"}', { status: 403 }), 'unauthorized'],
        [() => new Response('{"error":"slow down"}', { status: 429 }), 'unauthorized'],
        [() => new Response('bad gateway', { status: 502 }), 'unreachable'],
        [() => new Response(JSON.stringify({ ok: false, error: 'SaaS answered HTTP 500' }), { status: 200 }), 'unreachable'],
        [() => new Response('not json', { status: 200 }), 'unreachable'],
        [() => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, 'unreachable'],
        [() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 'unreachable'],
    ];
    for (const [reply, expected] of cases) {
        sync._resetForTests();
        answer = reply;
        const out = await sync.requestMenuSync('org-1', { reason: 'x' });
        assert.equal(out.outcome, expected, `${expected}: ${out.detail}`);
    }
});

test('a burst of concurrent pushes for one org costs at most one follow-up, and every caller gets an answer', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    answer = async () => { await gate; return new Response(JSON.stringify({ ok: true, added: 0, removed: 0, updated: 0 }), { status: 200 }); };

    const first = sync.requestMenuSync('org-1', { reason: 'nextcloud_menu' });
    // Let the first push reach fetch before the others queue behind it.
    await new Promise((r) => setImmediate(r));
    const rest = [1, 2, 3, 4].map(() => sync.requestMenuSync('org-1', { reason: 'publish' }));
    assert.equal(requests.length, 1, 'only the in-flight push has hit the wire');

    release();
    const results = await Promise.all([first, ...rest]);
    assert.ok(results.every((r) => r.outcome === 'synced'));
    assert.equal(requests.length, 2, 'one in flight + one shared follow-up, not five');
    assert.equal(requests[1].method, 'POST');
});

test('after a 401 the org is left alone for a while — an old connector must not collect bruteforce marks', async () => {
    answer = () => new Response('{"error":"sig"}', { status: 401 });
    assert.equal((await sync.requestMenuSync('org-1', { reason: 'x' })).outcome, 'unauthorized');
    const again = await sync.requestMenuSync('org-1', { reason: 'x' });
    assert.equal(again.outcome, 'unauthorized');
    assert.equal(again.detail, 'cooldown');
    assert.equal(requests.length, 1, 'the second toggle made no HTTP call');
    assert.ok(sync.COOLDOWN_MS.unauthorized >= 5 * 60_000);

    // The cooldown is per org: another org's connector is pushed as normal.
    orgs.set('org-3', { id: 'org-3', connector_callback_url: CALLBACK, nc_instance_id: 'nc-host:y' });
    answer = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    assert.equal((await sync.requestMenuSync('org-3', { reason: 'x' })).outcome, 'synced');
    assert.equal(requests.length, 2);
});

test('notifyMenuChange never rejects, whatever the connector does', async () => {
    answer = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => sync.notifyMenuChange('org-1', { reason: 'delete', appId: 'a' }));
    assert.doesNotThrow(() => sync.notifyMenuChange(undefined, { reason: 'delete' }));
    await new Promise((r) => setTimeout(r, 10));
});
