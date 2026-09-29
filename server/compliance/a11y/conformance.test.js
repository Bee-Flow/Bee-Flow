/**
 * conformance.js — locating and shape-checking the CI artefact.
 *
 * Run: cd server && node --test --test-force-exit compliance/a11y/conformance.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConformance, validate, totals, SCHEMA_VERSION, SURFACE_IDS } = require('./conformance');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-conf-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name, content) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    return p;
}

const GOOD = {
    schema_version: SCHEMA_VERSION,
    build_sha: 'abcdef1234567',
    generated_at: '2026-09-10T10:00:00Z',
    axe_version: '4.10.0',
    surfaces: [
        { id: 'dsr', status: 'tested', violations: { critical: 0, serious: 0, moderate: 1, minor: 0 }, rules: [{ id: 'region', impact: 'moderate', nodes: 1 }] },
        { id: 'public_app', status: 'tested', violations: { critical: 0, serious: 2, moderate: 0, minor: 3 }, rules: [{ id: 'label', impact: 'serious', nodes: 2 }, { id: 'landmark-one-main', impact: 'minor', nodes: 3 }] },
        { id: 'public_form', status: 'skipped', skip_reason: 'no fixture' },
    ],
};

test('absent file → found:false with the last candidate path', () => {
    const r = loadConformance({ path: path.join(tmp, 'nope.json') });
    assert.equal(r.found, false);
    assert.equal(r.artefact, null);
    assert.deepEqual(r.problems, []);
    assert.match(r.path, /conformance\.json$/, 'falls through to the default location');
});

test('well-formed artefact → parsed, age computed from generated_at', () => {
    const p = write('good.json', GOOD);
    const r = loadConformance({ path: p, now: Date.parse('2026-09-14T10:00:00Z') });
    assert.equal(r.found, true);
    assert.deepEqual(r.problems, []);
    assert.equal(r.artefact.build_sha, 'abcdef1234567');
    assert.equal(Math.round(r.age_days), 4);
});

test('invalid JSON → found but unusable, with a problem named', () => {
    const p = write('bad.json', '{ not json');
    const r = loadConformance({ path: p });
    assert.equal(r.found, true);
    assert.equal(r.artefact, null);
    assert.match(r.problems[0], /invalid JSON/);
});

test('validate: every shape rule the check relies on', () => {
    assert.deepEqual(validate(GOOD), []);
    assert.deepEqual(validate(null), ['not an object']);
    assert.ok(validate({ ...GOOD, schema_version: 2 }).some(p => /schema_version/.test(p)));
    assert.ok(validate({ ...GOOD, build_sha: 'release-1' }).some(p => /build_sha/.test(p)));
    assert.ok(validate({ ...GOOD, generated_at: 'yesterday' }).some(p => /generated_at/.test(p)));
    assert.ok(validate({ ...GOOD, surfaces: [] }).some(p => /surfaces/.test(p)));
    assert.ok(validate({ ...GOOD, surfaces: [{ id: 'homepage', status: 'tested', violations: GOOD.surfaces[0].violations, rules: [] }] }).some(p => /id unknown/.test(p)));
    assert.ok(validate({ ...GOOD, surfaces: [{ id: 'dsr', status: 'tested', rules: [] }] }).some(p => /violations missing/.test(p)));
    assert.ok(validate({ ...GOOD, surfaces: [{ id: 'dsr', status: 'tested', violations: { critical: -1, serious: 0, moderate: 0, minor: 0 }, rules: [] }] }).some(p => /critical/.test(p)));
    assert.ok(validate({ ...GOOD, surfaces: [{ id: 'dsr', status: 'tested', violations: GOOD.surfaces[0].violations, rules: [{ id: 'x', impact: 'severe' }] }] }).some(p => /impact invalid/.test(p)));
    // a skipped surface needs no violations block
    assert.deepEqual(validate({ ...GOOD, surfaces: [{ id: 'dsr', status: 'skipped' }] }), []);
    // 'dev' is the local build stamp and is accepted
    assert.deepEqual(validate({ ...GOOD, build_sha: 'dev' }), []);
});

test('a shape problem makes the load unusable but still found', () => {
    const p = write('shape.json', { ...GOOD, surfaces: [] });
    const r = loadConformance({ path: p });
    assert.equal(r.found, true);
    assert.equal(r.artefact, null);
    assert.ok(r.problems.length > 0);
});

test('totals sums tested surfaces only', () => {
    assert.deepEqual(totals(GOOD), { critical: 0, serious: 2, moderate: 1, minor: 3 });
    assert.deepEqual(totals(null), { critical: 0, serious: 0, moderate: 0, minor: 0 });
});

test('the env override is honoured when no explicit path is given', () => {
    const p = write('env.json', GOOD);
    const before = process.env.A11Y_CONFORMANCE_PATH;
    process.env.A11Y_CONFORMANCE_PATH = p;
    try {
        const r = loadConformance({ now: Date.parse('2026-09-14T10:00:00Z') });
        assert.equal(r.found, true);
        assert.equal(r.path, p);
    } finally {
        if (before === undefined) delete process.env.A11Y_CONFORMANCE_PATH;
        else process.env.A11Y_CONFORMANCE_PATH = before;
    }
});

test('the schema file next to this module is valid JSON and names the same surfaces', () => {
    // conformance.js's own docblock says validate() is a JS reimplementation
    // of this JSON Schema, kept in sync by hand rather than by loading it —
    // so this is a data artefact with no code path in this repo to exercise
    // it through. JSON.parse + property access (not a text regex) against the
    // real exported constants is the strongest available check: it catches
    // the schema drifting from SURFACE_IDS/SCHEMA_VERSION instead of pinning
    // a second, hand-copied literal that could drift from both.
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'conformance.schema.json'), 'utf8'));
    assert.deepEqual(schema.$defs.surface.properties.id.enum, SURFACE_IDS);
    assert.equal(schema.properties.schema_version.const, SCHEMA_VERSION);
});
