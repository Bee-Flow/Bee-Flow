/**
 * The check is a gate, so it has to REFUSE: an unregistered package, a stale
 * registry entry, a package without a Dependabot entry, one on another cadence.
 * The pure functions are tested directly; one sandbox run covers the CLI and
 * the exit codes.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { check, covers, manifestDirs, parseDependabot, Unparseable } from './check-package-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ROLES = { service: 's', tooling: 't', satellite: 'x' };
const pkg = (dir, extra = {}) => ({ dir, ecosystem: 'npm', role: 'satellite', lockfile: 'npm', dependabot: 'monthly', ...extra });
const FILES = ['package.json', 'package-lock.json', 'a/package.json', 'a/package-lock.json', 'c/one/package.json', 'c/one/package-lock.json'];
const YML = `
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: monthly, time: "05:00" }
    groups:
      root:
        patterns: ["*"]
  - package-ecosystem: npm
    directories: ["/a", "/c/*"]
    schedule: { interval: monthly }
    groups:
      rest:
        patterns: ["*"]
  - package-ecosystem: docker
    directory: /server
    schedule: { interval: monthly }
`;
const REGISTRY = { roles: ROLES, packages: [pkg('.'), pkg('a'), pkg('c/one')] };
const run = (over = {}) => check({ files: FILES, registry: REGISTRY, entries: parseDependabot(YML), ...over });

test('a registry that matches the tree and the Dependabot file has no violations', () => {
    assert.deepStrictEqual(run(), []);
});

test('manifestDirs finds package.json and requirements*.txt, and skips node_modules', () => {
    const dirs = manifestDirs(['package.json', 'x/requirements-dev.txt', 'x/node_modules/y/package.json', 'x/README.md', 'x/y/requirements.txt']);
    assert.deepStrictEqual([...dirs.keys()].sort(), ['.', 'x', 'x/y']);
    assert.ok(dirs.get('.').has('npm'));
    assert.ok(dirs.get('x').has('pip'));
});

test('a package in git that is not in the registry is named', () => {
    const v = run({ files: [...FILES, 'new/package.json', 'new/package-lock.json'] });
    assert.strictEqual(v.length, 1);
    assert.match(v[0], /new has a npm manifest in git but is not in scripts\/packages\.json/);
});

test('a requirements file is a pip package of its own', () => {
    const v = run({ files: [...FILES, 'svc/requirements.txt'] });
    assert.match(v.join('\n'), /svc has a pip manifest/);
});

test('a registry entry whose manifest is gone is named', () => {
    const v = run({ registry: { roles: ROLES, packages: [...REGISTRY.packages, pkg('gone')] } });
    assert.ok(v.some((m) => /lists gone \(npm\) but git has no package\.json/.test(m)), v.join('\n'));
});

test('a duplicate, an unknown role and an unknown cadence are refused', () => {
    const dup = run({ registry: { roles: ROLES, packages: [...REGISTRY.packages, pkg('a')] } });
    assert.ok(dup.some((m) => /a \(npm\) is listed twice/.test(m)));
    const role = run({ registry: { roles: ROLES, packages: [pkg('.'), pkg('a', { role: 'boss' }), pkg('c/one')] } });
    assert.ok(role.some((m) => /role "boss"/.test(m)));
    const cad = run({ registry: { roles: ROLES, packages: [pkg('.'), pkg('a', { dependabot: 'daily' }), pkg('c/one')] } });
    assert.ok(cad.some((m) => /dependabot "daily"/.test(m)));
});

test('the lockfile type has to match what is in git', () => {
    const noLock = run({ files: FILES.filter((f) => f !== 'a/package-lock.json') });
    assert.ok(noLock.some((m) => /a \(npm\): registry says lockfile "npm" but package-lock\.json is not in git/.test(m)), noLock.join('\n'));
    const claimsNone = run({ registry: { roles: ROLES, packages: [pkg('.'), pkg('a', { lockfile: 'none' }), pkg('c/one')] } });
    assert.ok(claimsNone.some((m) => /a \(npm\): registry says lockfile "none" but package-lock\.json is in git/.test(m)));
    const wrongKind = run({ registry: { roles: ROLES, packages: [pkg('.'), pkg('a', { lockfile: 'pip' }), pkg('c/one')] } });
    assert.ok(wrongKind.some((m) => /a \(npm\): registry says lockfile "pip"/.test(m)));
});

test('a package without a Dependabot entry fails, and so does one on another cadence', () => {
    const missing = run({ entries: parseDependabot(YML.replace('"/a", ', '')) });
    assert.ok(missing.some((m) => /a \(npm\) has no npm entry in \.github\/dependabot\.yml/.test(m)), missing.join('\n'));
    const other = run({ registry: { roles: ROLES, packages: [pkg('.', { dependabot: 'weekly' }), pkg('a'), pkg('c/one')] } });
    assert.ok(other.some((m) => /registry says weekly but .*schedules it monthly/.test(m)));
});

test('an entry without a groups block fails', () => {
    const yml = YML.replace('    groups:\n      root:\n        patterns: ["*"]\n', '');
    const v = run({ entries: parseDependabot(yml) });
    assert.ok(v.some((m) => /\. \(npm\): its \.github\/dependabot\.yml entry has no groups/.test(m)), v.join('\n'));
});

test('two entries for one directory are refused', () => {
    const v = run({ entries: parseDependabot(`${YML}  - package-ecosystem: npm\n    directory: /a\n    schedule: { interval: weekly }\n    groups:\n      g:\n        patterns: ["*"]\n`) });
    assert.ok(v.some((m) => /a \(npm\) is covered by 2 npm entries/.test(m)));
});

test('dependabot "none" needs a reason, and is stale once an entry exists', () => {
    const noReason = run({ registry: { roles: ROLES, packages: [pkg('.'), pkg('a'), pkg('c/one', { dependabot: 'none' })] } });
    assert.ok(noReason.some((m) => /needs a "reason"/.test(m)));
    const stale = run({ registry: { roles: ROLES, packages: [pkg('.'), pkg('a'), pkg('c/one', { dependabot: 'none', reason: 'because' })] } });
    assert.ok(stale.some((m) => /c\/one \(npm\): registry says dependabot "none" but .* has an entry/.test(m)));
    const ok = run({
        files: [...FILES, 'free/package.json'],
        registry: { roles: ROLES, packages: [...REGISTRY.packages, pkg('free', { lockfile: 'none', dependabot: 'none', reason: 'no deps' })] },
    });
    assert.deepStrictEqual(ok, []);
});

test('a Dependabot entry for a directory that is not a package is refused', () => {
    const v = run({ entries: parseDependabot(`${YML}  - package-ecosystem: pip\n    directory: /ghost\n    schedule: { interval: monthly }\n    groups:\n      g:\n        patterns: ["*"]\n`) });
    assert.ok(v.some((m) => /pip entry for "\/ghost" that matches no package/.test(m)));
});

test('covers: "/" is the root, a trailing * is one segment', () => {
    assert.ok(covers('/', '.'));
    assert.ok(!covers('/', 'a'));
    assert.ok(covers('/components/*', 'components/x'));
    assert.ok(!covers('/components/*', 'components/x/y'));
    assert.ok(!covers('/components/*', 'components'));
    assert.ok(covers('/server/', 'server'));
});

test('parseDependabot reads directory, block lists, nested schedules and ignores comments', () => {
    const entries = parseDependabot(`# top
version: 2
updates:
  # a comment
  - package-ecosystem: "npm"   # trailing
    directories:
      - /one
      - "/two/*"
    schedule:
      interval: weekly
      day: monday
    groups:
      g:
        patterns: ["*"]
    ignore:
      - dependency-name: x
`);
    assert.deepStrictEqual(entries, [{ ecosystem: 'npm', directories: ['/one', '/two/*'], interval: 'weekly', hasGroups: true }]);
});

test('parseDependabot refuses what it cannot classify instead of skipping it', () => {
    assert.throws(() => parseDependabot('updates:\n  - package-ecosystem: npm\n    schedule: { interval: monthly }\n'), Unparseable);
    assert.throws(() => parseDependabot('updates:\n  - package-ecosystem: npm\n    directory: /a\n'), Unparseable);
    assert.throws(() => parseDependabot('updates:\n    directory: /a\n'), Unparseable);
    assert.throws(() => parseDependabot('updates:\n  - package-ecosystem: npm\n\tdirectory: /a\n'), Unparseable);
});

test('the CLI exits 1 on a violation and 0 on a clean tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-registry-'));
    const w = (rel, body) => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    };
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['check-package-registry.mjs', 'entry-point.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(dir, 'scripts', f));
    w('package.json', '{}');
    w('package-lock.json', '{}');
    w('.github/dependabot.yml', 'updates:\n  - package-ecosystem: npm\n    directory: /\n    schedule: { interval: monthly }\n    groups:\n      g:\n        patterns: ["*"]\n');
    w('scripts/packages.json', JSON.stringify({ roles: ROLES, packages: [pkg('.')] }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const cli = () => {
        try {
            const stdout = execFileSync(process.execPath, ['scripts/check-package-registry.mjs'], { cwd: dir, encoding: 'utf8' });
            return { code: 0, stdout, stderr: '' };
        } catch (e) {
            return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
        }
    };
    assert.strictEqual(cli().code, 0);
    w('extra/package.json', '{}');
    const r = cli();
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /extra has a npm manifest in git but is not in scripts\/packages\.json/);
});
