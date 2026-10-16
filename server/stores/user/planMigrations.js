// @typecheck
'use strict';
// runDdl statement lists for the user store's subscriptions, plans, licence
// keys and billing tables, in the order ./schema.js runs them. Each list is
// one runDdl call (one transaction); statements kept verbatim.

const SUBSCRIPTION_COLUMNS = [
    // ── Subscription schema migrations ──
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price REAL`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR'`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_interval TEXT DEFAULT 'monthly'`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 0`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id TEXT`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_product_id TEXT`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS trial_end_date TEXT`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'none'`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'organization'`,
    // One-shot trial gate — set when a trial is granted/started, never cleared.
    // Survives subscription churn so an org/user cannot start a second trial
    // after cancelling the first.
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ`,
    // ── Structured billing address ──
    // The legacy `address` column is reused as line1 (street + number). These
    // add the remaining structured parts so we can populate the Stripe
    // Customer's `address` (country is mandatory for Stripe Tax) and pre-fill
    // checkout + the billing portal.
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_line2 TEXT`,
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_postal_code TEXT`,
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_city TEXT`,
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_country TEXT`,
    // ── MFA (TOTP) + self-service password reset ──
    // mfa_secret is the base32 TOTP secret, encrypted at rest (configStore
    // envelope). mfa_recovery_codes is a JSON array of bcrypt-hashed one-time
    // codes. password_reset_token_hash is SHA-256(token); the raw token only
    // ever lives in the emailed link.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes_generated_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ`,
    // ── Recovery-key brute-force counters ──
    // auth/encryption.js unlockWithRecoveryKey() has always read and written
    // these two, but they existed nowhere else: no column, no colMap entry.
    // updateUser silently drops unknown keys, so the counter never left 0 and
    // the lockout at 10 failures was dead code — unlimited recovery-key
    // attempts with no rate limit and no alerting. The unit test missed it
    // because its userStore double is a permissive Object.assign.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS "recoveryUnwrapFailures" INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS "recoveryLockoutUntil" TEXT`,
    // ── Managed-tier escrow ──
    // The user's DEK wrapped under their org's root key (auth/orgEscrow.js).
    // This is what lets an admin reset a password, and a background automation
    // read the same data, without the user losing anything. Null until the org
    // opts into the managed tier — it is never populated on upgrade.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS "orgWrappedDEK" TEXT`,
    // ── Email verification + locale ──
    // email_verification_token_hash is SHA-256(token); the raw token only ever
    // lives in the emailed verification link. email_verified_at marks the
    // confirmation timestamp (null = unverified). preferred_locale is the
    // language the user picked at signup — used to render transactional emails.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_locale TEXT`,
    // ── Account activity + credential age ──
    // last_seen_at is written THROTTLED from requireAuth (one write per user
    // per window, see auth/permissions.js), so it means "roughly when we last
    // saw this account", never an audit trail — the session table is where
    // per-device detail belongs. It stays NULL until the account's first
    // request after this column exists, and NULL means "unknown": a screen
    // must say so rather than invent a date.
    //
    // password_changed_at is stamped by every path that writes a genuinely
    // NEW credential — the decision lives in one place (isNewCredential in
    // users.js) so a seventh password route cannot forget it. Existing rows
    // stay NULL on purpose: "createdAt" is a date-only TEXT column and the
    // hash carries no date, so there is nothing honest to backfill from, and
    // a made-up date on a security screen is worse than an empty one.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`,
];

