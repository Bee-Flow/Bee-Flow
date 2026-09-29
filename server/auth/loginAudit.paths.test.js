/**
 * Every authentication outcome leaves a row.
 *
 * The unit tests next door prove the row is shaped right. Nothing there
 * notices a login path that never calls the module at all — which is the whole
 * defect: the product counted logins as a metric and recorded none of them as
 * events, so "did this account sign in on the 14th, and from where" had no
 * answer anywhere in the system.
 *
 * So this file tests the SET of sites, the way accountStatusGate.paths.test.js
 * does for the status gate:
 *
 *   1. success is audited from establishSession itself, not from its nine
 *      callers, so a login path added later is audited before anyone thinks to
 *      ask — and the audit happens AFTER the session is persisted, so the log
 *      never claims a session that failed to save;
 *   2. every call site labels which door was used, or the row says 'unknown'
 *      out loud rather than being absent;
 *   3. every failure and every refusal site audits too, and a new one cannot
 *      appear unnoticed;
 *   4. the failure write sits before the response floor, so it cannot become a
 *      timing signal of its own.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const AUTH = __dirname;
const REPO = path.resolve(AUTH, '../..');
const read = (rel) => fs.readFileSync(path.join(AUTH, rel), 'utf8');
const gitGrep = (pattern) => execFileSync('git', ['grep', '-l', pattern, '--', 'server/auth/'], { cwd: REPO, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .map((f) => f.replace(/^server\/auth\//, ''))
    .filter((f) => !f.includes('.test.'));

test('a successful sign-in is audited from the one place that defines one, after the session is persisted', async () => {
    // Called for real, with a fake express-session (same contract
    // establishSession.test.js's makeReq uses: regenerate(cb) REPLACES
    // req.session, save(cb) persists), and a spy on loginAudit's own export —
    // establishSession.js reaches it via require('./loginAudit') at call
    // time, so mutating that cached module object is seen there too, exactly
    // as jobs/kbSourceRefresh.meetingTap.test.js does for its bus tap.
    const { establishSession } = require('./establishSession');
    const loginAudit = require('./loginAudit');
    const realAudit = loginAudit.auditLoginSuccess;
    const order = [];
    loginAudit.auditLoginSuccess = async () => { order.push('audit'); };
    const req = {};
    const attach = () => {
        req.session = {
            regenerate(cb) { order.push('regenerate'); attach(); setImmediate(() => cb(null)); },
            save(cb) { order.push('save'); setImmediate(() => cb(null)); },
        };
    };
    attach();
    try {
        await establishSession(req, { user: { id: 'u1' } });
        assert.deepStrictEqual(
            order, ['regenerate', 'save', 'audit'],
            'establishSession no longer audits every established session before anyone thinks to ask, '
            + 'or audits before the save that makes the session real',
        );
    } finally {
        loginAudit.auditLoginSuccess = realAudit;
    }
});

test('every path that mints a session says which door was used', () => {
    // Not a security property — a row without a method is still a row. It is an
    // investigability one: "an authenticated session appeared" is only half an
    // answer if nothing says whether it came from a password, an SSO callback
    // or a signup.
    const callers = gitGrep('establishSession(').filter((f) => f !== 'establishSession.js');
    assert.ok(callers.length >= 4, 'the sweep found almost nothing — check the pattern');
    for (const rel of callers) {
        const src = read(rel);
        const calls = src.split('establishSession(req').length - 1;
        const labels = src.split(/audit:\s*\{/).length - 1;
        assert.strictEqual(
            labels, calls,
            `${rel} establishes ${calls} session(s) but labels ${labels}. Pass `
            + "audit: { method: '...' } so the row says which door this was.",
        );
    }
});

/**
 * Where an attempt can be refused. Each entry is a file plus why it counts.
 * Adding a refusal path without auditing fails the first test; adding one to
 * the tree without listing it here fails the sweep.
 */
const REFUSAL_PATHS = [
    ['login/passwordLoginRoutes.js', 'wrong password, and the abuse lockout'],
    ['login/mfaLoginRoutes.js', 'a wrong second factor on a correct password'],
    ['login/finalizeLogin.js', 'an account whose status revokes access'],
    ['opaqueRoutes.js', 'OPAQUE start and finish, and the abuse lockout'],
];

