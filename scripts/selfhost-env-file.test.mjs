/**
 * selfhost.sh writes .env owner-only.
 *
 * The file holds every secret of the stack (session secret, master key, DB
 * and object-store passwords, the sidecar key, the first admin password). A
 * plain `cp` gives it the template's mode under the caller's umask, which on
 * most hosts is world-readable. ensure_env() is run here on its own, with the
 * helpers it calls stubbed, against a scratch directory.
 *
 * Run: node --test scripts/selfhost-env-file.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO } from './lib/docker-stub.mjs';

const script = fs.readFileSync(path.join(REPO, 'selfhost.sh'), 'utf8');
const fn = /^ensure_env\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0];

test('ensure_env is still a function this test can lift out', () => {
    assert.ok(fn, 'ensure_env() { ... } not found in selfhost.sh');
});

test('a fresh .env is created with mode 600 even under a permissive umask', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfhost-env-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const template = path.join(dir, '.env.selfhost.example');
    fs.writeFileSync(template, 'SESSION_SECRET=CHANGE_ME\nDB_PASSWORD=CHANGE_ME\n');
    fs.chmodSync(template, 0o644);
    const envFile = path.join(dir, '.env');
    const harness = [
        '#!/bin/bash',
        'set -euo pipefail',
        'umask 022',
        `ENV_TEMPLATE="${template}"`,
        `ENV_FILE="${envFile}"`,
        'log() { :; }; ok() { :; }; err() { echo "$*" >&2; exit 1; }',
        'gen_hex() { printf "%0*d" "$(( $1 * 2 ))" 0; }',
        'gen_password() { printf "pw"; }',
        'set_env() { printf "%s=%s\\n" "$1" "$2" >> "$ENV_FILE"; }',
        fn,
        'ensure_env',
    ].join('\n');
    execFileSync('bash', ['-c', harness], { stdio: 'pipe' });
    const mode = fs.statSync(envFile).mode & 0o777;
    assert.strictEqual(mode.toString(8), '600');
    assert.match(fs.readFileSync(envFile, 'utf8'), /SESSION_SECRET=/);
});
