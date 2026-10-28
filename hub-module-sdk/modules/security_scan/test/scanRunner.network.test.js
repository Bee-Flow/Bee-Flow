/**
 * Network wiring and pre-warm ownership of the scan runner, against a fake
 * docker client (no daemon needed).
 *
 *  1. In a container, the API server joins only the Internal control network,
 *     leaves SCAN_NETWORK, and reaches ZAP through a hardened relay; the
 *     toolbox sits on SCAN_NETWORK only.
 *  2. Natively, no relay and no control network: ZAP is published on 127.0.0.1.
 *  3. Scanner and relay images are pinned by digest and overridable by env.
 *  4. A warm toolbox can only be adopted or released by the user who warmed it,
 *     and the release route passes the session user.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const runner = require('../server/src/scanRunner.service');
const { mountSecurityRoutes } = require('../server/src/routes');
const { makeHostMock } = require('./hostMock');
const { serve } = require('./httpHarness');

const SELF = 'self-container-id';

function notFound() {
    return Object.assign(new Error('no such object'), { statusCode: 404 });
}

/** A fake dockerode client that records what the runner asks for. */
function fakeDocker() {
    const log = {
        createdNetworks: /** @type {any[]} */ ([]),
        connects: /** @type {{ network: string, container: string }[]} */ ([]),
        disconnects: /** @type {{ network: string, container: string }[]} */ ([]),
        containers: /** @type {any[]} */ ([]),
        removed: /** @type {string[]} */ ([]),
    };
    const networks = new Set();
    let seq = 0;
    const docker = {
        getNetwork(name) {
            return {
                inspect: async () => { if (!networks.has(name)) throw notFound(); return { Name: name }; },
                connect: async ({ Container }) => { log.connects.push({ network: name, container: Container }); },
                disconnect: async ({ Container }) => { log.disconnects.push({ network: name, container: Container }); },
            };
        },
        createNetwork: async (opts) => { networks.add(opts.Name); log.createdNetworks.push(opts); },
        getImage: () => ({ inspect: async () => ({}) }),
        getContainer: () => ({ stop: async () => { throw notFound(); }, remove: async () => { throw notFound(); } }),
        createContainer: async (opts) => {
            const id = `c${++seq}`;
            const c = {
                id,
                opts,
                start: async () => {},
                stop: async () => {},
                remove: async () => { log.removed.push(opts.name); },
                inspect: async () => ({ NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] } } }),
                logs: (_o, cb) => cb(new Error('no logs in tests')),
                exec: async () => ({
                    start: async () => ({ on() {} }),
                    inspect: async () => ({ ExitCode: 0 }),
                }),
                modem: { demuxStream() {} },
            };
            log.containers.push(c);
            return c;
        },
        modem: { followProgress() {} },
    };
    return { docker, log };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {boolean} inContainer
 */
