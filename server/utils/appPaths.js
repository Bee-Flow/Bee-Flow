// @typecheck
'use strict';

/**
 * appPaths — every SPA address the server mints for an email, bell
 * notification, chat card, external ticket, tool result or redirect, in ONE
 * place.
 *
 * FROZEN_LEGACY (U7): these paths are a published contract, not an
 * implementation detail. Once a path has gone out in a notifications.link row,
 * an email, a Nextcloud Talk card or a YouTrack reference, it lives in inboxes
 * and ticket systems indefinitely — there is no retention window and no "one
 * release of backward compat". Three parties parse these exact strings:
 *
 *   - agent-hub/src/authedApp/appRoutes.js   (pageFromPath + legacy aliases;
 *     frozen by agent-hub/src/authedApp/appRoutes.test.js)
 *   - mobile/src/features/notifications/route.ts  (translateWebLink — the
 *     native app translates each shape to its own screen)
 *   - every mail archive and external tracker a link was ever delivered to
 *
 * Moving a screen therefore never starts with editing a string here. It means,
 * in the SAME commit: new route client-side, the old path still parsing
 * (appRoutes.js alias + route.ts translation), MOBILE_ALLOWED_PAGES + guards
 * updated — and only then, optionally, pointing the helper at the new
 * canonical form. The colocated appPaths.test.js pins every shape as the
 * tripwire. (Route moves themselves are F2's job; U7 only freezes.)
 *
 * Byte-for-byte extraction of the strings the call sites used to build by
 * hand — deliberately behaviour-neutral. Query params that are pure UI state
 * (`?checkout=`, `?support=`) stay at the call site; params the mobile
 * translation table interprets (`?view=runs&run=`, `?thread=`) are part of
 * the frozen shape and live here.
 */

// ── Host ─────────────────────────────────────────────────────────────────

/**
 * The SPA's public origin — the host every email/notification link hangs off.
 * This exact idiom used to be copy-pasted at 15+ call sites; the defaults are
 * part of its observed behaviour and must not drift per caller.
 *
 * (Not to be confused with automation/publicUrl.js's resolvePublicBaseUrl(),
 * which is the SERVER's origin and may fall back to the request host.)
 *
 * @returns {string} e.g. "https://beeflow.nl" — no trailing slash
 */
