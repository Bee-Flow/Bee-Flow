// @typecheck strict
/**
 * The org-health code catalog: every problem and lifecycle event orgHealth.js
 * can record, with its severity, operator-facing English and remediation.
 * Kept apart from the emitter so adding a code never grows that file.
 */

const NO_ACTION = 'No action needed.';

// C(code, severity, defaultMessage, remediation, lifecycle?) → catalog entry.
// category is the dot-namespace prefix; i18nKey mirrors the reserved
// admin.orgHealth.problem.<code> namespace (remedy key derivable as
// admin.orgHealth.remedy.<code>).
/**
 * @param {string} code
 * @param {'info' | 'warning' | 'error' | 'critical'} severity
 * @param {string} defaultMessage
 * @param {string | null} remediation
 * @param {boolean} [alwaysAppend]
 */
function C(code, severity, defaultMessage, remediation, alwaysAppend = false) {
    return {
        category: code.split('.')[0],
        severity,
        defaultMessage,
        remediation,
        i18nKey: `admin.orgHealth.problem.${code}`,
        alwaysAppend,
    };
}

// Canonical code catalog. Operator-facing English; * = lifecycle events that
// always land on the timeline (ALWAYS_APPEND).
const CODES = {
    // ── bootstrap (connector → org provisioning) ──
    'bootstrap.org_created': C('bootstrap.org_created', 'info',
        'Organization created from Nextcloud connector bootstrap.', NO_ACTION, true),
    'bootstrap.org_adopted': C('bootstrap.org_adopted', 'info',
        'Existing organization adopted by the Nextcloud instance after email verification.', NO_ACTION, true),
    'bootstrap.returning_bind': C('bootstrap.returning_bind', 'info',
        'Known Nextcloud instance re-bound to its organization on bootstrap.', NO_ACTION),
    'bootstrap.pairing_redeemed': C('bootstrap.pairing_redeemed', 'info',
        'Pairing code redeemed — Nextcloud instance bound to the organization.', NO_ACTION, true),
    'bootstrap.verification_pending': C('bootstrap.verification_pending', 'warning',
        'Bootstrap is waiting for admin email verification.',
        'Ask the Nextcloud admin to enter the verification code sent to their email, or re-send it from the connector setup screen.'),
    'bootstrap.verification_succeeded': C('bootstrap.verification_succeeded', 'info',
        'Admin email verification succeeded.', NO_ACTION, true),
    'bootstrap.verify_failed': C('bootstrap.verify_failed', 'error',
        'Could not verify Nextcloud instance ownership (capabilities round-trip failed).',
        'Check that the Nextcloud base URL is reachable from Bee Flow and that the instance id matches, then retry the connector setup.'),
    'bootstrap.rebind_proof_required': C('bootstrap.rebind_proof_required', 'warning',
        'A bootstrap for an already-bound Nextcloud instance came from a different address than the binding records.',
        'If the Nextcloud moved, generate a pairing code in the Bee Flow admin (Organization → Nextcloud) and enter it in the connector setup; otherwise check BEEFLOW_NC_PUBLIC_URL on the connector.'),
    'bootstrap.pairing_required': C('bootstrap.pairing_required', 'warning',
        'Bootstrap refused: this Nextcloud instance must be paired with an existing organization first.',
        'Generate a pairing code in the Bee Flow admin (Organization → Nextcloud) and enter it in the connector setup.'),
    'bootstrap.pairing_code_invalid': C('bootstrap.pairing_code_invalid', 'warning',
        'An invalid or expired pairing code was submitted.',
        'Generate a fresh pairing code and try again — codes are single-use and expire.'),
    'bootstrap.admin_email_conflict': C('bootstrap.admin_email_conflict', 'error',
        'The Nextcloud admin email already belongs to a user in another organization.',
        'Use a different admin email in Nextcloud, or detach/move the existing Bee Flow user before retrying.'),
    'bootstrap.too_many_pending_bindings': C('bootstrap.too_many_pending_bindings', 'warning',
        'Too many pending binding/verification attempts for this organization.',
        'Wait for pending verifications to expire or cancel them in the admin, then retry.'),
    'bootstrap.org_create_failed': C('bootstrap.org_create_failed', 'critical',
        'Creating the organization during connector bootstrap failed.',
        'Check server logs around the bootstrap timestamp and retry the connector setup; if it persists, contact support.'),
    'bootstrap.admin_provision_failed': C('bootstrap.admin_provision_failed', 'error',
        'The Nextcloud admin user could not be provisioned in the organization.',
        'Verify the admin has a valid, non-conflicting email in Nextcloud, then re-run the connector setup.'),
    'bootstrap.plan_applied': C('bootstrap.plan_applied', 'info',
        'A default subscription plan was applied to the organization.', NO_ACTION, true),
    'bootstrap.plan_apply_failed': C('bootstrap.plan_apply_failed', 'error',
        'Applying the default subscription plan failed.',
        'Assign a subscription plan to this organization manually (super-admin → Subscriptions).'),
    'bootstrap.community_fallback': C('bootstrap.community_fallback', 'critical',
        'No default plan is configured for Nextcloud signups — the organization was provisioned without a subscription, so every AI request is blocked on cloud.',
        'Configure an NC-recommended default plan (super-admin → Plans) or assign this organization a subscription; until then every AI request is blocked on cloud.'),

    // ── auth (per-request connector gate exits — rollup-only) ──
    'auth.no_matching_tenant_key': C('auth.no_matching_tenant_key', 'critical',
        'Connector requests are signed with a tenant key that does not match any known organization.',
        'The connector likely holds a stale tenant key — run /connector/diagnose from the Nextcloud app or re-pair the instance.'),
    'auth.missing_email': C('auth.missing_email', 'error',
        'A Nextcloud user without an email address tried to sign in.',
        'Set an email address for the user in Nextcloud — accounts cannot be created without one.'),
    'auth.blocked_onboarding_pending': C('auth.blocked_onboarding_pending', 'warning',
        'Users are blocked because the organization onboarding wizard has not been completed.',
        'An organization admin must open Bee Flow from Nextcloud once and complete the onboarding wizard.'),
    'auth.blocked_manual_mode': C('auth.blocked_manual_mode', 'warning',
        'User sign-in blocked: the organization is in manual user-provisioning mode.',
        'Add the user manually in Bee Flow, or switch the sync mode in the organization Nextcloud settings.'),
    'auth.blocked_pending_approval': C('auth.blocked_pending_approval', 'warning',
        'Users are waiting for admin approval and cannot use AI yet.',
        'Approve pending users in Admin → Users, or set new Nextcloud users to be active by default in the organization settings.'),
    'auth.blocked_seat_cap': C('auth.blocked_seat_cap', 'error',
        'User sign-in blocked: the organization reached its seat limit.',
        'Raise the seat limit on the subscription plan or deactivate unused users.'),
    'auth.blocked_geo': C('auth.blocked_geo', 'warning',
        'User sign-in blocked by the geo/IP policy.',
        'Review the organization geo restrictions if this user should have access.'),
    'auth.blocked_org_mismatch': C('auth.blocked_org_mismatch', 'error',
        'A user account exists under a different organization than the connector key.',
        'Detach or move the conflicting user, or re-pair the connector with the correct organization.'),
    'auth.provision_failed': C('auth.provision_failed', 'error',
        'Auto-provisioning a Nextcloud user failed.',
        'Check the user details in Nextcloud (email, uid) and the server logs; the user can retry after the issue is fixed.'),
    'auth.user_auto_provisioned': C('auth.user_auto_provisioned', 'info',
        'A Nextcloud user was auto-provisioned.', NO_ACTION, true),
    'auth.encryption_key_failed': C('auth.encryption_key_failed', 'error',
        'Deriving the user encryption key failed during connector sign-in.',
        'The user may need to re-run encryption setup; check server logs for the key-derivation error.'),
    'auth.session_save_failed': C('auth.session_save_failed', 'error',
        'Saving the user session failed during connector sign-in.',
        'Check Redis/session-store health — users cannot stay signed in until this is fixed.'),

    // ── chat (subscription gate + provider/DLP exits) ──
    'chat.subscription_blocked': C('chat.subscription_blocked', 'critical',
        'AI requests are blocked because the organization has no active subscription.',
        'Assign a subscription to this organization, or configure the NC-recommended default plan so new connector organizations get one automatically.'),
    'chat.budget_exhausted': C('chat.budget_exhausted', 'warning',
        'AI requests are being rejected because the subscription budget or message limit is exhausted.',
        'Raise the plan limits or wait for the next billing cycle.'),
    'chat.provider_config_failed': C('chat.provider_config_failed', 'error',
        'No usable AI provider configuration was found for the requested model.',
        'Check the provider API keys and model configuration for this organization.'),
    'chat.provider_error': C('chat.provider_error', 'error',
        'The AI provider returned an error during streaming.',
        'Check provider status and API-key quotas; the sanitized error details are in the problem metadata.'),
    'chat.dlp_blocked': C('chat.dlp_blocked', 'info',
        'A message was blocked by the DLP policy.',
        'Review the organization shield/DLP configuration if this is unexpected.'),

    // ── binding (admin-driven pairing lifecycle) ──
    'binding.approved': C('binding.approved', 'info',
        'A Nextcloud binding request was approved.', NO_ACTION, true),
    'binding.denied': C('binding.denied', 'info',
        'A Nextcloud binding request was denied.', NO_ACTION, true),
    'binding.removed': C('binding.removed', 'info',
        'A Nextcloud binding was removed.', NO_ACTION, true),
    'binding.pairing_code_generated': C('binding.pairing_code_generated', 'info',
        'A pairing code was generated.', NO_ACTION, true),

    // ── onboarding ──
    'onboarding.completed': C('onboarding.completed', 'info',
        'The organization completed the Nextcloud onboarding wizard.', NO_ACTION, true),

    // ── connector (phone-home) ──
    'connector.reported_error': C('connector.reported_error', 'error',
        'The Nextcloud connector reported an error via phone-home.',
        'Open the connector diagnostics in Nextcloud (Settings → Bee Flow); the reported category and code are in the problem metadata.'),
    'connector.key_divergence': C('connector.key_divergence', 'critical',
        'Connector signs with a stale tenant key — its requests cannot be authenticated.',
        'Run /connector/diagnose from the Nextcloud app or re-pair the instance to rotate the tenant key.'),
    // warning, not error: error/critical mark the org as unable to use AI chat
    // (fleet banner, OrgHealthBanner), and a failing user sync does not do that.
    'connector.nc_sync_failed': C('connector.nc_sync_failed', 'warning',
        'User and group sync with Nextcloud is failing: Bee Flow cannot read the user list through the connector, so users, groups and deactivations are stale.',
        'Check that the Bee Flow app is enabled and healthy in Nextcloud (Settings → Bee Flow, connection check) or re-pair the instance, then run "Sync now" in the organization Nextcloud sync settings. While this is open the automatic sync retries once every 24 hours.'),
    'connector.app_removed': C('connector.app_removed', 'warning',
        'The Bee Flow app answers 404 at the connector callback URL: it is disabled or no longer installed in Nextcloud, so user and group sync is suspended.',
        'Re-enable or re-install the Bee Flow app in Nextcloud, or remove the Nextcloud binding of this organization. While this is open the automatic sync retries once every 7 days.'),
};

module.exports = { CODES };