const PLAN_COLUMNS = [
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_trial_history_scope_email ON trial_history(scope, email_normalized)`,
    `CREATE INDEX IF NOT EXISTS idx_trial_history_customer ON trial_history(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL`,
    // Plan-bound integrations + beta-feature allow-lists. Both act as a cap
    // (org cannot enable anything not in this list) AND a default-on bundle
    // applied when the plan is assigned. NULL = unrestricted (legacy plans).
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS allowed_integrations TEXT`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS allowed_beta_features TEXT`,
    // DEPRECATED: allowed_mcp_servers — MCP servers are integrations now, so
    // their `mcp:<id>` ids live in allowed_integrations. Column kept dormant
    // (no destructive drop); the one-time migration folds any existing values
    // into allowed_integrations. Not read or written by code anymore.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS allowed_mcp_servers TEXT`,
    // Pay-as-you-go (PAYG) plans: bill per actual usage with a markup % on
    // top of raw AI provider cost. `billing_model='metered'` swings the
    // plan onto a Stripe Billing Meter price; `markup_percent` applies on
    // top of `computeCost(...)` before the meter event is reported.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_model TEXT DEFAULT 'fixed'`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS markup_percent REAL DEFAULT 0`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_meter_id TEXT`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_meter_event_name TEXT`,
    // Per-seat billing: when true, Stripe checkout uses quantity = active seat
    // count and the effective max_messages_per_month is computed as
    // max_messages_per_seat × seat_count in getEffectiveLimits.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS per_seat BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS max_messages_per_seat INTEGER`,
    // Track the Stripe-side seat quantity on the subscription row so the
    // effective-cap computation stays in sync with the bill even when the
    // local user count and Stripe drift transiently.
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_seat_quantity INTEGER`,
    `UPDATE subscription_plans SET billing_model = 'fixed' WHERE billing_model IS NULL`,
    // Surfaced in the NC App Store onboarding wizard as the "Recommended for
    // Nextcloud" card. Only one plan can carry this flag at a time — the
    // admin-CRUD route enforces uniqueness on write.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS nc_recommended BOOLEAN DEFAULT FALSE`,
    // Audience restriction, not a default: a plan flagged nc_only is offered only
    // to organisations bound to a Nextcloud instance. Narrows is_public — a plan
    // that isn't public stays invisible either way. Unlike nc_recommended, any
    // number of plans may carry this flag.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS nc_only BOOLEAN DEFAULT FALSE`,
    // Short marketing line shown under the plan name in the wizard cards.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS tagline TEXT`,
    // Explicit tier mapping so license/index.js doesn't have to fall back to
    // substring-matching the plan name. Backfill from name on first run; the
    // admin Plans editor lets future plans set this explicitly.
    `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS tier TEXT`,
    `UPDATE subscription_plans SET tier = 'enterprise' WHERE tier IS NULL AND LOWER(name) LIKE '%enterprise%'`,
    `UPDATE subscription_plans SET tier = 'pro'        WHERE tier IS NULL AND LOWER(name) LIKE '%pro%'`,
    `UPDATE subscription_plans SET tier = 'community'  WHERE tier IS NULL AND (LOWER(name) LIKE '%community%' OR name = '__consumer_default__')`,
];

const BILLING_TABLES = [
    // Auto-migrate legacy __consumer_default__ plan
    `UPDATE subscription_plans SET plan_type = 'consumer' WHERE name = '__consumer_default__' AND (plan_type IS NULL OR plan_type = 'organization')`,
    // Consumer subscriptions table (per-user, org-less)
    `CREATE TABLE IF NOT EXISTS consumer_subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(id),
            plan_id TEXT REFERENCES subscription_plans(id),
            status TEXT DEFAULT 'active',
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            payment_status TEXT DEFAULT 'none',
            billing_cycle_start TEXT,
            trial_end_date TEXT,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        )`,

    // ── Phase 2: Indexes on hot auth/org query paths ──────────────────────
    // getUserByEmail() is called on every login — must be index-scanned
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email)) WHERE email IS NOT NULL`,
    // org-scoped queries (getUsersByOrg, admin lists)
    `CREATE INDEX IF NOT EXISTS idx_users_org ON users("organizationId") WHERE "organizationId" IS NOT NULL AND "organizationId" != ''`,
    // Audit log index
    `CREATE INDEX IF NOT EXISTS idx_audit_target ON subscription_audit_log(target_type, target_id)`,

    // ── License keys (signed JWT activations) ──
    `CREATE TABLE IF NOT EXISTS license_keys (
            id TEXT PRIMARY KEY,
            organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
            user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            scope TEXT NOT NULL DEFAULT 'organization',
            raw_token TEXT NOT NULL,
            tier TEXT NOT NULL,
            issuer TEXT,
            issued_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            billing_interval TEXT NOT NULL DEFAULT 'monthly',
            last_refresh_at TIMESTAMPTZ,
            refresh_status TEXT DEFAULT 'pending',
            revoked_at TIMESTAMPTZ,
            activated_by TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )`,
    `CREATE INDEX IF NOT EXISTS idx_license_keys_org ON license_keys(organization_id) WHERE organization_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_license_keys_user ON license_keys(user_id) WHERE user_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_license_keys_status ON license_keys(refresh_status)`,

    // ── Security keys (WebAuthn / FIDO2 second factor, e.g. a YubiKey) ──
    // One row per registered authenticator. Nothing here is secret: the
    // public key and credential id are public by design, which is why they
    // are not sealed like mfa_secret. rp_id is the relying-party id the key
    // was registered under; a key only answers for that id, so a host
    // change leaves the row unusable rather than wrong.
    `CREATE TABLE IF NOT EXISTS user_security_keys (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            credential_id TEXT NOT NULL UNIQUE,
            public_key TEXT NOT NULL,
            sign_count BIGINT NOT NULL DEFAULT 0,
            transports TEXT NOT NULL DEFAULT '[]',
            rp_id TEXT NOT NULL,
            name TEXT NOT NULL,
            aaguid TEXT,
            backed_up BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_used_at TIMESTAMPTZ
        )`,
    `CREATE INDEX IF NOT EXISTS idx_user_security_keys_user ON user_security_keys(user_id)`,

    // Stripe webhook idempotency. Stripe retries on 5xx/timeout, so every
    // event handler runs through a dedup check keyed on event.id. Rows older
    // than ~30d can be pruned out-of-band; the index keeps that scan cheap.
    `CREATE TABLE IF NOT EXISTS stripe_processed_events (
            event_id     TEXT PRIMARY KEY,
            event_type   TEXT NOT NULL,
            processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            payload_hash TEXT
        )`,
    `CREATE INDEX IF NOT EXISTS idx_stripe_evt_processed_at ON stripe_processed_events(processed_at)`,

    // Notification idempotency. Each (target_id, notif_kind) pair can fire
    // at most once. Used by trial/dunning/expiry warnings so retries don't
    // double-email customers.
    `CREATE TABLE IF NOT EXISTS license_notifications_sent (
            target_id   TEXT NOT NULL,
            notif_kind  TEXT NOT NULL,
            sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (target_id, notif_kind)
        )`,

    // Dunning / payment-failure escalation columns. The webhook bumps the
    // attempt counter; a periodic tick flips status='suspended' after the
    // configured grace expires. invoice.paid resets both.
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS payment_attempt_count INTEGER DEFAULT 0`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS last_payment_failure_at TIMESTAMPTZ`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS payment_attempt_count INTEGER DEFAULT 0`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS last_payment_failure_at TIMESTAMPTZ`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ`,

    // Manual-override window (PR 2.B). Admin sets manual_override_until to a
    // timestamp; Stripe webhooks honour it by skipping status/plan_id writes
    // until it elapses. Audit-logged on both ends.
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS manual_override_until TIMESTAMPTZ`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS manual_override_by TEXT`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS manual_override_until TIMESTAMPTZ`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS manual_override_by TEXT`,

    // In-app cancel + period tracking. cancel_at_period_end mirrors Stripe's
    // flag so the UI can show a "cancels on …" banner; cancel_at and
    // current_period_end carry the timestamps needed for that banner without
    // a round-trip to Stripe. Populated by the customer.subscription.updated
    // webhook and by the cancel/reactivate endpoints.
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ`,
    `ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ`,

    // Deferred (end-of-period) downgrade. When an org downgrades to a cheaper
    // plan we don't switch immediately — a Stripe Subscription Schedule flips
    // the price at the cycle boundary. These two columns record the pending
    // target + effective date so the UI can show a "downgrade scheduled" banner;
    // the customer.subscription.updated webhook clears them once the new price
    // becomes active.
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_id TEXT`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_effective TIMESTAMPTZ`,
    `ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_schedule_id TEXT`,
];

// Seat-cap atomic enforcement support index (PR 1.C). The serializable
// transaction in createUserWithSeatCheck reads a COUNT()...FOR UPDATE
// and benefits from a covering partial index.
const SEAT_CAP_INDEX = [
    `CREATE INDEX IF NOT EXISTS idx_users_org_status
            ON users ("organizationId", status)
            WHERE "organizationId" IS NOT NULL AND "organizationId" != ''`,
];

module.exports = { SUBSCRIPTION_COLUMNS, PLAN_COLUMNS, BILLING_TABLES, SEAT_CAP_INDEX };
