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
import fs from 'node:fs';
import path from 'node:path';
import { hasBash, sandbox, run, callsOf, flagValues, REPO } from './lib/docker-stub.mjs';

const skip = hasBash ? false : 'bash is not available';

const SCRIPTS = ['scripts/build-images.sh', 'scripts/lib/compose-env.sh'];
const STACK = {
    'docker-compose.from-registry.yml': 'services: {}\n',
    'docker-compose.hub.local.yml': 'services: {}\n',
};

// The real staging script runs npm over the real lockfiles; the build tests
// only need to know it was called, with what, and that its failure is not
// the build's. (Its own behaviour is covered at the end of this file.)
const STAGE_STUB = `#!/usr/bin/env bash
echo "$BUILD_SHA $*" >> "$(dirname "$0")/../.stage-log"
[[ -z "\${STAGE_FAIL:-}" ]] || exit 1
`;

function repo(t, extra = {}) {
    return sandbox(t, {
        scripts: SCRIPTS,
        files: {
            ...STACK,
            'server/package.json': '{\n  "dependencies": {\n    "express": "5.0.0",\n    "playwright": "1.59.1"\n  }\n}\n',
            'scripts/stage-server-context.sh': STAGE_STUB,
            ...extra,
        },
    });
}

const stageCalls = (dir) => {
    const f = path.join(dir, '.stage-log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
};

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

test('a container on another image fails the run as STALE CONTAINER', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'server', '--recreate'], { STUB_RUNNING_IMAGE: 'sha256:old' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /STALE CONTAINER/);
});

// license-server's source is private (Bee-Flow-AI-internal) and is built from
// a checkout beside this repo, LICENSE_SERVER_SRC (env, then .env, then
// ../Bee-Flow-AI-internal/license-server). A bulk build without it skips,
// naming it without it is an error.

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

// FAST_DEV skips the Nextcloud /embed/ shell: fine for dev, never for a prd image.

test('FAST_DEV=1 refuses a prd agent-hub build before docker builds anything', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'prd', 'agent-hub'], { FAST_DEV: '1' });
    assert.notStrictEqual(res.status, 0, res.stdout);
    assert.match(res.stderr, /FAST_DEV=1 skips the Nextcloud embed build; refusing/);
    assert.strictEqual(callsOf(res.calls, 'build').length, 0);
});

test('FAST_DEV=1 still passes BUILD_EMBED=false for a dev agent-hub build', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'agent-hub'], { FAST_DEV: '1' });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const [b] = callsOf(res.calls, 'build');
    assert.ok(b.args.includes('BUILD_EMBED=false'), b.args.join(' '));
});

// ── Local images = CI images ───────────────────────────────────────────────
// build-push-ghcr.yml builds the images and stages the server's context; the
// two local scripts must build the same set of services (minus the private
// license-server) from the same contexts, and stage the server the same way.

const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/build-push-ghcr.yml'), 'utf8');
const sh = fs.readFileSync(path.join(REPO, 'scripts/build-images.sh'), 'utf8');
const ps1 = fs.readFileSync(path.join(REPO, 'scripts/build-images.ps1'), 'utf8');

/** service -> build context, from each CI job's docker/build-push-action `context:`. */
function workflowContexts() {
    const out = {};
    let job = null;
    for (const line of workflow.split('\n')) {
        const j = /^ {2}([a-z][a-z-]*):\s*$/.exec(line);
        if (j) job = j[1];
        const c = /^\s+context:\s+\.\/(\S+)\s*$/.exec(line);
        if (c && job) (out[job] ||= new Set()).add(c[1]);
    }
    return out;
}