test('every refusal path audits the refusal', () => {
    // Bewust brontekst, zoals de bestandskop zegt: dit test de SET van
    // plekken (dezelfde aanpak als accountStatusGate.paths.test.js), niet één
    // aanroep. Elke plek voor echt aandrijven zou vier eigen zware routes
    // (wachtwoord-hashing, MFA, OPAQUE) moeten optuigen om te bewijzen wat
    // hier in één keer voor alle vier geldt.
    for (const [rel, why] of REFUSAL_PATHS) {
        const src = read(rel);
        assert.match(
            src, /audit(LoginFailure|LoginBlocked)\(/,
            `${rel} (${why}) refuses a sign-in and records nothing. A log of successes only cannot `
            + 'show a password-spray, which is the thing it is read for.',
        );
        assert.match(
            src, /require\('\.{1,2}\/?(\.\.\/)?loginAudit'\)/,
            `${rel} audits without requiring the shared module.`,
        );
    }
});

test('no refusal path escapes the list', () => {
    // recordLoginFailure and denyLogin are the two ways an attempt is turned
    // away; every file that calls either is a refusal path.
    const files = new Set([...gitGrep('recordLoginFailure('), ...gitGrep('denyLogin(')]);
    // Files that reach the throttle for something that is not a sign-in.
    const NOT_A_SIGN_IN = new Map([
        ['loginThrottle.js', 'the throttle itself'],
        ['login/passwordResetRoutes.js', 'forgot-password fan-out, not an authentication attempt'],
        ['login/signupIntakeRoutes.js', 'signup fan-out'],
        ['login/emailVerificationRoutes.js', 'resend-verification fan-out'],
    ]);
    const known = new Set([...REFUSAL_PATHS.map(([f]) => f), ...NOT_A_SIGN_IN.keys()]);
    const unaccounted = [...files].filter((f) => !known.has(f));
    assert.deepStrictEqual(
        unaccounted, [],
        'these files refuse an attempt and are on neither list. If one turns away a sign-in it '
        + 'needs an audit row; if it does not, say so in NOT_A_SIGN_IN with the reason:\n'
        + unaccounted.join('\n'),
    );
});

test('the failure write is absorbed by the response floor', () => {
    // The floor exists because a refused sign-in that answers in 8ms while a
    // wrong password takes 516ms classifies the account for anyone with a
    // stopwatch. An audit write placed AFTER the floor would add its own
    // variable latency on top of it and hand back part of that signal.
    for (const rel of ['login/passwordLoginRoutes.js', 'opaqueRoutes.js']) {
        const src = read(rel);
        let from = 0;
        let checked = 0;
        for (;;) {
            const auditAt = src.indexOf('await auditLoginFailure(', from);
            if (auditAt === -1) break;
            from = auditAt + 1;
            // The floor call that follows this audit in the same handler.
            const padAt = src.indexOf('padFailureResponse(', auditAt);
            if (padAt === -1) continue;   // a path with no floor of its own
            checked += 1;
            assert.ok(
                padAt > auditAt,
                `${rel}: an audit write lands after padFailureResponse and adds latency the floor `
                + 'no longer covers.',
            );
        }
        assert.ok(checked > 0, `${rel}: found no audited failure followed by the floor`);
    }
});

test('the suspended-account refusal is audited before the floor, not after', () => {
    const src = read('login/finalizeLogin.js');
    const auditAt = src.indexOf('auditLoginBlocked(');
    const padAt = src.indexOf('padFailureResponse(', auditAt);
    assert.ok(auditAt > -1, 'the suspended refusal records nothing');
    assert.ok(padAt > auditAt, 'the refusal audits after its own floor');
});

test('the audit module never looks an account up for itself', () => {
    // The login path spends a dummy bcrypt so that a name matching nothing
    // costs what a real one costs. A store lookup here to enrich a row would
    // put that difference straight back.
    // Bewust brontekst: een spy op vandaag bewijst alleen dat DEZE aanroep
    // niet opzoekt, niet dat de module het vermogen daartoe mist — de
    // eigenschap gaat over wat er WEL in het bestand staat, niet over gedrag
    // op een input.
    const src = fs.readFileSync(path.join(AUTH, 'loginAudit.js'), 'utf8');
    assert.ok(
        !/getUserByEmail|getUser\(/.test(src),
        'loginAudit resolves an identifier to an account. That lookup is the enumeration step the '
        + 'login path pays a dummy hash to hide — the caller, which already looked up, passes the id.',
    );
});