function clientHost() {
    return `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
}

// ── Frozen app paths (relative — prefix with clientHost() / an origin) ───

/** The app root. Written by jobs/ncOnboardingReminder.js (and by the welcome email before BFSF-279). */
function appRootPath() {
    return '/app';
}

/** One approval — approvalNotify/approvalHooks/approvalLifecycle/publicUrl. */
function approvalPath(approvalId) {
    return `/app/studio/approvals/${approvalId}`;
}

/** An automation's editor — automation/evolution.js notifications. */
function automationPath(automationId) {
    return `/app/studio/automations/${automationId}`;
}

/**
 * One run in an automation's run history. `?view=runs&run=` is how the web
 * app opens the Executions pane AND how the phone recognises a run link
 * (route.ts sends it to its own runs screen) — the query is contract, not
 * decoration. Written by core/automationRunner/execution.js.
 */
function automationRunPath(automationId, runId) {
    return `${automationPath(automationId)}?view=runs&run=${runId}`;
}

/** A run opened on one step — execution.js and routes/automation/approvals.js. */
function automationRunStepPath(automationId, runId, stepId) {
    return `${automationRunPath(automationId, runId)}&step=${stepId}`;
}

/** A Cowork task's master-detail page — core/aiTaskRunner.js. */
function coworkTaskPath(taskId) {
    return `/app/cowork/${taskId}`;
}

/**
 * A customer's own support thread. The `?thread=` param is interpreted by the
 * web settings page; the phone deliberately drops it and opens its own thread
 * list (route.ts). Written by routes/support/threads.js.
 */
function supportThreadPath(threadId) {
    return `/app/settings/help_support?thread=${threadId}`;
}

/** The staff support inbox — services/outboundChatNotifier.js test card. */
function adminSupportInboxPath() {
    return '/app/admin/support';
}

/**
 * One ticket, staff view. This shape is EXTERNALLY visible: it is the
 * BFSF-441 ticket reference sent to YouTrack/Google Chat (support/issueEgress,
 * outboundChatNotifier, supportIssueSync), so its stability is part of the
 * privacy design, not just UX.
 */
function adminSupportTicketPath(threadId) {
    return `/app/admin/support/${threadId}`;
}

/** Staff email deep-link into the admin support tab — routes/support/shared.js. */
function adminSupportTabPath(threadId) {
    return `/app/admin?tab=support&thread=${threadId}`;
}

/**
 * The public origin of this installation — the base every public deep link
 * (DSR form, verify links, security.txt policy URL) is built on. Same env
 * resolution as the share-URL builder (`services/webpageSnapshot.js`) and the
 * own-host detector in `core/webpages/webpageBindings.js` (`ownHosts`, not
 * exported): `PUBLIC_SHARE_BASE_URL`, then `PUBLIC_APP_URL`, then the
 * CLIENT_PROTOCOL/CLIENT_PUBLIC_HOST pair `clientHost()` already resolves.
 * Returns an origin without a trailing slash; `override` (an org's
 * `public_base_url` setting) wins when it parses.
 */
function publicBaseUrl(override = null) {
    const candidates = [override, process.env.PUBLIC_SHARE_BASE_URL, process.env.PUBLIC_APP_URL];
    for (const raw of candidates) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        try {
            const u = new URL(raw.trim());
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
            return u.origin;
        } catch { /* unusable → next candidate */ }
    }
    return clientHost();
}

/**
 * A compliance admin section ('overview', 'gdpr', 'aia', 'iso', 'frameworks',
 * 'nis2', 'cra', 'data_act', 'pld', 'eaa', 'dora', 'machinery', 'custom',
 * 'dsr', 'incidents', 'vulnerabilities', 'ropa', 'dpia', 'risks', 'soa',
 * 'policies', 'audits', 'training', 'access_log', 'portability', 'calendar',
 * 'ai_act', 'settings', 'connectors'; legacy 'iso_controls', 'iso_training'
 * etc. stay aliases on the client) — jobs/complianceDeadlineNotifier.js,
 * compliance/events.js, compliance/attention.js, compliance/deadlines.js.
 */
function complianceSectionPath(section) {
    return `/app/admin/compliance/${section}`;
}

/** The public data-subject-request form of this installation. */
function publicDsrPath() {
    return '/dsr';
}

/** One incident — deadline notifier, breach events, and the Art. 33 ack email. */
function complianceIncidentPath(incidentId) {
    return `/app/admin/compliance/incidents/${incidentId}`;
}

/** The Learning Center — jobs/learningNudge.js and the welcome email. */
function learningSettingsPath() {
    return '/app/settings/learning';
}

/** Admin user approval queue — auth/connectorJwt.js pending-user bell. */
function adminSecurityUsersPath() {
    return '/app/admin/security/users';
}

/** Platform-admin subscriptions overview — Stripe admin email. */
function adminSubscriptionsPath() {
    return '/app/admin/subscriptions';
}

/** A webpage opened inside the app — webpage builder/automation tool results. */
function webpagePath(webpageId) {
    return `/app/webpages/${webpageId}`;
}

/** A webpage's Studio editor — side-panel AI context. */
function webpageEditorPath(webpageId) {
    return `/app/studio/webpages/${webpageId}`;
}

/**
 * Consumer license settings. A real path segment, NOT a ?tab= param — the
 * settings router reads the pathname only, so the query form dropped the
 * payer on Preferences post-payment (BFSF-244). Stripe checkout return URL.
 */
function accountLicenseSettingsPath() {
    return '/app/settings/account/license';
}

/** Organisation license settings — see accountLicenseSettingsPath (BFSF-244). */
function orgLicenseSettingsPath() {
    return '/app/settings/organisation/license';
}

/** A settings tab by query param — Stripe billing-portal return URLs. */
function settingsTabPath(tab) {
    return `/app/settings?tab=${tab}`;
}

// ── Known-stale shapes (frozen too — fixing them is a behaviour change) ──

/**
 * STALE: `/settings/billing` is not an SPA route (pageFromPath sends unknown
 * paths to the app home). It only ever ships as the fallback return URL when
 * a Stripe billing-portal session cannot be created, so the landing is "the
 * app" rather than a 404 — but it is not the page it claims to be. Kept
 * byte-identical here so the freeze documents it; replacing it with a real
 * route is a deliberate follow-up, not a drive-by.
 */
function legacyBillingSettingsPath() {
    return '/settings/billing';
}

/**
 * STALE: `/login` is not an SPA route (B1) and will not become one — login
 * renders in place. pageFromPath registers it as a declared redirect alias
 * onto the app home, and the query string is what the boot code reads, so the
 * param is part of the frozen shape, not decoration.
 *
 * Who mints it: auth/login/emailVerificationRoutes.js ('verified=1',
 * 'error=verify_expired', 'error=verify_error'), auth/login/inviteRoutes.js
 * ('signup=1', 'error=invite_expired', 'error=invite_error') and
 * auth/login/passwordResetRoutes.js ('reset=<token>', straight into a mailbox
 * for an hour). NOT auth/admin/invitationRoutes.js: the invite mail carries
 * /auth/redeem-invite/<token> so the token stays out of the URL bar, the
 * Referer header and proxy access logs — it only reaches /login via that
 * endpoint's redirect to 'signup=1'. Byte-identical on purpose.
 */
function legacyLoginPath(search) {
    return `/login?${search}`;
}

module.exports = {
    clientHost,
    appRootPath,
    approvalPath,
    automationPath,
    automationRunPath,
    automationRunStepPath,
    coworkTaskPath,
    supportThreadPath,
    adminSupportInboxPath,
    adminSupportTicketPath,
    adminSupportTabPath,
    publicBaseUrl,
    complianceSectionPath,
    complianceIncidentPath,
    publicDsrPath,
    learningSettingsPath,
    adminSecurityUsersPath,
    adminSubscriptionsPath,
    webpagePath,
    webpageEditorPath,
    accountLicenseSettingsPath,
    orgLicenseSettingsPath,
    settingsTabPath,
    legacyBillingSettingsPath,
    legacyLoginPath,
};
