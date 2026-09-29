/**
 * scripts/dev-rebuild.sh: which stack its recreate lands on.
 *
 * The recreate must address the same stack a bare `docker compose up` in the
 * repo root runs (the COMPOSE_FILE set, the same project and .env), and never
 * layer the opt-in security-scan override unless --security asks for it.
 *
 * Each case copies the script into a throwaway repo root and drives it with
 * bash against a docker stub (scripts/lib/docker-stub.mjs).
 */

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { hasBash, sandbox, run, callsOf, flagValues } from './lib/docker-stub.mjs';

const skip = hasBash ? false : 'bash is not available';

const SCRIPTS = ['scripts/dev-rebuild.sh', 'scripts/lib/compose-env.sh'];
const STACK = {
    'docker-compose.from-registry.yml': 'services: {}\n',
    'docker-compose.hub.local.yml': 'services: {}\n',
    'docker-compose.security.override.yml': 'services: {}\n',
    'server/index.js': 'module.exports = 1;\n',
    'agent-hub/index.js': 'module.exports = 2;\n',
};

function repo(t, extra = {}) {
    return sandbox(t, { scripts: SCRIPTS, files: { ...STACK, ...extra } });
}

/** The -f files of the single `compose up`, repo-relative. */
function upFiles(dir, calls) {
    const ups = callsOf(calls, 'up');
    assert.strictEqual(ups.length, 1, `expected one compose up, got ${JSON.stringify(calls)}`);
    return flagValues(ups[0].args, '-f').map((f) => path.relative(dir, f));
}

test('recreates from the COMPOSE_FILE set in .env, pinned to the repo project, without the security override', { skip }, (t) => {
    const dir = repo(t, { '.env': 'COMPOSE_FILE=docker-compose.from-registry.yml;docker-compose.hub.local.yml\n' });
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', 'server']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.deepStrictEqual(upFiles(dir, res.calls), ['docker-compose.from-registry.yml', 'docker-compose.hub.local.yml']);
    const up = callsOf(res.calls, 'up')[0].args;
    assert.deepStrictEqual(flagValues(up, '--project-directory'), [dir]);
    assert.deepStrictEqual(flagValues(up, '--env-file'), [path.join(dir, '.env')]);
    assert.ok(!up.includes('-p'), 'no hard-coded project name');
    assert.ok(up.includes('server') && !up.includes('agent-hub'));
});

test('--security layers the override on top of the stack files, and only then', { skip }, (t) => {
    const dir = repo(t, { '.env': 'COMPOSE_FILE=docker-compose.from-registry.yml;docker-compose.hub.local.yml\n' });
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', '--security', 'server']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.deepStrictEqual(upFiles(dir, res.calls), [
        'docker-compose.from-registry.yml',
        'docker-compose.hub.local.yml',
        'docker-compose.security.override.yml',
    ]);
});

test('with no COMPOSE_FILE anywhere it falls back to docker-compose.from-registry.yml alone', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', 'server']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.deepStrictEqual(upFiles(dir, res.calls), ['docker-compose.from-registry.yml']);
    assert.deepStrictEqual(flagValues(callsOf(res.calls, 'up')[0].args, '--env-file'), []);
});

test('COMPOSE_FILE from the shell wins over .env', { skip }, (t) => {
    const dir = repo(t, { '.env': 'COMPOSE_FILE=docker-compose.from-registry.yml;docker-compose.hub.local.yml\n' });
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', 'server'], { COMPOSE_FILE: 'docker-compose.from-registry.yml' });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.deepStrictEqual(upFiles(dir, res.calls), ['docker-compose.from-registry.yml']);
});

test('a missing compose file fails before anything is built', { skip }, (t) => {
    const dir = repo(t, { '.env': 'COMPOSE_FILE=docker-compose.from-registry.yml;docker-compose.gone.yml\n' });
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', 'server']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /compose file not found: .*docker-compose\.gone\.yml/);
    assert.deepStrictEqual(callsOf(res.calls, 'build'), []);
    assert.deepStrictEqual(callsOf(res.calls, 'up'), []);
});

// The image ref: what the build tags must be what compose recreates from.

test('TAG from .env: the build tags it and compose is handed the same TAG', { skip }, (t) => {
    const dir = repo(t, { '.env': 'TAG=dev\n' });
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', 'server']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const [build] = callsOf(res.calls, 'build');
    assert.deepStrictEqual(flagValues(build.args, '-t'), ['ghcr.io/bee-flow/server:dev']);
    const [up] = callsOf(res.calls, 'up');
    assert.strictEqual(up.TAG, 'dev');
    assert.strictEqual(up.REGISTRY, 'ghcr.io/bee-flow');
    assert.match(res.stdout, /verified: server is running ghcr\.io\/bee-flow\/server:dev/);
});

test('with no TAG anywhere it builds and recreates :dev, like build-images.sh', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', 'server']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.deepStrictEqual(flagValues(callsOf(res.calls, 'build')[0].args, '-t'), ['ghcr.io/bee-flow/server:dev']);
    assert.strictEqual(callsOf(res.calls, 'up')[0].TAG, 'dev');
});

test('REGISTRY and TAG from the shell win over .env, for the build and the recreate alike', { skip }, (t) => {
    const dir = repo(t, { '.env': 'TAG=dev\nREGISTRY=registry.example.invalid/team\n' });
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force', 'server'], { TAG: 'mine', REGISTRY: 'localhost:5000/bf' });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.deepStrictEqual(flagValues(callsOf(res.calls, 'build')[0].args, '-t'), ['localhost:5000/bf/server:mine']);
    const [up] = callsOf(res.calls, 'up');
    assert.strictEqual(up.TAG, 'mine');
    assert.strictEqual(up.REGISTRY, 'localhost:5000/bf');
});

test('a container left on another image fails the run, and the next run rebuilds instead of skipping', { skip }, (t) => {
    const dir = repo(t);
    const stale = run(dir, 'scripts/dev-rebuild.sh', ['server'], { STUB_RUNNING_IMAGE: 'sha256:old' });
    assert.strictEqual(stale.status, 1);
    assert.match(stale.stderr, /STALE CONTAINER: 'server'/);
    assert.doesNotMatch(stale.stdout, /Done\./);

    const again = run(dir, 'scripts/dev-rebuild.sh', ['server']);
    assert.strictEqual(again.status, 0, again.stderr + again.stdout);
    assert.strictEqual(callsOf(again.calls, 'build').length, 1, 'the unverified build is not recorded as done');

    const third = run(dir, 'scripts/dev-rebuild.sh', ['server']);
    assert.strictEqual(third.status, 0);
    assert.deepStrictEqual(callsOf(third.calls, 'build'), [], 'a verified build is recorded');
    assert.match(third.stdout, /server: unchanged since last build/);
});

test('both services in parallel: each is verified against its own ref', { skip }, (t) => {
    const dir = repo(t, { '.env': 'TAG=dev\n' });
    const res = run(dir, 'scripts/dev-rebuild.sh', ['--force']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stdout, /verified: server is running ghcr\.io\/bee-flow\/server:dev/);
    assert.match(res.stdout, /verified: agent-hub is running ghcr\.io\/bee-flow\/agent-hub:dev/);
});
