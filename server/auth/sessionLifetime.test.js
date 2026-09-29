/**
 * The failure that matters here is one-directional.
 *
 * A misconfigured session lifetime that comes out SHORTER than intended is an
 * inconvenience — people sign in again. One that comes out LONGER, or never
 * expires, is the finding: an organisation believes its policy is enforced and
 * it is not. So every unknown input below has to narrow to the default, and
 * none of them may widen.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sessionMaxAgeMs, sessionRolling, DEFAULT_DAYS, MAX_DAYS } = require('./sessionLifetime');

const DAY = 24 * 60 * 60 * 1000;
const quiet = () => {};

test('no setting means the documented default, unchanged', () => {
    assert.strictEqual(sessionMaxAgeMs({}, quiet), DEFAULT_DAYS * DAY);
    assert.strictEqual(sessionMaxAgeMs({ SESSION_MAX_AGE_DAYS: '' }, quiet), DEFAULT_DAYS * DAY);
});

test('an organisation can set its own policy', () => {
    assert.strictEqual(sessionMaxAgeMs({ SESSION_MAX_AGE_DAYS: '1' }, quiet), DAY);
    assert.strictEqual(sessionMaxAgeMs({ SESSION_MAX_AGE_DAYS: '14' }, quiet), 14 * DAY);
    assert.strictEqual(sessionMaxAgeMs({ SESSION_MAX_AGE_DAYS: '0.5' }, quiet), 0.5 * DAY, 'half a day is a legitimate policy');
});

test('a mistyped value falls back to the default, never to forever', () => {
    // The whole point. '30 days' with a unit, an empty string from a template
    // that did not substitute, a negative from a copy-paste — each of these must
    // land on a KNOWN lifetime, not on zero (expires instantly) and not on NaN,
    // which express-session treats as a session cookie with no expiry at all.
    for (const bad of ['thirty', '30 days', '-1', '0', 'null', '${SESSION_MAX_AGE_DAYS}', 'NaN', 'Infinity']) {
        const got = sessionMaxAgeMs({ SESSION_MAX_AGE_DAYS: bad }, quiet);
        assert.strictEqual(got, DEFAULT_DAYS * DAY, `${JSON.stringify(bad)} did not fall back to the default`);
        assert.ok(Number.isFinite(got) && got > 0, `${JSON.stringify(bad)} produced a lifetime express-session cannot use`);
    }
});

test('a mistyped value is reported, not swallowed', () => {
    // A silent fallback is how an operator ends up certain their policy is live.
    const said = [];
    sessionMaxAgeMs({ SESSION_MAX_AGE_DAYS: 'thirty' }, (m) => said.push(m));
    assert.strictEqual(said.length, 1);
    assert.match(said[0], /SESSION_MAX_AGE_DAYS/);
    assert.match(said[0], /default/);

    // …but an absent setting is not a mistake and must stay quiet, or the
    // warning becomes noise every installation learns to ignore.
    const quietSaid = [];
    sessionMaxAgeMs({}, (m) => quietSaid.push(m));
    assert.deepStrictEqual(quietSaid, []);
});

test('an absurd value is capped rather than honoured', () => {
    const said = [];
    assert.strictEqual(sessionMaxAgeMs({ SESSION_MAX_AGE_DAYS: '99999' }, (m) => said.push(m)), MAX_DAYS * DAY);
    assert.strictEqual(said.length, 1, 'the cap applied without saying so');
});

test('rolling is off unless it is asked for exactly', () => {
    assert.strictEqual(sessionRolling({}, quiet), false, 'the default must match the behaviour that has always been in place');
    assert.strictEqual(sessionRolling({ SESSION_ROLLING: 'true' }, quiet), true);
    assert.strictEqual(sessionRolling({ SESSION_ROLLING: 'false' }, quiet), false);
});

test('a near-miss spelling is refused loudly rather than guessed', () => {
    // '1' and 'yes' are configs somebody believes is ON. Silently reading them
    // as off leaves them convinced of an inactivity timeout they do not have —
    // so the value is refused AND said out loud.
    for (const near of ['1', 'yes', 'TRUE', 'True', 'on']) {
        const said = [];
        assert.strictEqual(sessionRolling({ SESSION_ROLLING: near }, (m) => said.push(m)), false);
        assert.strictEqual(said.length, 1, `${JSON.stringify(near)} was read as false without saying so`);
    }
});

test('index.js uses the helpers rather than a second copy of the rule', () => {
    // The value was a bare literal in index.js for the life of the project, and
    // a second copy is how the tested rule and the shipped rule drift apart.
    // Bewust brontekst: index.js is de hele app-bootstrap (DB, alle routes,
    // middleware) — vereisen om dit ene bedradingsdetail waar te nemen zou
    // een lichte eenheidstest omzetten in een boot van het hele proces.
    const src = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
    assert.match(src, /require\('\.\/auth\/sessionLifetime'\)/);
    assert.match(src, /maxAge:\s*sessionMaxAgeMs\(\)/);
    assert.match(src, /rolling:\s*sessionRolling\(\)/);
    assert.ok(
        !/maxAge:\s*\d+\s*\*\s*24\s*\*\s*60/.test(src),
        'a hardcoded session maxAge is back in index.js — the configurable one is then decorative',
    );
});
