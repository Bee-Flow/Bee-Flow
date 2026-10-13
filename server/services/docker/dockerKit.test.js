/**
 * dockerKit: the Docker helpers pwtRunner, guardInstaller and
 * webpageRuntimeManager each carried a copy of. Pinned against a fake
 * dockerode client.
 *
 * Run: cd server && node --test services/docker/dockerKit.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { EventEmitter } = require('events');

const kit = require('./dockerKit');

function httpErr(statusCode, message = 'x') { const e = new Error(message); e.statusCode = statusCode; return e; }

test('isServerInContainer: /.dockerenv, then cgroup, else native', (t) => {
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    t.after(() => { fs.existsSync = realExists; fs.readFileSync = realRead; });
    fs.existsSync = (p) => p === '/.dockerenv';
    assert.strictEqual(kit.isServerInContainer(), true);
    fs.existsSync = () => false;
    fs.readFileSync = (p, enc) => (p === '/proc/1/cgroup' ? '0::/kubepods/abc' : realRead(p, enc));
    assert.strictEqual(kit.isServerInContainer(), true);
    fs.readFileSync = (p, enc) => (p === '/proc/1/cgroup' ? '0::/' : realRead(p, enc));
    assert.strictEqual(kit.isServerInContainer(), false);
    fs.readFileSync = () => { throw new Error('no proc'); };
    assert.strictEqual(kit.isServerInContainer(), false);
});

test('imageExists: true, false on 404, rethrows anything else', async () => {
    const mk = (fn) => ({ getImage: () => ({ inspect: fn }) });
    assert.strictEqual(await kit.imageExists(mk(async () => ({})), 'i'), true);
    assert.strictEqual(await kit.imageExists(mk(async () => { throw httpErr(404); }), 'i'), false);
    await assert.rejects(kit.imageExists(mk(async () => { throw httpErr(500, 'boom'); }), 'i'), /boom/);
});

function fakePullDocker({ pullErr, finishErr, events = [] } = {}) {
    const seen = { followArgs: null };
    return {
        seen,
        pull(image, cb) {
            if (pullErr) return cb(pullErr);
            cb(null, new EventEmitter());
        },
        modem: {
            followProgress(...args) {
                seen.followArgs = args.length;
                const [, onFinished, onProgress] = args;
                for (const e of events) if (onProgress) onProgress(e);
                onFinished(finishErr || null);
            },
        },
    };
}

test('pullImage: forwards progress events, resolves on finish, rejects on errors', async () => {
    const got = [];
    const d = fakePullDocker({ events: [{ status: 'Downloading' }, { status: 'Pull complete' }] });
    await kit.pullImage(d, 'img', (e) => got.push(e.status));
    assert.deepStrictEqual(got, ['Downloading', 'Pull complete']);
    assert.strictEqual(d.seen.followArgs, 3);
    const quiet = fakePullDocker();
    await kit.pullImage(quiet, 'img');
    assert.strictEqual(quiet.seen.followArgs, 2, 'no progress callback is passed when none is given');
    await assert.rejects(kit.pullImage(fakePullDocker({ pullErr: new Error('denied') }), 'img'), /denied/);
    await assert.rejects(kit.pullImage(fakePullDocker({ finishErr: new Error('broken') }), 'img'), /broken/);
});

test('ensureNetwork: keeps an existing network, creates a missing one, rethrows others', async () => {
    const created = [];
    const mk = (fn) => ({ getNetwork: () => ({ inspect: fn }), createNetwork: async (o) => created.push(o) });
    await kit.ensureNetwork(mk(async () => ({})), 'n1');
    assert.deepStrictEqual(created, []);
    await kit.ensureNetwork(mk(async () => { throw httpErr(404); }), 'n2');
    assert.deepStrictEqual(created, [{ Name: 'n2', Driver: 'bridge' }]);
    await assert.rejects(kit.ensureNetwork(mk(async () => { throw httpErr(500, 'down'); }), 'n3'), /down/);
});

test('connectSelfToNetwork: needs HOSTNAME, 403 / already-exists is success, others report', async (t) => {
    const prev = process.env.HOSTNAME;
    t.after(() => { if (prev === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = prev; });
    const mk = (fn) => ({ getNetwork: (n) => ({ connect: (o) => fn(n, o) }) });
    delete process.env.HOSTNAME;
    assert.strictEqual(await kit.connectSelfToNetwork(mk(async () => {}), 'net'), false);
    process.env.HOSTNAME = 'abc';
    let args;
    assert.strictEqual(await kit.connectSelfToNetwork(mk(async (n, o) => { args = [n, o]; }), 'net'), true);
    assert.deepStrictEqual(args, ['net', { Container: 'abc' }]);
    assert.strictEqual(await kit.connectSelfToNetwork(mk(async () => { throw httpErr(403); }), 'net'), true);
    assert.strictEqual(await kit.connectSelfToNetwork(mk(async () => { throw new Error('endpoint already exists'); }), 'net'), true);
    const errs = [];
    assert.strictEqual(await kit.connectSelfToNetwork(mk(async () => { throw httpErr(500, 'nope'); }), 'net', (e) => errs.push(e.message)), false);
    assert.deepStrictEqual(errs, ['nope']);
    assert.strictEqual(await kit.connectSelfToNetwork(mk(async () => { throw httpErr(500, 'nope'); }), 'net'), false);
});

test('removeContainerIfExists: stops with the given grace, force-removes, ignores 404', async () => {
    const log = [];
    const docker = (removeErr, stopErr) => ({
        getContainer: (name) => ({
            stop: async (o) => { log.push(['stop', name, o.t]); if (stopErr) throw stopErr; },
            remove: async (o) => { log.push(['remove', name, o.force]); if (removeErr) throw removeErr; },
        }),
    });
    await kit.removeContainerIfExists(docker(null, new Error('not running')), 'c1', 10);
    assert.deepStrictEqual(log, [['stop', 'c1', 10], ['remove', 'c1', true]]);
    await kit.removeContainerIfExists(docker(httpErr(404)), 'c2', 3);
    await assert.rejects(kit.removeContainerIfExists(docker(httpErr(409, 'busy')), 'c3', 3), /busy/);
});