/** service -> context, from build-images.sh's SERVICES array. */
function shContexts() {
    const block = /^SERVICES=\(\n([\s\S]*?)^\)/m.exec(sh)[1];
    return Object.fromEntries([...block.matchAll(/^\s*"([^|"]+)\|([^|"]*)\|/gm)].map((m) => [m[1], m[2]]));
}

/** service -> context, from build-images.ps1's $Services array. */
function ps1Contexts() {
    const block = /^\$Services = @\(\n([\s\S]*?)^\)/m.exec(ps1)[1];
    return Object.fromEntries(
        [...block.matchAll(/Name = "([^"]+)";\s*Context = ([^;]+?);/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]),
    );
}

const ciOnly = (text, re) => (re.exec(text)?.[1] ?? '').split(/[\s,]+/).filter(Boolean).map((x) => x.replace(/["')]/g, ''));

// license-server is built from a private checkout, so CI has no job for it.
const PRIVATE = ['license-server'];

test('the services build-images.sh builds are the ones the workflow builds', () => {
    const ci = Object.keys(workflowContexts()).filter((j) => workflowContexts()[j]);
    const known = /KNOWN="([^"]+)"/.exec(workflow)[1].split(/\s+/);
    assert.deepStrictEqual([...ci].sort(), [...known].sort(), 'workflow: jobs with a build context vs KNOWN services');
    const local = [...Object.keys(shContexts()), ...ciOnly(sh, /^CI_ONLY_SERVICES=\(([^)]*)\)/m)].filter((s) => !PRIVATE.includes(s));
    assert.deepStrictEqual(local.sort(), [...known].sort());
});

test('the services build-images.ps1 builds are the ones the workflow builds', () => {
    const known = /KNOWN="([^"]+)"/.exec(workflow)[1].split(/\s+/);
    const local = [...Object.keys(ps1Contexts()), ...ciOnly(ps1, /^\$CiOnlyServices = @\(([^)]*)\)/m)].filter((s) => !PRIVATE.includes(s));
    assert.deepStrictEqual(local.sort(), [...known].sort());
});

test('both scripts build each service from the context CI builds it from', () => {
    const ci = workflowContexts();
    const sources = { 'build-images.sh': shContexts(), 'build-images.ps1': ps1Contexts() };
    for (const [file, contexts] of Object.entries(sources)) {
        for (const [svc, ctx] of Object.entries(contexts)) {
            if (PRIVATE.includes(svc)) continue;
            assert.ok(ci[svc], `${file}: ${svc} has no job in the workflow`);
            assert.deepStrictEqual([...ci[svc]], [ctx], `${file}: context of ${svc}`);
        }
    }
});

test('the workflow stages the server context with the shared script', () => {
    assert.match(workflow, /run: bash scripts\/stage-server-context\.sh --install runtime-bundle/);
    assert.match(workflow, /run: bash scripts\/stage-server-context\.sh sbom/);
    assert.match(sh, /scripts\/stage-server-context\.sh/);
    assert.match(ps1, /scripts\/stage-server-context\.sh/);
});

test('a bulk build builds pwt-runner too, with the tag the server auto-detects', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const runner = callsOf(res.calls, 'build').find((c) => flagValues(c.args, '-t').some((r) => r.includes('/pwt-runner:')));
    assert.ok(runner, 'pwt-runner was not built');
    assert.deepStrictEqual(flagValues(runner.args, '-t'), ['ghcr.io/bee-flow/pwt-runner:dev', 'beeflow-pwt-runner:pw-1.59.1']);
    assert.strictEqual(runner.args[runner.args.length - 1], path.join(dir, 'server/pwt-runner'));
});

test('push never pushes the un-prefixed local pwt-runner tag', { skip }, (t) => {
    const dir = repo(t, { '.docker/config.json': '{"auths":{"ghcr.io":{}}}\n' });
    const res = run(dir, 'scripts/build-images.sh', ['push', 'dev', 'pwt-runner'], { HOME: dir });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const pushed = res.calls.filter((c) => c.args[0] === 'push').map((c) => c.args[1]);
    assert.deepStrictEqual(pushed, ['ghcr.io/bee-flow/pwt-runner:dev']);
    assert.ok(!pushed.some((r) => r.startsWith('beeflow-pwt-runner')), pushed.join(' '));
});

test('the server build stages its context and stamps the image with the same sha', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'server']);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.deepStrictEqual(stageCalls(dir), ['local all']);
    const [b] = callsOf(res.calls, 'build');
    assert.ok(flagValues(b.args, '--build-arg').includes('APP_BUILD_SHA=local'), b.args.join(' '));
});

test('FAST_DEV=1 skips the runtime bundle for a dev server build, never for prd', { skip }, (t) => {
    const dev = repo(t);
    assert.strictEqual(run(dev, 'scripts/build-images.sh', ['build', 'dev', 'server'], { FAST_DEV: '1' }).status, 0);
    assert.deepStrictEqual(stageCalls(dev), ['local sbom']);
    const prd = repo(t);
    assert.strictEqual(run(prd, 'scripts/build-images.sh', ['build', 'prd', 'server'], { FAST_DEV: '1' }).status, 0);
    assert.deepStrictEqual(stageCalls(prd), ['local all']);
});

test('other services do not stage the server context', { skip }, (t) => {
    const dir = repo(t);
    assert.strictEqual(run(dir, 'scripts/build-images.sh', ['build', 'dev', 'agent-hub', 'guard']).status, 0);
    assert.deepStrictEqual(stageCalls(dir), []);
});

