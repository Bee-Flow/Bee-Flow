/**
 * The one Finding shape, and the proof that every producer already fits it.
 *
 * Three surfaces draw the "needs attention" list, and four validators feed
 * it. The shape only earns its name if (a) a malformed Finding is refused
 * loudly rather than rendered grey, and (b) each producer's records convert
 * without a per-producer adapter. Half of this file is the shape; the other
 * half runs the real validators — App Studio's control_inert, the automation
 * validator's draft/activate ladder, the Solution dependency graph — and
 * converts what they emit.
 *
 * Run: node --test --test-force-exit core/findings/finding.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    makeFinding, fromLegacy, isFinding, bySeverity, FindingShapeError,
    SEVERITIES, BLOCKED_AT, FINDING_KINDS,
} = require('./finding');

const good = () => ({
    code: 'component.control_inert',
    severity: 'warning',
    kind: 'app',
    targetRef: { kind: 'app', id: 'app_1', title: 'Offerteportaal', path: 'screens[0].sections[0].children[2]', nodeId: 'cmp_btn' },
    message: 'This button is wired to nothing — clicking it does nothing at all.',
    remediation: 'Set onClick to an action, or give it role "submit" inside a form.',
});

// ═══ makeFinding ═════════════════════════════════════════════════════════

test('a well-formed finding comes back with exactly the contract fields', () => {
    const f = makeFinding({ ...good(), somethingElse: 1 });
    assert.deepEqual(Object.keys(f).sort(), ['code', 'kind', 'message', 'remediation', 'severity', 'targetRef']);
    assert.deepEqual(f.targetRef, good().targetRef);
    assert.equal('somethingElse' in f, false, 'unknown keys are dropped — consumers rely on exactly this set');
});

test('optional fields are absent, not undefined, when not given', () => {
    const f = makeFinding({ code: 'x', severity: 'info', kind: 'kb', targetRef: { kind: 'kb', id: 'kb1' }, message: 'm' });
    assert.equal('blockedAt' in f, false);
    assert.equal('remediation' in f, false);
    assert.deepEqual(f.targetRef, { kind: 'kb', id: 'kb1' });
});

test('blockedAt is carried when valid and refused otherwise', () => {
    assert.equal(makeFinding({ ...good(), blockedAt: 'activate' }).blockedAt, 'activate');
    assert.equal(makeFinding({ ...good(), blockedAt: 'publish' }).blockedAt, 'publish');
    assert.throws(() => makeFinding({ ...good(), blockedAt: 'never' }), (e) => e instanceof FindingShapeError && e.field === 'blockedAt');
});

test('every wrong field is named in the error', () => {
    const cases = [
        [{ ...good(), code: '' }, 'code'],
        [{ ...good(), severity: 'fatal' }, 'severity'],
        [{ ...good(), kind: 'widget' }, 'kind'],
        [{ ...good(), message: '   ' }, 'message'],
        [{ ...good(), remediation: 42 }, 'remediation'],
        [{ ...good(), targetRef: null }, 'targetRef'],
        [{ ...good(), targetRef: { kind: 'nope', id: 'x' } }, 'targetRef.kind'],
        [{ ...good(), targetRef: { kind: 'app', id: { deep: true } } }, 'targetRef.id'],
        [{ ...good(), targetRef: { kind: 'app', id: 'a', nodeId: ['x'] } }, 'targetRef.nodeId'],
    ];
    for (const [input, field] of cases) {
        assert.throws(() => makeFinding(input), (e) => e instanceof FindingShapeError && e.field === field, `expected ${field} to be refused`);
    }
    assert.throws(() => makeFinding(null), FindingShapeError);
    assert.throws(() => makeFinding('finding'), FindingShapeError);
});

test('targetRef: the kind defaults to the finding kind, ids are strings, null id survives', () => {
    const f = makeFinding({ ...good(), targetRef: { id: 7, nodeId: 3 } });
    assert.deepEqual(f.targetRef, { kind: 'app', id: '7', nodeId: '3' });
    const g = makeFinding({ ...good(), targetRef: { kind: 'app', id: null, title: '', path: undefined } });
    assert.deepEqual(g.targetRef, { kind: 'app', id: null }, 'empty locators are dropped, a null id is kept');
});

test('the vocabularies are the ten Studio kinds and the three severities', () => {
    assert.deepEqual([...SEVERITIES], ['error', 'warning', 'info']);
    assert.deepEqual([...BLOCKED_AT], ['activate', 'publish']);
    assert.deepEqual([...FINDING_KINDS], ['automation', 'datatable', 'app', 'webpage', 'form', 'agent', 'skill', 'kb', 'meeting', 'solution']);
});

test('isFinding is a non-throwing makeFinding; bySeverity puts errors first', () => {
    assert.equal(isFinding(good()), true);
    assert.equal(isFinding({ ...good(), severity: 'loud' }), false);
    assert.equal(isFinding(undefined), false);
    const sorted = [
        { severity: 'info' }, { severity: 'error' }, { severity: 'warning' }, { severity: 'error' }, { severity: 'mystery' },
    ].sort(bySeverity).map((x) => x.severity);
    assert.deepEqual(sorted, ['error', 'error', 'warning', 'info', 'mystery']);
});

// ═══ fromLegacy ══════════════════════════════════════════════════════════

test('fromLegacy: hint → remediation, path/nodeId → targetRef, kind from the caller', () => {
    const f = fromLegacy('app', {
        code: 'binding.table_unset', severity: 'warning', path: 'screens[1].sections[0]', nodeId: 'sec_2',
        message: 'This list has no table.', hint: 'Pick a table.',
    }, { id: 'app_9', title: 'Offerteportaal' });
    assert.deepEqual(f, {
        code: 'binding.table_unset',
        severity: 'warning',
        kind: 'app',
        targetRef: { kind: 'app', id: 'app_9', title: 'Offerteportaal', path: 'screens[1].sections[0]', nodeId: 'sec_2' },
        message: 'This list has no table.',
        remediation: 'Pick a table.',
    });
});

test('fromLegacy: the draft ladder\'s blockedAt rides along, and a record with its own targetRef wins', () => {
    const f = fromLegacy('automation', {
        code: 'trigger.schedule_missing', severity: 'warning', blockedAt: 'activate', path: 'trigger.schedule.cron',
        message: 'Schedule trigger has no schedule — it can never fire.', hint: 'Pick a time.',
        kind: 'automation',
        targetRef: { kind: 'automation', id: 'auto_1', stepId: 'trg' },
    }, { id: 'ignored', title: 'Kredietcheck' });
    assert.equal(f.blockedAt, 'activate');
    assert.deepEqual(f.targetRef, { kind: 'automation', id: 'auto_1', title: 'Kredietcheck', path: 'trigger.schedule.cron', stepId: 'trg' });
});

test('fromLegacy: no hint means no remediation; a record without a message is refused', () => {
    const f = fromLegacy('kb', { code: 'kb.empty', severity: 'info', message: 'Kennisbank test is leeg.' }, { id: 'kb_1' });
    assert.equal('remediation' in f, false);
    assert.deepEqual(f.targetRef, { kind: 'kb', id: 'kb_1' });
    assert.throws(() => fromLegacy('kb', { code: 'kb.empty', severity: 'info' }), (e) => e.field === 'message');
    assert.throws(() => fromLegacy('kb', null), FindingShapeError);
});

// ═══ The producers already fit ═══════════════════════════════════════════

// Each producer's half runs in the file its module owns: finding.apps.test.js (App Studio's
// control_inert), finding.automation.test.js (the automation validator's draft/activate ladder)
// and finding.projects.test.js (the Solution dependency graph).
