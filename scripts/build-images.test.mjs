/**
 * scripts/build-images.sh: what `build dev --recreate` builds, recreates and
 * verifies.
 *
 * Each case copies the script into a throwaway repo root (so the real repo
 * .env cannot leak in) and drives it with bash against a docker stub
 * (scripts/lib/docker-stub.mjs).
 */

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { hasBash, sandbox, run, callsOf, flagValues } from './lib/docker-stub.mjs';

const skip = hasBash ? false : 'bash is not available';

const SCRIPTS = ['scripts/build-images.sh', 'scripts/lib/compose-env.sh'];
const STACK = {
    'docker-compose.from-registry.yml': 'services: {}\n',
    'docker-compose.hub.local.yml': 'services: {}\n',
};

function repo(t, extra = {}) {
    return sandbox(t, { scripts: SCRIPTS, files: { ...STACK, ...extra } });
}

test('--recreate uses the COMPOSE_FILE set from .env and verifies the built image', { skip }, (t) => {
    const dir = repo(t, { '.env': 'COMPOSE_FILE=docker-compose.from-registry.yml;docker-compose.hub.local.yml\n' });
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'server', '--recreate']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const ups = callsOf(res.calls, 'up');
    assert.strictEqual(ups.length, 1);
    assert.deepStrictEqual(
        flagValues(ups[0].args, '-f').map((f) => path.relative(dir, f)),
        ['docker-compose.from-registry.yml', 'docker-compose.hub.local.yml'],
    );
    assert.deepStrictEqual(flagValues(ups[0].args, '--project-directory'), [dir]);
    assert.deepStrictEqual(flagValues(ups[0].args, '--env-file'), [path.join(dir, '.env')]);
    assert.strictEqual(ups[0].TAG, 'dev');
    assert.match(res.stdout, /verified: server is running ghcr\.io\/bee-flow\/server:dev/);
});

// The reranker without HF_TOKEN: skipped on a bulk build, and a skip is not a
// build. The stub lists reranker as a stack service, as docker-compose.yml does.

const RERANKER_STACK = { STUB_SERVICES: 'server,agent-hub,guard-service,pii-service,search-api,license-server,reranker' };

test('a bulk build without HF_TOKEN skips the reranker and never recreates or verifies it', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', '--recreate'], RERANKER_STACK);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stderr, /Skipping reranker - HF_TOKEN not set/);
    const built = callsOf(res.calls, 'build').flatMap((c) => flagValues(c.args, '-t'));
    assert.ok(!built.some((ref) => ref.includes('/reranker:')), `reranker was built: ${built}`);
    const [up] = callsOf(res.calls, 'up');
    assert.ok(up.args.includes('server'), 'the services that did build are recreated');
    assert.ok(!up.args.includes('reranker'), `reranker recreated: ${up.args.join(' ')}`);
    assert.doesNotMatch(res.stdout, /verified: reranker/);
});

test('with HF_TOKEN the reranker is built, recreated and verified', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'reranker', '--recreate'], { ...RERANKER_STACK, HF_TOKEN: 'hf_placeholder' });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const [build] = callsOf(res.calls, 'build');
    assert.deepStrictEqual(flagValues(build.args, '-t'), ['ghcr.io/bee-flow/reranker:dev']);
    assert.ok(callsOf(res.calls, 'up')[0].args.includes('reranker'));
    assert.match(res.stdout, /verified: reranker is running ghcr\.io\/bee-flow\/reranker:dev/);
});

test('asking for the reranker by name without HF_TOKEN is still a hard error', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'reranker', '--recreate'], RERANKER_STACK);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /HF_TOKEN must be set to build reranker/);
    assert.deepStrictEqual(callsOf(res.calls, 'build'), []);
    assert.deepStrictEqual(callsOf(res.calls, 'up'), []);
});

test('a container on another image fails the run as STALE CONTAINER', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'server', '--recreate'], { STUB_RUNNING_IMAGE: 'sha256:old' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /STALE CONTAINER/);
});

// license-server's source is private (Bee-Flow-AI-internal) and is built from
// a checkout beside this repo, LICENSE_SERVER_SRC (env, then .env, then
// ../Bee-Flow-AI-internal/license-server). Same rule as the reranker: a bulk
// build without it skips, naming it without it is an error.

const HUB_STACK = { STUB_SERVICES: 'server,agent-hub,license-server' };

test('a bulk build without the private checkout skips license-server and never recreates it', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', '--recreate'], { ...HUB_STACK, LICENSE_SERVER_SRC: 'no-such-checkout' });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stderr, /Skipping license-server - its private source is not checked out/);
    const built = callsOf(res.calls, 'build').flatMap((c) => flagValues(c.args, '-t'));
    assert.ok(!built.some((ref) => ref.includes('/license-server:')), `license-server was built: ${built}`);
    const [up] = callsOf(res.calls, 'up');
    assert.ok(up.args.includes('server'), 'the services that did build are recreated');
    assert.ok(!up.args.includes('license-server'), `license-server recreated: ${up.args.join(' ')}`);
});

test('asking for license-server by name without the checkout is a hard error naming the default path', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'license-server', '--recreate'], HUB_STACK);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /license-server is Bee Flow-internal/);
    assert.match(res.stderr, /\.\.\/Bee-Flow-AI-internal\/license-server/);
    assert.deepStrictEqual(callsOf(res.calls, 'build'), []);
    assert.deepStrictEqual(callsOf(res.calls, 'up'), []);
});

test('license-server builds from LICENSE_SERVER_SRC in .env, resolved against the repo root', { skip }, (t) => {
    const dir = repo(t, {
        '.env': 'LICENSE_SERVER_SRC=private/license-server\n',
        'private/license-server/Dockerfile': 'FROM scratch\n',
    });
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'license-server', '--recreate'], HUB_STACK);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const [build] = callsOf(res.calls, 'build');
    assert.deepStrictEqual(flagValues(build.args, '-t'), ['ghcr.io/bee-flow/license-server:dev']);
    assert.strictEqual(build.args[build.args.length - 1], path.join(dir, 'private/license-server'));
    assert.ok(callsOf(res.calls, 'up')[0].args.includes('license-server'));
    assert.match(res.stdout, /verified: license-server is running ghcr\.io\/bee-flow\/license-server:dev/);
});