test('a failing staging is a warning, the server image is still built', { skip }, (t) => {
    const dir = repo(t);
    const res = run(dir, 'scripts/build-images.sh', ['build', 'dev', 'server'], { STAGE_FAIL: '1' });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stderr, /server context staging failed/);
    assert.strictEqual(callsOf(res.calls, 'build').length, 1);
});

// ── scripts/stage-server-context.sh itself ─────────────────────────────────

const STAGE = ['scripts/stage-server-context.sh'];

function stageRepo(t, files = {}) {
    return sandbox(t, { scripts: STAGE, files });
}

// The sandbox's .stub-bin is first on PATH: an executable there stands in for npm.
function fakeNpm(dir, script) {
    fs.writeFileSync(path.join(dir, '.stub-bin/npm'), script, { mode: 0o755 });
}

const LOCK = '{ "lockfileVersion": 3, "packages": {} }\n';

test('staging the SBOM stamps every document with the build and copies the server one', { skip }, (t) => {
    // A fake npm: prints a CycloneDX document for `npm sbom`.
    const npm = `#!/usr/bin/env bash
[[ "$1" == "sbom" ]] || exit 1
echo '{"bomFormat":"CycloneDX","components":[{"name":"x"}]}'
`;
    const dir = stageRepo(t, {
        'server/package-lock.json': LOCK,
        'agent-hub/package-lock.json': LOCK,
    });
    fakeNpm(dir, npm);
    const res = run(dir, 'scripts/stage-server-context.sh', ['sbom'], { BUILD_SHA: 'abc123def4567', BUILD_REF: 'main' });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const out = path.join(dir, 'server/sbom');
    assert.deepStrictEqual(fs.readdirSync(out).sort(), ['agent-hub.cyclonedx.json', 'cyclonedx.json', 'server.cyclonedx.json']);
    const bom = JSON.parse(fs.readFileSync(path.join(out, 'cyclonedx.json'), 'utf8'));
    const props = Object.fromEntries(bom.metadata.properties.map((p) => [p.name, p.value]));
    assert.deepStrictEqual(props, { 'beeflow:build_sha': 'abc123def4567', 'beeflow:workspace': 'server', 'beeflow:build_ref': 'main' });
    assert.deepStrictEqual(bom, JSON.parse(fs.readFileSync(path.join(out, 'server.cyclonedx.json'), 'utf8')));
});

test('staging the SBOM without a server lockfile fails and leaves nothing stale behind', { skip }, (t) => {
    const dir = stageRepo(t, { 'server/sbom/cyclonedx.json': '{"old":true}' });
    const res = run(dir, 'scripts/stage-server-context.sh', ['sbom']);
    assert.notStrictEqual(res.status, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'server/sbom/cyclonedx.json')), 'the previous build\'s SBOM must not survive a failed run');
});

test('the runtime bundle refuses an agent-hub without node_modules instead of installing', { skip }, (t) => {
    const dir = stageRepo(t, { 'agent-hub/package.json': '{}\n', 'server/vendor/app-runtime/app-runtime.mjs': 'old' });
    const res = run(dir, 'scripts/stage-server-context.sh', ['runtime-bundle']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /agent-hub\/node_modules is missing/);
    assert.ok(!fs.existsSync(path.join(dir, 'server/vendor/app-runtime')), 'a stale bundle must not survive a failed run');
});

test('the runtime bundle refuses a partial build', { skip }, (t) => {
    // A fake npm whose build writes an empty .mjs: the contract is two non-empty files.
    const npm = `#!/usr/bin/env bash
[[ "$1 $2" == "run build:runtime" ]] || exit 1
mkdir -p dist-runtime && : > dist-runtime/app-runtime.mjs && echo css > dist-runtime/app-runtime.css
`;
    const dir = stageRepo(t, { 'agent-hub/node_modules/.keep': '' });
    fakeNpm(dir, npm);
    const res = run(dir, 'scripts/stage-server-context.sh', ['runtime-bundle']);
    assert.notStrictEqual(res.status, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'server/vendor/app-runtime/app-runtime.mjs')));
});

test('"all" runs both parts even when the first fails, and still fails', { skip }, (t) => {
    const dir = stageRepo(t);
    const res = run(dir, 'scripts/stage-server-context.sh', ['all']);
    assert.notStrictEqual(res.status, 0);
    assert.match(res.stderr, /runtime-bundle failed/);
    assert.match(res.stderr, /sbom failed/);
});
