/**
 * A gate that only ever passes is indistinguishable from no gate.
 *
 * check-playwright-lockstep.mjs runs in the server and pwt-runner image jobs
 * and has one job: go RED when a hand bump moved one of the four Playwright
 * pins and not the others, before that image is pushed.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'check-playwright-lockstep.mjs');

// A version set to null leaves that dependency out; dockerfile: null and
// serverPkg/runnerPkg: false leave the whole file out.
function sandbox({
    image = '1.59.1',
    server = '1.59.1',
    runner = '1.59.1',
    runnerTest = '1.59.1',
    dockerfile,
    serverPkg = true,
    runnerPkg = true,
} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwlockstep-'));
    fs.mkdirSync(path.join(dir, 'server/pwt-runner'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts/check-playwright-lockstep.mjs'));
    // `=== undefined`, not `??`: null has to mean "no Dockerfile", not the default.
    const from =
        dockerfile === undefined
            ? `# runner\nFROM mcr.microsoft.com/playwright:v${image}-noble@sha256:${'0'.repeat(64)}\nWORKDIR /app\n`
            : dockerfile;
    if (from !== null) fs.writeFileSync(path.join(dir, 'server/pwt-runner/Dockerfile'), from);
    const deps = (entries) => Object.fromEntries(entries.filter(([, v]) => v !== null));
    if (serverPkg) {
        fs.writeFileSync(
            path.join(dir, 'server/package.json'),
            JSON.stringify({ name: 'server', dependencies: deps([['express', '5.0.0'], ['playwright', server]]) }),
        );
    }
    if (runnerPkg) {
        fs.writeFileSync(
            path.join(dir, 'server/pwt-runner/package.json'),
            JSON.stringify({
                name: 'pwt-runner',
                dependencies: deps([['@playwright/test', runnerTest], ['playwright', runner]]),
            }),
        );
    }
    return dir;
}

function run(dir) {
    try {
        const stdout = execFileSync(process.execPath, [path.join(dir, 'scripts/check-playwright-lockstep.mjs')], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, GITHUB_ACTIONS: '' },
        });
        return { code: 0, stdout, stderr: '' };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
}

test('the real repository passes', () => {
    const r = run(REPO);
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /all four name \d+\.\d+\.\d+/);
});

test('a sandbox where all four agree passes', () => {
    const r = run(sandbox());
    assert.strictEqual(r.code, 0, r.stdout + r.stderr);
});

test('a server bump without the runner is refused', () => {
    // The case the server job exists for: server/package.json alone moved,
    // which does not fire the pwt-runner job.
    const r = run(sandbox({ server: '1.60.0' }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /server\/package\.json playwright: 1\.60\.0/);
    assert.match(r.stderr, /disagree/);
});

test('a base-image bump without the packages is refused', () => {
    const r = run(sandbox({ image: '1.60.0' }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /Dockerfile base image: 1\.60\.0/);
});

test('@playwright/test left behind in the runner is refused', () => {
    const r = run(sandbox({ runnerTest: '1.58.2' }));
    assert.strictEqual(r.code, 1);
});

test('a caret range is not the same as the pinned version', () => {
    const r = run(sandbox({ server: '^1.59.1' }));
    assert.strictEqual(r.code, 1, 'a range can resolve to another minor than the base image');
});

test('a base image that is no longer the Playwright image fails loudly, it does not skip', () => {
    const r = run(sandbox({ dockerfile: 'FROM node:22-slim\n' }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /Dockerfile base image: <missing>/);
});

test('a missing Dockerfile or manifest fails loudly, it does not skip', () => {
    assert.strictEqual(run(sandbox({ dockerfile: null })).code, 1);
    assert.strictEqual(run(sandbox({ serverPkg: false })).code, 1);
    assert.strictEqual(run(sandbox({ runnerPkg: false })).code, 1);
});

test('playwright dropped from the server manifest fails loudly', () => {
    const r = run(sandbox({ server: null }));
    assert.strictEqual(r.code, 1);
    assert.match(r.stdout, /server\/package\.json playwright: <missing>/);
});
