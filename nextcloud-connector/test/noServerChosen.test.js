// The connector has no Bee Flow server until an administrator chooses one.
// Before that choice nothing about the Nextcloud is sent to any Bee Flow
// server and nothing is created anywhere.
//
// This is the proof, on the real process: each starting situation boots
// src/server.js in a child, with support/netGuard.js observing every TCP
// connection the process opens. Nextcloud is a local HTTP server; a connection
// to ANY other address lands on a second local listener that stands in for a
// Bee Flow host. That listener must end with zero connections, whatever the
// connector runs: the boot (bootstrap, background init, the first settings
// poll, the menu sync), the same four once more, AppAPI's /init, and every
// request a browser could make.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { fork } = require('node:child_process');

const SECRET = 'no-server-test-secret';
const CLOUD = 'https://server.beeflow.nl';
const RUNNER = path.join(__dirname, 'support', 'noServerRunner.js');
const NET_GUARD = path.join(__dirname, 'support', 'netGuard.js');

const ERROR_FILE = {
    status: 'failed', category: 'saas_unreachable', phase: 'saas_post', error: 'fetch failed',
    remediation: null, lastAttemptAt: '2026-08-14T10:00:00.000Z', nextRetryAt: '2026-08-14T10:01:00.000Z',
};
const PENDING_FILE = {
    kind: 'verification', pendingId: 'p-1',
    verifyUrl: '/auth/connector/bootstrap/pending/p-1/verify',
    resendUrl: '/auth/connector/bootstrap/pending/p-1/resend',
    retargetUrl: '/auth/connector/bootstrap/pending/p-1/retarget',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    maskedEmail: 'a***@nc.test', ncInstanceId: 'inst-1', apiBaseUrl: CLOUD,
};

// The four starting situations. `env` holds only what differs per situation.
const SITUATIONS = [
    {
        name: 'a fresh install with nothing set',
        env: {},
        files: {},
    },
    {
        name: 'the literal Cloud URL in the env and nothing on disk',
        env: { BEEFLOW_API_BASE_URL: CLOUD, BEEFLOW_EMBED_BASE_URL: 'https://beeflow.nl' },
        files: {},
    },
    {
        name: 'an explicit tenant key and no server URL',
        // The frontend lock is there to show that it does not make a shell host
        // without a server.
        env: { BEEFLOW_TENANT_KEY: 'pasted-tenant-key', BEEFLOW_EMBED_BASE_URL: 'https://frontend.example' },
        files: {},
        envTenantKey: 'pasted-tenant-key',
    },
    {
        name: 'an error file and a pending file on disk, with the literal Cloud URL in the env',
        env: { BEEFLOW_API_BASE_URL: CLOUD, BEEFLOW_EMBED_BASE_URL: 'https://beeflow.nl' },
        files: { 'bootstrap-last-error.json': ERROR_FILE, 'pending-bootstrap.json': PENDING_FILE },
    },
];

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

async function freePort() {
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe);
    return port;
}

function ocs(data) {
    return JSON.stringify({ ocs: { meta: { status: 'ok', statuscode: 200 }, data } });
}

/** A Nextcloud that answers the OCS calls the connector makes, and records each one. */
async function fakeNextcloud() {
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push({ method: req.method, url: req.url });
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        const url = req.url || '';
        if (url.includes('/cloud/capabilities')) {
            return res.end(ocs({ version: { string: '34.0.0' }, capabilities: { theming: { name: 'NC', instanceid: 'inst-1' } } }));
        }
        if (url.includes('/cloud/groups/admin/users')) return res.end(ocs({ users: ['admin'] }));
        const user = /\/cloud\/users\/([^?/]+)/.exec(url);
        if (user) {
            const uid = decodeURIComponent(user[1]);
            return res.end(ocs({
                id: uid, email: `${uid}@nc.test`, displayname: uid, groups: uid === 'admin' ? ['admin'] : ['users'],
            }));
        }
        return res.end(ocs([]));
    });
    const port = await listen(server);
    return { server, calls, port, url: `http://127.0.0.1:${port}` };
}

