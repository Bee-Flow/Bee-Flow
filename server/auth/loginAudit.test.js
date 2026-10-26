/**
 * What this pins down is mostly what the audit row must NOT contain. The
 * failure row is the one an org admin reads and support exports, and the two
 * ways it goes wrong — a password typed into the username field, and the
 * existence of an account leaking to whoever can read the table — are both
 * silent unless a test says otherwise.
 */

const test = require('node:test');
const assert = require('node:assert');

// The real userStore.logAccessAudit over a recording pool (testUtils/accessAuditRows.js).
const { useAccessAuditRows } = require('../testUtils/accessAuditRows');
const auditRows = useAccessAuditRows();
const rows = auditRows.rows;

const loginAudit = require('./loginAudit');

const reqWith = (over = {}) => ({
    headers: { 'user-agent': 'Mozilla/5.0 probe', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    ip: '10.0.0.1',
    ...over,
});

test.beforeEach(auditRows.reset);

test('a failed login never stores what was typed', async () => {
    // The realistic worst case: the password went into the username field.
    const secret = 'hunter2-this-is-actually-my-password';
    await loginAudit.auditLoginFailure(reqWith(), {
        userId: null, identifier: secret, method: 'password', reason: 'invalid_credentials',
    });

    assert.strictEqual(rows.length, 1);
    const serialized = JSON.stringify(rows[0]);
    assert.ok(!serialized.includes(secret), 'the submitted identifier reached the audit row');
    assert.ok(!serialized.includes('hunter2'), 'part of the submitted identifier reached the audit row');
});

test('the fingerprint correlates repeats without naming anyone', async () => {
    const a = loginAudit.identifierFingerprint('Tom@Beeflow.nl');
    const b = loginAudit.identifierFingerprint('  tom@beeflow.nl  ');
    const c = loginAudit.identifierFingerprint('someone.else@beeflow.nl');
    assert.strictEqual(a, b, 'case and padding must not split one identifier into two');
    assert.notStrictEqual(a, c);
    assert.ok(!a.includes('beeflow'), 'the fingerprint carries the identifier');
    assert.match(a, /^v1(-ephemeral)?:[0-9a-f]{32}$/);
    // Nothing submitted is not the same event as an empty string submitted.
    assert.strictEqual(loginAudit.identifierFingerprint(''), null);
    assert.strictEqual(loginAudit.identifierFingerprint(null), null);
});

test('the fingerprint is keyed, not a bare hash of the address', async () => {
    const crypto = require('node:crypto');
    const bare = crypto.createHash('sha256').update('tom@beeflow.nl').digest('hex').slice(0, 32);
    const fp = loginAudit.identifierFingerprint('tom@beeflow.nl');
    assert.ok(!fp.endsWith(bare), 'an unkeyed digest is reversible from a wordlist of email addresses');
});

test('a failure on a real account is told apart from one on a name that matches nothing', async () => {
    await loginAudit.auditLoginFailure(reqWith(), { userId: 'usr_42', identifier: 'tom', method: 'password' });
    await loginAudit.auditLoginFailure(reqWith(), { userId: null, identifier: 'tom', method: 'password' });

    const [known, unknown] = rows;
    assert.strictEqual(known.targetType, 'user');
    assert.strictEqual(known.targetId, 'usr_42');
    assert.strictEqual(known.newValues.knownAccount, true);

    // A different target_type, so "show me everything about account X" cannot
    // sweep in attempts that merely resembled its name.
    assert.strictEqual(unknown.targetType, loginAudit.UNKNOWN_TARGET_TYPE);
    assert.notStrictEqual(unknown.targetType, 'user');
    assert.strictEqual(unknown.newValues.knownAccount, false);
    assert.strictEqual(unknown.changedBy, 'anonymous');
});

test('the row carries the address and method an investigation needs', async () => {
    await loginAudit.auditLoginSuccess(reqWith(), {
        user: { id: 'usr_7', organizationId: 'org_1' }, method: 'oauth:google',
    });
    const row = rows[0];
    assert.strictEqual(row.action, 'login_succeeded');
    assert.strictEqual(row.targetId, 'usr_7');
    assert.strictEqual(row.organizationId, 'org_1');
    assert.strictEqual(row.newValues.method, 'oauth:google');
    // The leftmost X-Forwarded-For entry — the visitor at the edge, not the
    // ingress pod that req.ip resolves to behind the cluster.
    assert.strictEqual(row.newValues.ip, '203.0.113.9');
    assert.strictEqual(row.newValues.userAgent, 'Mozilla/5.0 probe');
    assert.strictEqual(row.oldValues, null, 'an authentication event has no prior state');
});

test('an unbounded user-agent cannot inflate the row', async () => {
    await loginAudit.auditLoginSuccess(reqWith({ headers: { 'user-agent': 'A'.repeat(50_000) } }), {
        user: { id: 'usr_7' }, method: 'password',
    });
    assert.ok(rows[0].newValues.userAgent.length <= 260, 'the UA header is attacker-controlled and unbounded');
});

test('a broken store never breaks an authentication', async () => {
    auditRows.failOn(true);
    // No rejection: a gap in a log beats an outage of the login.
    await loginAudit.auditLoginSuccess(reqWith(), { user: { id: 'usr_7' }, method: 'password' });
    await loginAudit.auditLoginFailure(reqWith(), { userId: null, identifier: 'x' });
    await loginAudit.auditLoginBlocked(reqWith(), { userId: 'usr_7', reason: 'throttled' });
    assert.deepStrictEqual(rows, []);
});

test('a request with no headers at all still produces a row', async () => {
    // Not hypothetical: the OAuth callbacks re-enter through a redirect and the
    // legacy Nextcloud path runs detached from the original request.
    await loginAudit.auditLoginSuccess({}, { user: { id: 'usr_7' }, method: 'password' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].newValues.userAgent, null);
});

test('a call site that forgets to say which door was used still leaves a row', async () => {
    await loginAudit.auditLoginSuccess(reqWith(), { user: { id: 'usr_7' } });
    assert.strictEqual(rows.length, 1, 'an unlabelled login path must not be a silent one');
    assert.strictEqual(rows[0].newValues.method, 'unknown');
});

test('the action vocabulary is closed', () => {
    assert.deepStrictEqual(
        Object.values(loginAudit.LOGIN_ACTIONS).sort(),
        ['login_blocked', 'login_failed', 'login_succeeded'],
    );
});