function setup(t, inContainer) {
    const fake = fakeDocker();
    runner.__test.setDocker(() => /** @type {any} */ (fake.docker));
    runner.__test.setInContainer(inContainer);
    runner.__test.resetCaches();
    const prevHost = process.env.HOSTNAME;
    process.env.HOSTNAME = SELF;
    // ZAP readiness probe answers at once.
    t.mock.method(globalThis, 'fetch', async () => new Response('{"version":"2.17"}', { status: 200 }));
    t.after(() => {
        runner.__test.setDocker(null);
        runner.__test.setInContainer(null);
        runner.__test.resetCaches();
        if (prevHost === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = prevHost;
    });
    return fake;
}

test('in a container: server joins only the Internal control network and reaches ZAP via the relay', async (t) => {
    const { log } = setup(t, true);
    const handle = await runner.startAgentToolbox({ scanId: 'scan1', onLine: null });

    // Control network is Internal; the scan network is not (scanners need egress).
    const ctl = log.createdNetworks.find((n) => n.Name === runner.CONTROL_NETWORK);
    assert.ok(ctl, 'control network created');
    assert.strictEqual(ctl.Internal, true);
    const scan = log.createdNetworks.find((n) => n.Name === runner.SCAN_NETWORK);
    assert.ok(scan && !scan.Internal);

    // The server's own container: on the control network, off the scan network.
    assert.deepStrictEqual(
        log.connects.filter((c) => c.container === SELF),
        [{ network: runner.CONTROL_NETWORK, container: SELF }],
    );
    assert.deepStrictEqual(log.disconnects, [{ network: runner.SCAN_NETWORK, container: SELF }]);

    const [toolbox, relay] = log.containers;
    // Toolbox: scan network only, nothing published.
    assert.strictEqual(toolbox.opts.HostConfig.NetworkMode, runner.SCAN_NETWORK);
    assert.deepStrictEqual(Object.keys(toolbox.opts.NetworkingConfig.EndpointsConfig), [runner.SCAN_NETWORK]);
    assert.strictEqual(toolbox.opts.HostConfig.PortBindings, undefined);
    assert.ok(!log.connects.some((c) => c.container === toolbox.id), 'toolbox never joins another network');

    // Relay: control network + scan network, forwards one port to the toolbox, hardened.
    assert.strictEqual(relay.opts.Image, runner.RELAY_IMAGE);
    assert.strictEqual(relay.opts.HostConfig.NetworkMode, runner.CONTROL_NETWORK);
    assert.deepStrictEqual(relay.opts.Cmd, ['TCP-LISTEN:8080,fork,reuseaddr', `TCP:${toolbox.opts.name}:8080`]);
    assert.strictEqual(relay.opts.User, '65534:65534');
    assert.deepStrictEqual(relay.opts.HostConfig.CapDrop, ['ALL']);
    assert.strictEqual(relay.opts.HostConfig.CapAdd, undefined);
    assert.strictEqual(relay.opts.HostConfig.ReadonlyRootfs, true);
    assert.deepStrictEqual(relay.opts.HostConfig.Sysctls, { 'net.ipv4.ip_forward': '0' });
    assert.ok(relay.opts.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.strictEqual(relay.opts.HostConfig.PortBindings, undefined);
    assert.deepStrictEqual(log.connects.filter((c) => c.container === relay.id), [{ network: runner.SCAN_NETWORK, container: relay.id }]);
    assert.strictEqual(relay.opts.Labels['bf.scanId'], 'scan1', 'reaper and killScan see the relay');

    assert.strictEqual(handle.zap.baseUrl, `http://${relay.opts.name}:8080`);
    assert.strictEqual(handle.relayContainerId, relay.id);

    await handle.cleanup();
    assert.deepStrictEqual(log.removed.sort(), [relay.opts.name, toolbox.opts.name].sort());
});

test('natively: no relay, no control network, ZAP published on 127.0.0.1 only', async (t) => {
    const { log } = setup(t, false);
    const handle = await runner.startAgentToolbox({ scanId: 'scan2', onLine: null });

    assert.ok(!log.createdNetworks.some((n) => n.Name === runner.CONTROL_NETWORK));
    assert.deepStrictEqual(log.connects, []);
    assert.deepStrictEqual(log.disconnects, []);
    assert.strictEqual(log.containers.length, 1);
    const [toolbox] = log.containers;
    assert.deepStrictEqual(toolbox.opts.HostConfig.PortBindings, { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] });
    assert.strictEqual(handle.zap.baseUrl, 'http://127.0.0.1:49153');
    assert.strictEqual(handle.relayContainerId, null);
    await handle.cleanup();
});

test('scanner and relay images are pinned by digest by default', () => {
    for (const [name, image] of Object.entries(runner.PINNED_IMAGES)) {
        assert.match(image, /@sha256:[0-9a-f]{64}$/, name);
    }
    if (!process.env.SECURITY_SCANNER_ZAP_IMAGE) assert.strictEqual(runner.DEFAULT_IMAGES.zap, runner.PINNED_IMAGES.zap);
    if (!process.env.SECURITY_ZAP_RELAY_IMAGE) assert.strictEqual(runner.RELAY_IMAGE, runner.PINNED_IMAGES.relay);
});

test('each pinned image can be overridden by env', () => {
    const modPath = path.join(__dirname, '..', 'server', 'src', 'scanRunner.service.js');
    const res = spawnSync(process.execPath, ['-e', `
        const r = require(${JSON.stringify(modPath)});
        process.stdout.write(JSON.stringify({ images: r.DEFAULT_IMAGES, relay: r.RELAY_IMAGE }));
        process.exit(0);
    `], {
        env: {
            ...process.env,
            SECURITY_SCANNER_ZAP_IMAGE: 'zap:x',
            SECURITY_SCANNER_NUCLEI_IMAGE: 'nuclei:x',
            SECURITY_SCANNER_TESTSSL_IMAGE: 'testssl:x',
            SECURITY_ZAP_RELAY_IMAGE: 'relay:x',
        },
        encoding: 'utf8',
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.deepStrictEqual(JSON.parse(res.stdout), {
        images: { zap: 'zap:x', nuclei: 'nuclei:x', testssl: 'testssl:x' },
        relay: 'relay:x',
    });
});

// ── Pre-warm ownership ──────────────────────────────────────────────────────

test('a warm toolbox can only be adopted by the user who warmed it', async (t) => {
    const { log } = setup(t, false);
    const id = runner.prewarmToolbox({ userId: 'u1' });

    assert.strictEqual(await runner.adoptToolbox(id, 'u2'), null, 'another user gets nothing');
    assert.strictEqual(await runner.adoptToolbox(id, null), null, 'no user gets nothing');
    const handle = await runner.adoptToolbox(id, 'u1');
    assert.ok(handle, 'the owner adopts it');
    assert.strictEqual(handle.containerId, log.containers[0].id);
    assert.strictEqual(await runner.adoptToolbox(id, 'u1'), null, 'single use');
    await handle.cleanup();
});

test('a warm toolbox can only be released by the user who warmed it', async (t) => {
    const { log } = setup(t, false);
    const id = runner.prewarmToolbox({ userId: 42 });

    assert.strictEqual(await runner.releasePrewarm(id, 'someone-else'), false);
    assert.strictEqual(await runner.releasePrewarm(id, undefined), false);
    assert.deepStrictEqual(log.removed, [], 'nothing torn down for a stranger');

    assert.strictEqual(await runner.releasePrewarm(id, '42'), true, 'owner (id compared as string)');
    assert.strictEqual(await runner.adoptToolbox(id, 42), null, 'released toolbox is gone');
});

test('POST /scans/prewarm/:id/release passes the session user to the service', async () => {
    /** @type {unknown[][]} */
    const calls = [];
    const svc = {
        dockerAvailable: async () => true,
        prewarmToolbox: () => 'abc',
        releasePrewarm: async (...args) => { calls.push(args); return false; },
        toolboxStatus: async () => ({}),
        provisionToolbox: async () => ({}),
    };
    const host = makeHostMock();
    const router = host.express.Router();
    mountSecurityRoutes(router, { store: {}, scanRunnerSvc: /** @type {any} */ (svc), worker: { drainOne: async () => {} }, host });
    const { base, close } = await serve(router, { session: { user: { id: 'u7' } } });
    try {
        const res = await fetch(`${base}/scans/prewarm/deadbeef/release`, { method: 'POST' });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(calls, [['deadbeef', 'u7']]);
    } finally {
        await close();
    }
});
