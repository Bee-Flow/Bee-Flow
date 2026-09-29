/**
 * A component cannot name its own npm dependencies.
 *
 * `npm install` runs lifecycle scripts — preinstall/install/postinstall — by
 * default, as this process, in a directory whose package.json a CALLER wrote:
 * routes/components.js and routes/ai/agentChat.js both build that file from a
 * request body. So "create a component" used to mean "run arbitrary code on
 * the host", before the component itself executed a single line. The container
 * carries no USER directive (server/Dockerfile), so that was root.
 *
 * Three separate call sites ran a bare `exec('npm install --silent')` — the
 * boot scan, single install, and the package.json edit, which a caller can
 * drive repeatedly. They share one gate now, so a fourth caller cannot
 * reintroduce the hole by copying the old line.
 *
 * An allowlist rather than `--ignore-scripts`: two shipped components depend on
 * better-sqlite3, a native module that cannot install without its build script.
 * Naming the packages keeps every shipped component working and still removes
 * the attacker's actual lever, which is choosing the package NAME.
 *
 * Run: cd server && node --test --test-force-exit core/cms/componentManager.deps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ALLOWED_DEPENDENCIES, disallowedDependencies, installDependencies } = require('./componentManager');

/** A throwaway component directory with the given package.json. */
function fixture(pkg) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-component-'));
    if (pkg !== null) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    return dir;
}

test('a package nobody vetted is refused', () => {
    const dir = fixture({ name: 'evil', dependencies: { 'totally-not-malware': '^1.0.0' } });
    assert.deepStrictEqual(disallowedDependencies(dir), ['totally-not-malware']);
});

test('the refusal names every offender, not just the first', () => {
    const dir = fixture({ name: 'x', dependencies: { axios: '^1.6.0', 'evil-one': '1', 'evil-two': '1' } });
    assert.deepStrictEqual(disallowedDependencies(dir).sort(), ['evil-one', 'evil-two']);
});

test('an allowlisted package passes', () => {
    const dir = fixture({ name: 'ok', dependencies: { axios: '^1.6.0', cheerio: '^1.0.0' } });
    assert.deepStrictEqual(disallowedDependencies(dir), []);
});

test('no dependencies at all is fine, and does not reach npm', async () => {
    const dir = fixture({ name: 'bare' });
    const r = await installDependencies(dir, 'bare');
    assert.deepStrictEqual(r, { installed: true, blocked: [] });
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), 'npm should not have been run at all');
});

test('a refused component reports blocked and installs nothing', async () => {
    const dir = fixture({ name: 'evil', dependencies: { 'totally-not-malware': '^1.0.0' } });
    const r = await installDependencies(dir, 'evil');
    assert.strictEqual(r.installed, false);
    assert.deepStrictEqual(r.blocked, ['totally-not-malware']);
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), 'a refused component must not reach npm');
});

test('an unreadable or absent package.json is not an opening', async () => {
    // A directory with no package.json has nothing to install. It must not
    // fall through to a bare npm install in an attacker-controlled cwd.
    const dir = fixture(null);
    const r = await installDependencies(dir, 'nopkg');
    assert.deepStrictEqual(r, { installed: true, blocked: [] });
    assert.ok(!fs.existsSync(path.join(dir, 'node_modules')));
});

test('malformed JSON does not throw — the component is skipped, not the boot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-component-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{ this is not json');
    const r = await installDependencies(dir, 'broken');
    assert.strictEqual(r.installed, true);
});

// ── the shipped catalog ─────────────────────────────────────────────────────

test('every component that ships installs under the allowlist', () => {
    // The allowlist only keeps today's behaviour because it was built FROM the
    // shipped components. If one gains a dependency without the list gaining
    // it too, that component silently stops installing — safe, but a surprise,
    // so it fails here instead.
    const dir = path.resolve(__dirname, '../../../components');
    if (!fs.existsSync(dir)) return; // not checked out in every deployment
    const offenders = [];
    for (const name of fs.readdirSync(dir)) {
        const compDir = path.join(dir, name);
        if (!fs.existsSync(path.join(compDir, 'package.json'))) continue;
        const bad = disallowedDependencies(compDir);
        if (bad.length) offenders.push(`${name}: ${bad.join(', ')}`);
    }
    assert.deepStrictEqual(offenders, [],
        'these shipped components declare dependencies that are not allowlisted — they will '
        + 'not install. Add them to ALLOWED_DEPENDENCIES in core/cms/componentManager.js.');
});

test('the allowlist stays a closed, reviewed set', () => {
    // Not a style rule: the whole defence is that a caller cannot widen this
    // from a request body. A wildcard or a value read from env would end that.
    assert.ok(ALLOWED_DEPENDENCIES instanceof Set);
    assert.ok(ALLOWED_DEPENDENCIES.size > 0 && ALLOWED_DEPENDENCIES.size < 50,
        'suspiciously large allowlist — has it become a dumping ground?');
    for (const name of ALLOWED_DEPENDENCIES) {
        assert.strictEqual(typeof name, 'string');
        assert.ok(!name.includes('*'), `wildcard entry "${name}" defeats the allowlist`);
    }
});

test('every npm invocation in componentManager goes through the gate', () => {
    // The hole existed in triplicate. This fails if a fourth call site copies
    // the old line instead of calling installDependencies.
    const src = fs.readFileSync(path.join(__dirname, 'componentManager.js'), 'utf8');
    const execs = src.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /exec\(\s*'npm install/.test(line) && !line.trim().startsWith('*'));
    assert.strictEqual(execs.length, 1,
        `expected exactly one npm invocation (inside installDependencies); found ${execs.length} `
        + `at lines ${execs.map(e => e.n).join(', ')}`);
});
