/**
 * Registry contract tests — every shipped compliance check must be loadable,
 * uniquely identified, fully labeled, fully translated and correctly tagged
 * with the frameworks it counts for. The i18n assertion exists because five
 * checks once shipped with no `compliance.checks.*` keys at all, rendering raw
 * check ids in the UI.
 *
 * A fake `db` module is injected into require.cache so requiring the check
 * modules (and the stores they pull in) never touches Postgres.
 *
 * Run: node --test server/compliance/registry.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Fake of server/db.js so stores' initDB() and check queries are inert ──
const mockDb = {
    exec: async () => {},
    run: async () => ({ rowCount: 0, rows: [] }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const registry = require('./registry');
const frameworks = require('./frameworks');
// Auto-registers every module under checks/<checks_dir> for the ten built-in
// frameworks; dirs that do not exist yet are skipped.
const { CHECK_DIRS, loadedDirs } = require('./checks');

const { GUI_DEFAULTS } = require('../i18n/defaults/en');

// ── i18n sources ─────────────────────────────────────────────────────────
// The dictionary is server/i18n/defaults/en.js. During the Compliance Center
// redesign every workstream drops its NEW keys in
// .claude/handoff/compliance/keys/<stream>.json ({ en: {…}, nl: {…} }) and
// ONLY the integrator merges them into en.js — so a key is considered present
// when en.js has it OR a pending keys file has it. Once merged, the keys
// folder can go and this reads en.js alone; the assertion itself stays
// strict: a key in neither place still fails.
const KEYS_DIR = path.join(__dirname, '..', '..', '.claude', 'handoff', 'compliance', 'keys');

function pendingKeys() {
    const out = new Map(); // key → file that declares it
    if (!fs.existsSync(KEYS_DIR)) return out;
    for (const file of fs.readdirSync(KEYS_DIR).filter(f => f.endsWith('.json'))) {
        let doc;
        try { doc = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, file), 'utf8')); } catch { continue; }
        for (const key of Object.keys(doc?.en || {})) {
            if (typeof doc.en[key] === 'string' && doc.en[key].trim()) out.set(key, file);
        }
    }
    return out;
}
const PENDING = pendingKeys();
const hasKey = (key) => Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, key) || PENDING.has(key);

function checkFiles() {
    const dirs = CHECK_DIRS.map(d => path.join(__dirname, 'checks', d));
    return dirs.filter(d => fs.existsSync(d)).flatMap(dir =>
        // Colocated tests sit in these directories too. They are not check
        // files: checks/index.js skips them at load (requiring one in the live
        // process is what poisoned db.js's exports on 2026-09-04), so counting
        // them here would demand a registration that must never happen.
        fs.readdirSync(dir)
            .filter(f => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f))
            .map(f => path.join(dir, f)));
}

// ── loader ───────────────────────────────────────────────────────────────

test('the loader walks one directory per built-in framework', () => {
    assert.deepStrictEqual([...CHECK_DIRS], frameworks.listBuiltin().map(f => f.checks_dir));
    assert.deepStrictEqual([...CHECK_DIRS].sort(), ['aia', 'cra', 'data-act', 'dora', 'eaa', 'gdpr', 'iso27001', 'machinery', 'nis2', 'pld'].sort());
    // The three original dirs always exist; the rest land framework by framework.
    for (const d of ['gdpr', 'aia', 'iso27001']) assert.ok(loadedDirs().includes(d), `${d} must be loaded`);
    for (const d of loadedDirs()) assert.ok(fs.existsSync(path.join(__dirname, 'checks', d)), `${d} reported loaded but does not exist`);
});

test('every check file registers exactly one check', () => {
    const files = checkFiles();
    const all = registry.getAll();
    assert.ok(all.length >= 15, `expected at least 15 checks, got ${all.length}`);
    assert.strictEqual(all.length, files.length,
        `check files (${files.length}) and registered checks (${all.length}) diverge — duplicate id overwrote a check, or a module failed to load?`);
});

test('every existing check directory holds at least one check module', () => {
    for (const d of loadedDirs()) {
        const files = fs.readdirSync(path.join(__dirname, 'checks', d)).filter(f => f.endsWith('.js') && !/\.(test|spec)\.js$/.test(f));
        assert.ok(files.length, `checks/${d}/ exists but has no check module`);
    }
});

// ── shape ────────────────────────────────────────────────────────────────

test('check ids match their framework\'s id pattern and live in its directory', () => {
    for (const c of registry.getAll()) {
        const fw = frameworks.byRegulation(c.regulation);
        assert.ok(fw, `${c.id}: unknown regulation "${c.regulation}"`);
        // Per-framework shape from the catalogue: GDPR/AIA `<REG>-Art<N>-<slug>`,
        // ISO `ISO27001-<A.x.y|clN[.M]>-<slug>`, the newer ones allow
        // parentheses in the article ('NIS2-Art21(2)(j)-admin-mfa') and CRA's
        // `AnnexI-<part>` refs.
        assert.match(c.id, fw.id_pattern, `${c.id}: id does not match ${fw.id} pattern ${fw.id_pattern}`);
        assert.ok(c.id.startsWith(`${c.regulation}-`), `${c.id}: id prefix must be the home regulation`);
        assert.ok(['critical', 'high', 'medium', 'low'].includes(c.severity), `${c.id}: bad severity "${c.severity}"`);
        assert.ok(['global', 'per-source'].includes(c.scope), `${c.id}: bad scope "${c.scope}"`);
        if (c.scope === 'per-source') {
            assert.strictEqual(typeof c.listSubjects, 'function', `${c.id}: per-source check needs listSubjects()`);
        }
    }
});

test('CRA-Art14-vuln-reporting-clocks is spelled exactly so when CRA ships', () => {
    // CONTRACTS.md pins this id; the incident register links to it.
    if (!loadedDirs().includes('cra')) return;
    assert.ok(registry.get('CRA-Art14-vuln-reporting-clocks'), 'the CRA reporting check must use the contracted id');
});

test('ISO checks declare the Annex A controls they satisfy', () => {
    // The SoA joins control rows to checks via this array — a missing or
    // malformed entry silently drops the check from the SoA view.
    for (const c of registry.getAll()) {
        if (c.regulation !== 'ISO27001') continue;
        if (/^ISO27001-cl/.test(c.id)) continue; // clause checks map to clauses, not controls
        assert.ok(Array.isArray(c.controls) && c.controls.length,
            `${c.id}: ISO control check must declare controls: ['A.x.y', ...]`);
        for (const ref of c.controls) {
            assert.match(ref, /^A\.\d+\.\d+$/, `${c.id}: bad control ref "${ref}"`);
        }
    }
});

test('every check declares a verification label', () => {
    for (const c of registry.getAll()) {
        assert.ok(['automated', 'attestation', 'hybrid'].includes(c.verification),
            `${c.id}: verification must be automated|attestation|hybrid, got "${c.verification}"`);
    }
});

// ── frameworks[] ─────────────────────────────────────────────────────────

test('every check carries a normalised frameworks[] — home first, known regulations, non-empty refs', () => {
    const known = new Set(frameworks.regulationCodes());
    for (const c of registry.getAll()) {
        assert.ok(Array.isArray(c.frameworks) && c.frameworks.length, `${c.id}: frameworks[] missing`);
        assert.deepStrictEqual({ regulation: c.frameworks[0].regulation, ref: c.frameworks[0].ref }, { regulation: c.regulation, ref: c.article },
            `${c.id}: frameworks[0] must be the home { regulation, article }`);
        const seen = new Set();
        for (const f of c.frameworks) {
            assert.ok(known.has(f.regulation) && f.regulation !== 'CUSTOM', `${c.id}: unknown regulation "${f.regulation}" in frameworks[]`);
            assert.ok(typeof f.ref === 'string' && f.ref.trim(), `${c.id}: empty ref for ${f.regulation}`);
            assert.strictEqual(f.framework_id, frameworks.frameworkIdOf(f.regulation), `${c.id}: framework_id must follow the regulation`);
            assert.ok(f.in_force_since === null || /^\d{4}-\d{2}-\d{2}$/.test(f.in_force_since), `${c.id}: in_force_since must be an ISO date or null`);
            const key = `${f.regulation} ${f.ref}`;
            assert.ok(!seen.has(key), `${c.id}: duplicate framework tag ${key}`);
            seen.add(key);
        }
        // ISO controls[] are reflected as tags, so the SoA and the score agree.
        for (const ref of c.controls || []) {
            assert.ok(c.frameworks.some(f => f.regulation === 'ISO27001' && f.ref === ref), `${c.id}: control ${ref} missing from frameworks[]`);
        }
    }
});

test('a non-ISO check that counts for an Annex A control derives controls[] for the SoA join', () => {
    // The two bootstrap re-tags: GDPR Art. 33 also evidences A.5.24, the
    // DLP check A.8.12. Their `controls` is derived by register(), which is
    // what routes/compliance/shared.js _isoChecksByControl reads.
    const breach = registry.get('GDPR-Art33-breach-detection');
    assert.ok(breach, 'GDPR-Art33-breach-detection must be registered');
    assert.ok(breach.frameworks.some(f => f.regulation === 'ISO27001' && f.ref === 'A.5.24'));
    assert.ok(breach.controls.includes('A.5.24'), 'controls[] must be derived from the ISO tag');
    assert.ok(registry.getByFramework('ISO27001').includes(breach), 'counts for ISO');
    assert.ok(!registry.getPrimary('ISO27001').includes(breach), 'but is not an ISO check');
    assert.ok(registry.getPrimary('GDPR').includes(breach));

    const dlp = registry.get('GDPR-Art32-dlp-enabled');
    assert.ok(dlp, 'GDPR-Art32-dlp-enabled must be registered');
    assert.ok(dlp.controls.includes('A.8.12'));
});

test('register() derives controls[] from an ISO tag and rejects unknown regulations / empty refs', () => {
    const base = { severity: 'low', scope: 'global', verification: 'automated', evaluate: async () => ({ status: 'pass' }) };

    const tagged = { ...base, id: 'GDPR-Art99-registry-test', regulation: 'GDPR', article: '99', frameworks: [{ regulation: 'ISO27001', ref: 'A.5.99' }, { regulation: 'ISO27001', ref: 'A.5.99' }] };
    registry.register(tagged);
    try {
        assert.deepStrictEqual(tagged.controls, ['A.5.99']);
        assert.strictEqual(tagged.frameworks.length, 2, 'the duplicate ISO tag is dropped');
        assert.strictEqual(tagged.in_force_since, '2018-05-25');
        assert.ok(registry.getByFramework('ISO27001').includes(tagged));
    } finally {
        registry._unregister(tagged.id);
    }

    assert.throws(() => registry.register({ ...base, id: 'FOO-Art1-x', regulation: 'FOO', article: '1' }), /unknown regulation "FOO"/);
    assert.throws(() => registry.register({ ...base, id: 'CUSTOM-ACME-x', regulation: 'CUSTOM', article: '1' }), /unknown regulation "CUSTOM"/, 'custom frameworks are rows, not modules');
    assert.throws(() => registry.register({ ...base, id: 'GDPR-Art1-x', regulation: 'GDPR', article: '1', frameworks: [{ regulation: 'DORA', ref: '' }] }), /needs a non-empty ref/);
    assert.throws(() => registry.register({ ...base, id: 'GDPR-Art1-x', regulation: 'GDPR', article: '1', frameworks: [{ regulation: 'NOPE', ref: '1' }] }), /unknown regulation "NOPE"/);
    assert.throws(() => registry.register({ ...base, id: 'GDPR-Art1-x', regulation: 'GDPR', article: '' }), /home article/);
    assert.throws(() => registry.register({ ...base, id: 'GDPR-Art1-x', regulation: 'GDPR', article: '1', frameworks: 'ISO27001' }), /must be an array/);
});

// ── the dedup key (and the bytes it is written with) ─────────────────────

test('registry.js is line-reviewable text — no NUL or other stray control bytes', () => {
    // Genuinely textual, and irreducibly so: this is a claim about the BYTES
    // of the source file, not about what running it does. There is no
    // behaviour to exercise for "this file contains a literal NUL byte" — the
    // property lives entirely in the encoding, which is exactly what made it
    // dangerous the first time (git degrading the diff to "Binary files
    // differ" is a property of the bytes, not of any code path).
    //
    // The frameworks dedup key was once written as `${regulation}\u0000${ref}`
    // with a LITERAL NUL byte in the source (offset ~4474). git classifies any
    // file containing a NUL as BINARY, so `git diff` degraded to "Binary files
    // differ": a whole rewrite of register()/_normaliseFrameworks shipped
    // without ever being line-reviewable, blame stopped resolving and every
    // merge conflict in the file became whole-file. The separator must stay a
    // printable character — see the comment on the key in registry.js.
    const bytes = fs.readFileSync(path.join(__dirname, 'registry.js'));
    assert.strictEqual(bytes.indexOf(0x00), -1,
        `registry.js holds a NUL byte at offset ${bytes.indexOf(0x00)} — git sees the whole file as binary`);
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
            assert.fail(`registry.js holds control byte 0x${b.toString(16).padStart(2, '0')} at offset ${i}`);
        }
    }
    assert.ok(Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes), 'registry.js must be valid UTF-8');
});

test('no regulation code can contain the frameworks dedup separator', () => {
    // The key is `${regulation}|${ref}`, which is injective only while no
    // regulation code contains "|" — otherwise ('A|B','C') and ('A','B|C')
    // would collapse into one tag. A new framework must keep that true.
    for (const code of frameworks.regulationCodes()) {
        assert.ok(!code.includes('|'), `regulation code "${code}" contains the frameworks dedup separator "|"`);
        assert.ok(!/[\u0000-\u001f]/.test(code), `regulation code "${code}" contains a control character`);
    }
});

test('frameworks[] dedups on (regulation, ref); refs differing only around the separator stay distinct', () => {
    const base = { severity: 'low', scope: 'global', verification: 'automated', evaluate: async () => ({ status: 'pass' }) };
    const probe = {
        ...base,
        id: 'GDPR-Art98-separator-probe',
        regulation: 'GDPR',
        article: '98',
        frameworks: [
            { regulation: 'NIS2', ref: 'Art. 21(2)' },
            { regulation: 'NIS2', ref: '  Art. 21(2)  ' }, // same tag after trim → dropped
            { regulation: 'NIS2', ref: '|Art. 21(2)' },    // differs only around the separator → kept
            { regulation: 'NIS2', ref: 'Art. 21(2)|' },    // idem
            { regulation: 'DORA', ref: 'Art. 21(2)' },     // same ref, other regulation → kept
        ],
    };
    registry.register(probe);
    try {
        assert.deepStrictEqual(
            probe.frameworks.map(f => `${f.regulation} ${f.ref}`),
            ['GDPR 98', 'NIS2 Art. 21(2)', 'NIS2 |Art. 21(2)', 'NIS2 Art. 21(2)|', 'DORA Art. 21(2)'],
            'only the trimmed duplicate collapses — the separator must not merge neighbouring refs',
        );
    } finally {
        registry._unregister(probe.id);
    }
});

test('in_force_since resolves per article: the AI Act Art. 50 check applies from 2026-08-02', () => {
    const art50 = registry.getAll().filter(c => c.regulation === 'AIA' && /^50/.test(c.article));
    assert.ok(art50.length, 'an AIA Art. 50 check must be registered');
    for (const c of art50) {
        assert.strictEqual(c.in_force_since, '2026-08-02', `${c.id}: Art. 50 applies from 2026-08-02, not the Act's entry into force`);
        assert.strictEqual(c.frameworks[0].in_force_since, '2026-08-02');
    }
    for (const c of registry.getPrimary('GDPR')) assert.strictEqual(c.in_force_since, '2018-05-25', c.id);
    for (const c of registry.getPrimary('ISO27001')) assert.strictEqual(c.in_force_since, null, `${c.id}: a standard has no in-force date`);
    for (const c of registry.getPrimary('NIS2')) assert.strictEqual(c.in_force_since, '2026-08-15', c.id);
});

test('getByFramework is home ∪ tagged; getPrimary is home only', () => {
    for (const code of frameworks.regulationCodes()) {
        const primary = registry.getPrimary(code);
        const all = registry.getByFramework(code);
        for (const c of primary) assert.ok(all.includes(c), `${c.id} must count for its own framework`);
        for (const c of all) assert.ok(c.frameworks.some(f => f.regulation === code), `${c.id} listed for ${code} without a tag`);
        assert.ok(all.length >= primary.length);
    }
    assert.deepStrictEqual(registry.getByRegulation('GDPR'), registry.getPrimary('GDPR'), 'getByRegulation keeps its old meaning (home checks)');
});

// ── i18n ─────────────────────────────────────────────────────────────────

test('every declared i18n key exists in the server defaults (or is pending in a keys file for the integrator)', () => {
    for (const c of registry.getAll()) {
        for (const prop of ['titleKey', 'descriptionKey', 'remediationKey']) {
            const key = c[prop];
            assert.ok(key, `${c.id}: missing ${prop}`);
            assert.ok(hasKey(key),
                `${c.id}: ${prop} "${key}" has no entry in server/i18n/defaults/en.js and no keys/*.json declares it — the card would render its raw id`);
        }
    }
});

test('the frameworks the loaded checks belong to have their catalogue copy keyed', () => {
    for (const dir of loadedDirs()) {
        const fw = frameworks.listBuiltin().find(f => f.checks_dir === dir);
        for (const key of [fw.name_key, fw.description_key, fw.affects_key]) {
            assert.ok(hasKey(key), `${fw.id}: "${key}" is in neither en.js nor a pending keys file`);
        }
        for (const p of fw.phases) assert.ok(hasKey(p.label_key), `${fw.id}: phase key "${p.label_key}" missing`);
    }
});

test('remediation links use path segments, not query strings', () => {
    // parseAdminPath() reads path segments only — a `?expand=` link silently
    // lands on Overview, which is how the Art-15/17/30/35 fix buttons broke.
    for (const c of registry.getAll()) {
        if (!c.remediationLink) continue;
        assert.ok(!c.remediationLink.includes('?'),
            `${c.id}: remediationLink "${c.remediationLink}" uses a query string the admin router ignores`);
    }
});
