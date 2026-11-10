'use strict';
/**
 * The rules every Teams check follows: the param allow-list, skipped
 * prerequisites, the overall verdict and the probe timeout.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/checks.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const checks = require('./checks.mts');

test('sanitizeParams keeps allow-listed keys only, caps strings and arrays', () => {
    const out = checks.sanitizeParams({
        permission: 'Calendars.ReadWrite',
        count: 3,
        allowRecording: false,
        missing: Array.from({ length: 80 }, (_, i) => `perm${i}`),
        error: 'x'.repeat(2000),
        subject: 'Fixture subject 7',
        accessToken: 'fixture-access-token',
        body: { raw: true },
        httpStatus: Number.NaN,
        uris: ['https://a.test/cb', 7, null],
    }, 'user');
    assert.deepEqual(Object.keys(out).sort(), ['allowRecording', 'count', 'error', 'missing', 'permission', 'uris']);
    assert.equal(out.missing.length, 50);
    assert.equal(out.error.length, 512);
    assert.deepEqual(out.uris, ['https://a.test/cb']);
    assert.equal(checks.sanitizeParams(null, 'user') && Object.keys(checks.sanitizeParams(null, 'user')).length, 0);
});

test('tenantId and clientId only travel in admin reports', () => {
    const params = { tenantId: '11111111-2222-3333-4444-555555555555', clientId: 'abc', tenantSource: 'configured' };
    assert.deepEqual(checks.sanitizeParams(params, 'user'), { tenantSource: 'configured' });
    for (const level of ['platform', 'org', 'org_app']) {
        assert.deepEqual(checks.sanitizeParams(params, level), params, level);
    }
});

test('toCheck builds the full key of a remediation and sanitises the params', () => {
    const c = checks.toCheck({ id: 'a.scope_calendar', option: 'A', dependsOn: ['a.connection'] },
        { status: 'fail', code: 'scope_missing', params: { permission: 'Calendars.ReadWrite', token: 'x' }, fix: 'reconnect_to_grant', fixer: 'user' }, 'user');
    assert.deepEqual(c, {
        id: 'a.scope_calendar', option: 'A', status: 'fail', code: 'scope_missing', params: { permission: 'Calendars.ReadWrite' },
        remediation: 'teams_setup.fix.reconnect_to_grant', fixer: 'user', dependsOn: ['a.connection'],
    });
    assert.equal(checks.fixKey('teams_setup.fix.try_again_later'), 'teams_setup.fix.try_again_later');
    assert.equal(checks.fixKey(null), null);
});

test('a skipped check names the first prerequisite that did not pass', () => {
    const done = new Map([
        ['a', { status: 'pass' }], ['b', { status: 'fail' }], ['c', { status: 'unknown' }],
    ]);
    assert.equal(checks.firstNonPass(done, ['a', 'b', 'c']), 'b');
    assert.equal(checks.firstNonPass(done, ['a']), null);
    assert.equal(checks.firstNonPass(done, ['missing']), 'missing');
    assert.equal(checks.firstNonPass(done, ['a', 'c'], { c: ['unknown'] }), null, 'unknown may count as pass where the catalogue says so');
    assert.deepEqual(checks.skippedCheck({ id: 'x', option: 'A', dependsOn: ['a', 'b'] }, 'b'), {
        id: 'x', option: 'A', status: 'skipped', code: 'prerequisite_failed', params: { prerequisite: 'b' }, remediation: null, fixer: null, dependsOn: ['a', 'b'],
    });
});

test('overall: fail beats warn and unknown, skipped is ignored', () => {
    const of = (...statuses) => checks.overallOf(statuses.map((status) => ({ status })));
    assert.equal(of('pass', 'skipped'), 'pass');
    assert.equal(of('pass', 'unknown'), 'warn');
    assert.equal(of('warn', 'pass'), 'warn');
    assert.equal(of('warn', 'fail', 'unknown'), 'fail');
    assert.equal(of(), 'pass');
    const report = checks.buildReport('user', [], new Date('2026-11-10T08:00:00Z'));
    assert.deepEqual(report, { level: 'user', ranAt: '2026-11-10T08:00:00.000Z', overall: 'pass', checks: [] });
});

test('raceProbe answers, reports a failure, and times out without throwing', async () => {
    assert.deepEqual(await checks.raceProbe(async () => 5, 1000), { ok: true, value: 5 });
    const failed = await checks.raceProbe(async () => { throw new Error('boom'); }, 1000);
    assert.equal(failed.ok, false);
    assert.equal(failed.timedOut, false);
    assert.equal(failed.error.message, 'boom');
    const slow = await checks.raceProbe(() => new Promise((r) => setTimeout(() => r('late'), 200)), 10);
    assert.deepEqual(slow, { ok: false, timedOut: true });
    assert.deepEqual(await checks.raceProbe(async () => 'no timer', 0), { ok: true, value: 'no timer' });
    assert.deepEqual(checks.PROBE_TIMEOUT, { status: 'unknown', code: 'probe_timeout', fix: 'try_again_later', fixer: 'user' });
});
