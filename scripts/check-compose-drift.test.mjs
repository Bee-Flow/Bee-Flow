/**
 * A gate that only ever passes is indistinguishable from no gate.
 *
 * check-compose-drift.mjs has two jobs: go RED when one compose file bumps a
 * third-party image the others still pin, and when a profile exists in a
 * compose file but not in selfhost.sh's ALL_PROFILES (or the reverse).
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, FILES, OTHER_PROFILES, parseCompose, splitImage, allProfiles, isThirdParty } from './check-compose-drift.mjs';
import { REPO } from './lib/docker-stub.mjs';

const svc = (name, image, profiles) =>
    `  ${name}:\n    image: ${image}\n${profiles ? `    profiles: ${profiles}\n` : ''}`;

/** A repo of five agreeing compose files plus selfhost.sh; `patch` overrides files. */
function sandbox(t, patch = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'composedrift-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const files = {
        'docker-compose.yml': `services:\n${svc('db', 'pgvector/pgvector:pg15')}${svc('redis', 'redis:7-alpine')}${svc('umami', 'ghcr.io/umami-software/umami:3.4.0', '[analytics]')}`,
        'docker-compose.dev.yml': `services:\n${svc('db', 'pgvector/pgvector:pg15')}${svc('hub', '${REGISTRY:-ghcr.io/bee-flow}/license-server:${TAG:-dev}', '[hub]')}`,
        'docker-compose.from-registry.yml': `services:\n${svc('db', 'pgvector/pgvector:pg15', '[ "core" ]')}${svc('redis', 'redis:7-alpine', '[ "guard" ]')}${svc('umami', 'ghcr.io/umami-software/umami:3.4.0', '[ "analytics" ]')}`,
        'docker-compose.hub.local.yml': `services:\n${svc('license-server', '${REGISTRY:-ghcr.io/bee-flow}/license-server:${TAG:-dev}', '[ "core" ]')}`,
        'docker-compose.security.override.yml': 'services:\n  server:\n    environment:\n      - A=1\n',
        'selfhost.sh': '#!/bin/sh\nALL_PROFILES="core guard analytics"\n',
        ...patch,
    };
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
    return dir;
}

test('agreeing files pass', (t) => {
    assert.deepStrictEqual(check(sandbox(t)), []);
});

test('the real compose files agree', () => {
    assert.deepStrictEqual(check(REPO), []);
});

test('a third-party image bumped in one file only fails, naming both tags and files', (t) => {
    const dir = sandbox(t, { 'docker-compose.yml': `services:\n${svc('redis', 'redis:8-alpine')}` });
    const [p] = check(dir);
    assert.match(p, /image redis has different tags/);
    assert.match(p, /8-alpine in docker-compose\.yml/);
    assert.match(p, /7-alpine in docker-compose\.from-registry\.yml/);
});

test('first-party images with their own tags are not compared', (t) => {
    const dir = sandbox(t, {
        'docker-compose.yml': `services:\n${svc('lic', '${REGISTRY:-ghcr.io/bee-flow}/license-server:${TAG:-latest}')}${svc('pwt', 'beeflow-pwt-runner:local')}`,
    });
    assert.deepStrictEqual(check(dir), []);
});

test('a profile that selfhost.sh does not know fails', (t) => {
    const dir = sandbox(t, { 'docker-compose.from-registry.yml': `services:\n${svc('db', 'pgvector/pgvector:pg15', '[ "core", "extras" ]')}${svc('redis', 'redis:7-alpine', '[ "guard" ]')}${svc('umami', 'ghcr.io/umami-software/umami:3.4.0', '[ "analytics" ]')}` });
    assert.match(check(dir).join('\n'), /declares profile "extras", which is not in ALL_PROFILES/);
});

test('an ALL_PROFILES entry no compose file declares fails', (t) => {
    const dir = sandbox(t, { 'selfhost.sh': 'ALL_PROFILES="core guard analytics ghost"\n' });
    assert.match(check(dir).join('\n'), /lists "ghost", which docker-compose\.from-registry\.yml does not declare/);
});

test('block-style profiles are read', (t) => {
    const block = 'services:\n  a:\n    image: x/y:1\n    profiles:\n      - core\n      - "guard"\n  b:\n    image: x/z:1\n';
    assert.deepStrictEqual(parseCompose(block).profiles, ['core', 'guard']);
    const dir = sandbox(t, {
        'docker-compose.from-registry.yml': 'services:\n  a:\n    image: pgvector/pgvector:pg15\n    profiles:\n      - core\n      - guard\n      - analytics\n',
    });
    assert.deepStrictEqual(check(dir), []);
});

test('the hub profile is allowed only in the dev stack, and only while it is still there', (t) => {
    assert.ok(OTHER_PROFILES.some((o) => o.file === 'docker-compose.dev.yml' && o.profile === 'hub' && o.why));
    const moved = sandbox(t, { 'docker-compose.yml': `services:\n${svc('x', 'redis:7-alpine', '[hub]')}` });
    assert.match(check(moved).join('\n'), /docker-compose\.yml declares profile "hub"/);
    const gone = sandbox(t, { 'docker-compose.dev.yml': `services:\n${svc('db', 'pgvector/pgvector:pg15')}` });
    assert.match(check(gone).join('\n'), /OTHER_PROFILES names "hub" in docker-compose\.dev\.yml, which no longer declares it/);
});

test('an unreadable file or a missing ALL_PROFILES fails instead of skipping', (t) => {
    const dir = sandbox(t);
    fs.rmSync(path.join(dir, 'docker-compose.hub.local.yml'));
    assert.match(check(dir).join('\n'), /docker-compose\.hub\.local\.yml: cannot read/);
    assert.match(check(sandbox(t, { 'selfhost.sh': '#!/bin/sh\n' })).join('\n'), /no ALL_PROFILES/);
    assert.deepStrictEqual(FILES.length, 5);
});

test('image parsing', () => {
    assert.deepStrictEqual(splitImage('ghcr.io/umami-software/umami:3.4.0'), { repo: 'ghcr.io/umami-software/umami', tag: '3.4.0' });
    assert.deepStrictEqual(splitImage('localhost:5000/app'), { repo: 'localhost:5000/app', tag: '(none)' });
    assert.deepStrictEqual(splitImage('redis:7@sha256:abc'), { repo: 'redis', tag: '7@sha256:abc' });
    assert.strictEqual(isThirdParty('${BROWSER_IMAGE:-${REGISTRY:-ghcr.io/bee-flow}/pwt-runner:${TAG:-latest}}'), false);
    assert.deepStrictEqual(allProfiles('ALL_PROFILES="a b  c"\n'), ['a', 'b', 'c']);
    assert.deepStrictEqual(parseCompose('services:\n  a:\n    image: redis:7 # pinned\n    # image: redis:6\n').images, ['redis:7']);
});
