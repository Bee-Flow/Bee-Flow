/**
 * A throwaway repo root plus a fake `docker` on PATH, for the tests of the
 * build/recreate shell scripts (build-images.sh, dev-rebuild.sh).
 *
 * The scripts are copied into a temporary directory, so the real repo .env
 * (TAG, COMPOSE_FILE, HF_TOKEN, ...) can never leak into a case, and they are
 * run with bash against a stub that records every docker call as one JSON line:
 * its argv plus the REGISTRY and TAG it saw in its environment, which is what
 * `docker compose` resolves the image refs from.
 *
 * Stub behaviour, steered per case through env vars:
 *   STUB_SERVICES        `compose config --services`, comma-separated (default: server,agent-hub)
 *   STUB_RUNNING_IMAGE   image ID a container reports (default: the built one)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');

export const hasBash = process.platform !== 'win32' && !spawnSync('bash', ['-c', 'exit 0']).error;

/** The image ID every "built" image reports. */
export const BUILT_IMAGE_ID = 'sha256:built';

const STUB = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.STUB_LOG, JSON.stringify({
  args,
  REGISTRY: env.REGISTRY === undefined ? null : env.REGISTRY,
  TAG: env.TAG === undefined ? null : env.TAG,
}) + '\\n');
const out = (s) => process.stdout.write(s + '\\n');
if (args[0] === 'buildx') {
  if (args[1] === 'inspect') out('Driver: docker');
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') { out(${JSON.stringify(BUILT_IMAGE_ID)}); process.exit(0); }
if (args[0] === 'inspect') { out(env.STUB_RUNNING_IMAGE || ${JSON.stringify(BUILT_IMAGE_ID)}); process.exit(0); }
if (args[0] === 'compose') {
  const sub = args.find((a) => a === 'up' || a === 'ps' || a === 'config');
  if (sub === 'config') out((env.STUB_SERVICES || 'server,agent-hub').split(',').join('\\n'));
  if (sub === 'ps') out('cid-' + args[args.length - 1]);
  process.exit(0);
}
process.exit(0);
`;

// Identity and signing per call, and no hooks: one in the user's global config
// must not run in the sandbox.
const GIT_ISOLATION = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

/**
 * A git repo under os.tmpdir() holding copies of `scripts` (repo-relative
 * paths) and the given extra files ({ 'rel/path': 'content' }), with the
 * docker stub in <dir>/.stub-bin. Removed after the test.
 */
export function sandbox(t, { scripts, files = {} }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-stub-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const rel of scripts) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
    }
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    fs.mkdirSync(path.join(dir, '.stub-bin'));
    fs.mkdirSync(path.join(dir, '.tmp'));
    fs.writeFileSync(path.join(dir, '.stub-bin', 'docker'), STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.stub-bin/\n.tmp/\n.buildx-cache/\n');
    const res = spawnSync('git', [...GIT_ISOLATION, 'init', '-q'], { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git init: ${res.stderr}`);
    return dir;
}

// Everything that could steer the scripts from the caller's shell.
const SCRUBBED = ['REGISTRY', 'TAG', 'HF_TOKEN', 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PATH_SEPARATOR', 'FAST_DEV', 'BEEFLOW_FORCE_CONTAINER_BUILDER', 'LICENSE_SERVER_SRC'];

/**
 * Run `bash <dir>/<script> ...args` with the stub first on PATH. Returns the
 * exit status, the output, and the docker calls in order.
 */
export function run(dir, script, args, env = {}) {
    const log = path.join(dir, '.stub-log.jsonl');
    fs.rmSync(log, { force: true });
    const base = { ...process.env };
    for (const k of SCRUBBED) delete base[k];
    const res = spawnSync('bash', [path.join(dir, script), ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: {
            ...base,
            PATH: `${path.join(dir, '.stub-bin')}${path.delimiter}${process.env.PATH}`,
            TMPDIR: path.join(dir, '.tmp'),
            STUB_LOG: log,
            ...env,
        },
    });
    const calls = fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls };
}

/** The docker calls of one kind: 'build' (buildx build), 'up', 'ps', 'config'. */
export function callsOf(calls, kind) {
    if (kind === 'build') return calls.filter((c) => c.args[0] === 'buildx' && c.args[1] === 'build');
    return calls.filter((c) => c.args[0] === 'compose' && c.args.includes(kind));
}

/** The values following each occurrence of `flag` in argv. */
export function flagValues(args, flag) {
    const out = [];
    args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); });
    return out;
}