/** The listener that stands in for a Bee Flow host: it only counts. */
async function beeFlowStandIn() {
    const seen = { connections: 0 };
    const server = net.createServer((socket) => {
        seen.connections += 1;
        socket.on('error', () => {});
        socket.destroy();
    });
    const port = await listen(server);
    return { server, seen, port };
}

/** Every file under the storage directory with its content and modification time. */
function snapshot(dir) {
    return fs.readdirSync(dir).sort().map((name) => {
        const file = path.join(dir, name);
        return { name, content: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
    });
}

/** @param {() => boolean | Promise<boolean>} cond */
async function until(cond, what, ms = 15_000) {
    const t0 = Date.now();
    while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error(`not reached in time: ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/**
 * One request to the connector, the way a browser behind Nextcloud's proxy
 * sends it. Plain http, so the test decides every header (fetch sets
 * Sec-Fetch-Mode itself).
 * @returns {Promise<{ status: number, ok: boolean, headers: import('node:http').IncomingHttpHeaders, text: string, json: () => any }>}
 */
function request(port, method, p, headers = {}, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, method, path: p, agent: false,
            headers: { ...headers, ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { text += d; });
            res.on('end', () => resolve({
                status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
                headers: res.headers, text, json: () => JSON.parse(text),
            }));
        });
        req.on('error', reject);
        req.end(payload === null ? undefined : payload);
    });
}

const authHeader = (uid) => ({ 'AUTHORIZATION-APP-API': Buffer.from(`${uid}:${SECRET}`).toString('base64'), 'EX-APP-ID': 'bee_flow' });
const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };

for (const situation of SITUATIONS) {
    test(`no server chosen — ${situation.name}: nothing is sent, nothing is written`, async (t) => {
        const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-noserver-'));
        for (const [name, content] of Object.entries(situation.files)) {
            fs.writeFileSync(path.join(storage, name), JSON.stringify(content, null, 2));
        }
        const before = snapshot(storage);

        const nc = await fakeNextcloud();
        const standIn = await beeFlowStandIn();
        const appPort = await freePort();

        // A clean environment: nothing of the developer's or CI's shell reaches the child.
        const env = {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            APP_ID: 'bee_flow',
            APP_SECRET: SECRET,
            APP_VERSION: '2.0.0-test',
            APP_PORT: String(appPort),
            APP_PERSISTENT_STORAGE: storage,
            NEXTCLOUD_URL: nc.url,
            NETGUARD_ALLOW: `127.0.0.1:${nc.port}`,
            NETGUARD_SINK: `127.0.0.1:${standIn.port}`,
            ...situation.env,
        };
        const child = fork(RUNNER, [], { env, execArgv: ['--require', NET_GUARD], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const diverted = [];
        const replies = [];
        child.on('message', (m) => {
            if (m.diverted) diverted.push(m.diverted);
            else replies.push(m);
        });
        const exited = new Promise((resolve) => child.once('exit', resolve));
        t.after(async () => {
            child.kill('SIGKILL');
            await exited;
            await close(nc.server);
            await close(standIn.server);
            fs.rmSync(storage, { recursive: true, force: true });
        });

        const get = (p, headers = {}) => request(appPort, 'GET', p, headers);
        const post = (p, headers = {}, body = {}) => request(appPort, 'POST', p, headers, body);
        const progressReports = () => nc.calls.filter((c) => c.method === 'PUT' && c.url.includes('/ex-app/status')).length;

        // ── Boot ─────────────────────────────────────────────────────────────
        await until(async () => {
            if (child.exitCode !== null) throw new Error(`the connector exited at boot:\n${stderr}`);
            try { return (await get('/heartbeat')).ok; } catch { return false; }
        }, 'the connector answers /heartbeat');

        const heartbeat = (await get('/heartbeat')).json();
        assert.deepEqual(heartbeat, { status: 'ok', bootstrap: 'server_not_chosen' });

        // ── The state inside the process, after everything a start runs ──────
        child.send('facts');
        await until(() => replies.length > 0, 'the facts of the connector process');
        const reply = replies.shift();
        assert.equal(reply.error, undefined, reply.error);
        const facts = reply.facts;
        assert.equal(facts.apiBaseUrl, null, 'no server');
        assert.equal(facts.serverSource, 'none');
        assert.equal(facts.tenantKey, null, 'no server means no tenant key in memory');
        assert.equal(facts.envTenantKey, situation.envTenantKey ?? null);
        assert.equal(facts.mintError, 'TENANT_KEY_MISSING', 'no token can be minted');
        assert.equal(facts.retryArmed, false, 'no retry of a bootstrap is scheduled');
        assert.equal(facts.lastError, null, 'a leftover error file is not loaded');
        assert.equal(facts.pending, null, 'a leftover pending file is not resumed');
        assert.deepEqual(facts.menuSync, { ok: true, skipped: 'not_bootstrapped' });

        // ── What a browser gets ──────────────────────────────────────────────
        // A page load is the setup page in first-run mode; only an administrator
        // gets the picker.
        for (const [who, p, headers, canConfigure] of [
            ['an administrator', '/index.html', authHeader('admin'), true],
            ['an administrator', '/', authHeader('admin'), true],
            ['an ordinary user', '/index.html', authHeader('alice'), false],
            ['an ordinary user', '/agents/123', { ...authHeader('alice'), ...NAVIGATE }, false],
            ['an administrator', '/app/projects/p1', { ...authHeader('admin'), ...NAVIGATE }, true],
            ['a visitor without a session', '/index.html', authHeader(''), false],
        ]) {
            const res = await get(p, headers);
            const html = res.text;
            assert.equal(res.status, 200, `${who} GET ${p}`);
            assert.match(res.headers['content-type'] || '', /text\/html/, `${who} GET ${p}`);
            assert.equal(res.headers['cache-control'], 'no-store');
            assert.match(html, /<body data-first-run[ >]/, `${who} GET ${p} is the first-run page`);
            assert.equal(html.includes('<body data-first-run data-can-configure>'), canConfigure, `${who} GET ${p}`);
            assert.match(html, /Bee Flow is not set up yet/);
        }

        // The first-run page asks one thing, and only for an administrator.
        const adminStatus = await get('/setup/status', authHeader('admin'));
        assert.equal(adminStatus.status, 200);
        const status = adminStatus.json();
        assert.equal(status.canConfigure, true);
        assert.equal(status.active, null);
        const userStatus = await get('/setup/status', authHeader('alice'));
        assert.equal(userStatus.status, 200, 'a non-administrator gets a plain answer, not an error');
        assert.deepEqual(userStatus.json(), { canConfigure: false });

        const diagnostics = (await get('/setup/diagnostics', authHeader('admin'))).json();
        assert.equal(diagnostics.state, 'server_not_chosen');
        assert.equal(diagnostics.apiBaseUrl, null);
        assert.equal(diagnostics.hasTenantKey, false);

        // The connector's own script and icon are served.
        for (const p of ['/js/embed', '/js/embed.js', '/img/app.svg']) {
            assert.equal((await get(p)).status, 200, p);
        }

        // Everything that would be proxied to a Bee Flow server, or fetched from a
        // frontend host, is refused by the connector itself.
        for (const [p, headers] of [
            ['/auth/user', authHeader('alice')],
            ['/api/chat', authHeader('alice')],
            ['/agents', authHeader('admin')],
            ['/api/languages/user/locales', authHeader('alice')],
            ['/assets/index-abc123.js', authHeader('alice')],
            ['/assets/index-abc123.css', authHeader('')],
            ['/favicon.ico', authHeader('alice')],
            ['/bee-flow-logo.png', authHeader('')],
        ]) {
            const res = await get(p, headers);
            assert.equal(res.status, 503, `GET ${p}`);
            assert.equal(res.json().code, 'server_not_chosen', `GET ${p}`);
        }
        const chat = await post('/ai/chat/direct/stream', authHeader('alice'), { message: 'hello' });
        assert.equal(chat.status, 503);
        assert.equal(chat.json().code, 'server_not_chosen');

        // The routes that act on a chosen server have nothing to act on, also
        // with a pending file on disk that names a server.
        for (const [p, body] of [
            ['/setup/verify-email-code', { code: '123456' }],
            ['/setup/resend-email-code', {}],
            ['/setup/request-verification-code', {}],
            ['/setup/apply-pairing-code', { pairingCode: 'ABCD-1234' }],
            ['/setup/rotate-tenant-key', {}],
            ['/setup/clear-cache', {}],
            ['/setup/diagnose', {}],
        ]) {
            const res = await post(p, authHeader('admin'), body);
            assert.equal(res.status, 409, `POST ${p}`);
            assert.equal(res.json().code, 'server_not_chosen', `POST ${p}`);
        }

        // The Bee Flow server's own callback route has no key to check against.
        const callback = await get('/nc/ocs/v2.php/cloud/users/admin');
        assert.ok(callback.status >= 400, `the callback route answered ${callback.status}`);

        // AppAPI's /init: answered at once, and the background setup reaches 100.
        const reportsBefore = progressReports();
        const init = await post('/init', authHeader(''));
        assert.equal(init.status, 200);
        await until(() => progressReports() >= reportsBefore + 3, '/init reported its progress');

        // ── The proof ────────────────────────────────────────────────────────
        // Let anything still in flight land before the counts are read.
        await new Promise((r) => setTimeout(r, 200));
        child.send('facts');
        await until(() => replies.length > 0, 'the facts of the connector process, at the end');
        const end = replies.shift().facts;
        assert.equal(end.apiBaseUrl, null);
        assert.equal(end.tenantKey, null);
        assert.equal(end.retryArmed, false);

        assert.deepEqual(diverted, [], 'the connector opened a connection to something that is not Nextcloud');
        assert.deepEqual(end.diverted, []);
        assert.equal(standIn.seen.connections, 0, 'the listener standing in for a Bee Flow host got a connection');

        assert.ok(nc.calls.length > 0, 'the Nextcloud-side registrations did run');
        assert.equal(nc.calls.filter((c) => c.url.includes('/cloud/groups/admin/users')).length, 0,
            'the list of administrators is not read');
        assert.equal(nc.calls.filter((c) => c.url.includes('/apps/app_api/api/v1/users')).length, 0,
            'the list of users is not read');
        assert.equal(nc.calls.filter((c) => c.url.includes('/cloud/capabilities')).length, 0,
            'the instance details are not read');
        assert.equal(nc.calls.filter((c) => c.url.includes('/talk_bot')).length, 0, 'no Talk bot is registered');

        assert.deepEqual(snapshot(storage), before, 'a file was written, changed or removed');
    });
}

// The control for the instrument: the same setup WITH a server chosen. The
// connector then does read the administrators and does connect, and the
// stand-in listener sees it. Without this, zero connections above could also
// mean that the guard observes nothing.
test('control — with a server chosen, the stand-in listener does see the connector connect', async (t) => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-connector-noserver-control-'));
    const nc = await fakeNextcloud();
    const standIn = await beeFlowStandIn();
    const appPort = await freePort();
    const child = fork(RUNNER, [], {
        env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            APP_ID: 'bee_flow',
            APP_SECRET: SECRET,
            APP_VERSION: '2.0.0-test',
            APP_PORT: String(appPort),
            APP_PERSISTENT_STORAGE: storage,
            NEXTCLOUD_URL: nc.url,
            NETGUARD_ALLOW: `127.0.0.1:${nc.port}`,
            NETGUARD_SINK: `127.0.0.1:${standIn.port}`,
            BEEFLOW_API_BASE_URL: 'https://bee-flow.example', // chosen at install time
            BEEFLOW_BOOTSTRAP_RETRY_MS: '0',
        },
        execArgv: ['--require', NET_GUARD],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const diverted = [];
    child.on('message', (m) => { if (m.diverted) diverted.push(m.diverted); });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    t.after(async () => {
        child.kill('SIGKILL');
        await exited;
        await close(nc.server);
        await close(standIn.server);
        fs.rmSync(storage, { recursive: true, force: true });
    });

    await until(() => standIn.seen.connections > 0, 'the bootstrap reached the stand-in listener');
    assert.ok(diverted.includes('bee-flow.example:443'), `diverted: ${diverted.join(', ')}`);
    assert.ok(nc.calls.some((c) => c.url.includes('/cloud/groups/admin/users')), 'the bootstrap read the administrators');
});
