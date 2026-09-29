'use strict';

/**
 * FROZEN_LEGACY (U7) — the server side of the URL contract.
 *
 * Every string pinned here has been written into a notifications.link row, an
 * email, a Nextcloud Talk card or a YouTrack reference. Those copies never
 * expire, so the shapes below may not drift — a red assertion here is not an
 * invitation to update the expected value. It means you are moving a route,
 * and a move happens in ONE commit across all of:
 *
 *   1. agent-hub/src/authedApp/appRoutes.js — new route + an alias that keeps
 *      the OLD path parsing (plus its freeze, appRoutes.test.js);
 *   2. mobile/src/features/notifications/route.ts — translateWebLink keeps
 *      translating the old shape;
 *   3. MOBILE_ALLOWED_PAGES + guards, if the page is phone-reachable;
 *   4. only then, optionally, the helper in appPaths.js.
 *
 * (Route moves are F2's job; U7 only freezes. See appPaths.js.)
 *
 * Static and DB-free: paths are a textual fact.
 *
 * Run: cd server && node --test --test-force-exit utils/appPaths.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const p = require('./appPaths');

const MOVE_HINT = 'FROZEN_LEGACY: this shape is already in mailboxes/tickets. '
    + 'Do not update this expectation — move the route in one commit across '
    + 'appRoutes.js (+ alias + its test), mobile route.ts, and the guards. '
    + 'See utils/appPaths.js.';

test('clientHost: the exact legacy idiom, defaults included', () => {
    const saved = { proto: process.env.CLIENT_PROTOCOL, host: process.env.CLIENT_PUBLIC_HOST };
    try {
        process.env.CLIENT_PROTOCOL = 'http';
        process.env.CLIENT_PUBLIC_HOST = 'localhost:5176';
        assert.equal(p.clientHost(), 'http://localhost:5176');
        delete process.env.CLIENT_PROTOCOL;
        delete process.env.CLIENT_PUBLIC_HOST;
        // The shipped fallback. 15+ call sites relied on exactly this pair of
        // defaults before they were centralised; they are behaviour.
        assert.equal(p.clientHost(), 'https://beeflow.nl');
    } finally {
        if (saved.proto === undefined) delete process.env.CLIENT_PROTOCOL;
        else process.env.CLIENT_PROTOCOL = saved.proto;
        if (saved.host === undefined) delete process.env.CLIENT_PUBLIC_HOST;
        else process.env.CLIENT_PUBLIC_HOST = saved.host;
    }
});

test('publicBaseUrl: org override → PUBLIC_SHARE_BASE_URL → PUBLIC_APP_URL → clientHost(), origin only', () => {
    const keys = ['PUBLIC_SHARE_BASE_URL', 'PUBLIC_APP_URL', 'CLIENT_PROTOCOL', 'CLIENT_PUBLIC_HOST'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    try {
        for (const k of keys) delete process.env[k];
        assert.equal(p.publicBaseUrl(), 'https://beeflow.nl');
        process.env.CLIENT_PROTOCOL = 'http';
        process.env.CLIENT_PUBLIC_HOST = 'localhost:5176';
        assert.equal(p.publicBaseUrl(), 'http://localhost:5176');
        process.env.PUBLIC_APP_URL = 'https://app.example.org/some/path/';
        assert.equal(p.publicBaseUrl(), 'https://app.example.org', 'path is dropped: an origin');
        process.env.PUBLIC_SHARE_BASE_URL = 'https://share.example.org';
        assert.equal(p.publicBaseUrl(), 'https://share.example.org', 'share base wins over app url');
        assert.equal(p.publicBaseUrl('https://klant.nl/'), 'https://klant.nl', 'a parsable override wins');
        assert.equal(p.publicBaseUrl('not a url'), 'https://share.example.org', 'an unusable override is skipped');
        assert.equal(p.publicBaseUrl('ftp://x.example'), 'https://share.example.org', 'only http(s) origins');
        assert.equal(p.publicDsrPath(), '/dsr');
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
});

test('FROZEN_LEGACY: every notification/email link shape, verbatim', () => {
    // One row per shape, with the writer that mints it. This is the same list
    // mobile/src/features/notifications/route.ts enumerates in its header —
    // the two must not drift apart.
    const frozen = [
        [p.appRootPath(), '/app'], // jobs/ncOnboardingReminder.js, welcome email before BFSF-279
        [p.approvalPath('apr_1'), '/app/studio/approvals/apr_1'], // approvalNotify/-Hooks/-Lifecycle, publicUrl
        [p.automationPath('a1'), '/app/studio/automations/a1'], // automation/evolution.js
        [p.automationRunPath('a1', 'r9'), '/app/studio/automations/a1?view=runs&run=r9'], // automationRunner/execution.js
        [p.automationRunStepPath('a1', 'r9', 's2'), '/app/studio/automations/a1?view=runs&run=r9&step=s2'], // execution.js, routes/automation/approvals.js
        [p.coworkTaskPath('t7'), '/app/cowork/t7'], // core/aiTaskRunner.js
        [p.supportThreadPath('th1'), '/app/settings/help_support?thread=th1'], // routes/support/threads.js
        [p.adminSupportInboxPath(), '/app/admin/support'], // outboundChatNotifier test card
        [p.adminSupportTicketPath('th1'), '/app/admin/support/th1'], // issueEgress (BFSF-441 ticket ref), supportIssueSync, outboundChatNotifier
        [p.adminSupportTabPath('th1'), '/app/admin?tab=support&thread=th1'], // routes/support/shared.js staff email
        [p.complianceSectionPath('dsr'), '/app/admin/compliance/dsr'], // complianceDeadlineNotifier, compliance/events
        [p.complianceIncidentPath('inc1'), '/app/admin/compliance/incidents/inc1'], // + the Art. 33 ack email
        [p.learningSettingsPath(), '/app/settings/learning'], // jobs/learningNudge.js, welcome email
        [p.adminSecurityUsersPath(), '/app/admin/security/users'], // auth/connectorJwt.js
        [p.adminSubscriptionsPath(), '/app/admin/subscriptions'], // Stripe admin email
        [p.webpagePath('wp1'), '/app/webpages/wp1'], // webpage builder/automation tool results
        [p.webpageEditorPath('wp1'), '/app/studio/webpages/wp1'], // side-panel AI context
        [p.accountLicenseSettingsPath(), '/app/settings/account/license'], // Stripe checkout return (BFSF-244)
        [p.orgLicenseSettingsPath(), '/app/settings/organisation/license'], // Stripe checkout return (BFSF-244)
        [p.settingsTabPath('license'), '/app/settings?tab=license'], // Stripe portal return
    ];
    const drifted = frozen.filter(([actual, expected]) => actual !== expected)
        .map(([actual, expected]) => `${expected} → ${actual}`);
    assert.deepEqual(drifted, [], `Frozen link shapes changed: ${drifted.join(', ')}. ${MOVE_HINT}`);
});

test('the two known-stale shapes stay stale until fixed deliberately', () => {
    // These are wrong today (neither is a real SPA route) and they still may
    // not drift silently: their current values are what ships in emails and
    // redirects, and "fix the path" is a behaviour change with its own test
    // update — not a side effect of a refactor.
    assert.equal(p.legacyBillingSettingsPath(), '/settings/billing', MOVE_HINT);
    // The three writers of /login, in full — auth/login/emailVerificationRoutes.js
    // (?verified=1, ?error=verify_*), auth/login/inviteRoutes.js (?signup=1,
    // ?error=invite_*) and auth/login/passwordResetRoutes.js (?reset=<token>,
    // the one that used to build its own string and so was not pinned here).
    // Note who is NOT on the list: auth/admin/invitationRoutes.js mails
    // /auth/redeem-invite/<token> on purpose, keeping the token out of the URL
    // bar, the Referer and proxy logs; it reaches /login only through that
    // endpoint's redirect to ?signup=1.
    assert.equal(p.legacyLoginPath('verified=1'), '/login?verified=1', MOVE_HINT);
    assert.equal(p.legacyLoginPath('error=verify_expired'), '/login?error=verify_expired', MOVE_HINT);
    assert.equal(p.legacyLoginPath('signup=1'), '/login?signup=1', MOVE_HINT);
    assert.equal(p.legacyLoginPath('error=invite_expired'), '/login?error=invite_expired', MOVE_HINT);
    assert.equal(p.legacyLoginPath('reset=tok3n'), '/login?reset=tok3n', MOVE_HINT);
});

test('interpolation is verbatim — the helpers do not encode or trim', () => {
    // The hand-built templates never URL-encoded, so the helpers must not
    // start to: byte-identical output was the whole point of the extraction.
    assert.equal(p.approvalPath('a b'), '/app/studio/approvals/a b');
    assert.equal(p.supportThreadPath(''), '/app/settings/help_support?thread=');
});
