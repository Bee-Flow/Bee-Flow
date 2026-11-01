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
import { check, FILES, OTHER_PROFILES, parseCompose, splitImage, allProfiles, isThirdParty, envTemplateProblems, templateKeys } from './check-compose-drift.mjs';
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
        'docker-compose.from-registry.yml': `services:\n  server:\n    environment:\n      - DB_PASSWORD=\${DB_PASSWORD:?err}\n      - ALLOW_SIGNUPS=\${ALLOW_SIGNUPS:-false}\n${svc('db', 'pgvector/pgvector:pg15', '[ "core" ]')}${svc('redis', 'redis:7-alpine', '[ "guard" ]')}${svc('umami', 'ghcr.io/umami-software/umami:3.4.0', '[ "analytics" ]')}`,
        'docker-compose.hub.local.yml': `services:\n${svc('license-server', '${REGISTRY:-ghcr.io/bee-flow}/license-server:${TAG:-dev}', '[ "core" ]')}`,
        'docker-compose.security.override.yml': 'services:\n  server:\n    environment:\n      - A=1\n',
        'selfhost.sh': '#!/bin/sh\nALL_PROFILES="core guard analytics"\n',
        '.env.selfhost.example': '# comment\nDB_PASSWORD=CHANGE_ME\n# UNSET_ONE=\nALLOW_SIGNUPS=false\n',
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
        '.env.selfhost.example': '',
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

// ── 3. the self-host template reaches the registry stack ───────────────────

test('a template key that no service in the registry stack reads fails, naming the key', (t) => {
    const dir = sandbox(t, { '.env.selfhost.example': 'DB_PASSWORD=CHANGE_ME\nALLOW_SIGNUPS=false\nFORGOTTEN=1\n' });
    const problems = check(dir);
    assert.strictEqual(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /\.env\.selfhost\.example sets FORGOTTEN/);
    assert.match(problems[0], /docker-compose\.from-registry\.yml/);
});

test('commented-out template keys are not required to reach the stack', (t) => {
    const dir = sandbox(t, { '.env.selfhost.example': 'DB_PASSWORD=CHANGE_ME\nALLOW_SIGNUPS=false\n# PII_SERVICE_URL=http://guard:8100\n' });
    assert.deepStrictEqual(check(dir), []);
});

test('a key the stack reads with `?err` or `:-default` or a bare `}` all count as read', () => {
    const template = 'A=1\nB=2\nC=3\n';
    const compose = 'services:\n  s:\n    environment:\n      - A=${A:?err}\n      - B=${B:-x}\n      - C=${C}\n';
    assert.deepStrictEqual(envTemplateProblems(template, compose, []), []);
});

test('COMPOSE_ONLY exempts a key with a reason, and a stale entry fails', () => {
    const template = 'ONLY_FOR_SCRIPT=1\nREAD_ONE=2\n';
    const compose = 'services:\n  s:\n    environment:\n      - READ_ONE=${READ_ONE:-x}\n';
    assert.deepStrictEqual(envTemplateProblems(template, compose, [{ key: 'ONLY_FOR_SCRIPT', why: 'selfhost.sh reads it' }]), []);
    const [stale] = envTemplateProblems(template, compose, [{ key: 'ONLY_FOR_SCRIPT', why: 'x' }, { key: 'GONE', why: 'x' }]);
    assert.match(stale, /COMPOSE_ONLY names GONE/);
    const [readNow] = envTemplateProblems(template, compose, [{ key: 'ONLY_FOR_SCRIPT', why: 'x' }, { key: 'READ_ONE', why: 'x' }]);
    assert.match(readNow, /COMPOSE_ONLY names READ_ONE, which .* reads now/);
});

test('the real template reaches the real registry stack', () => {
    const template = fs.readFileSync(path.join(REPO, '.env.selfhost.example'), 'utf8');
    const compose = fs.readFileSync(path.join(REPO, 'docker-compose.from-registry.yml'), 'utf8');
    assert.deepStrictEqual(envTemplateProblems(template, compose), []);
    assert.ok(templateKeys(template).includes('ALLOW_SIGNUPS'));
});
