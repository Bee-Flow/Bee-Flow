// @typecheck
// User store schema — creates the users/organizations/groups/roles/subscription
// tables, applies the incremental column migrations on boot, and runs the
// one-time users/groups/roles JSON→DB migration.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, getOne, exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl, CODES } = require('../lib/_ddl');
const log = require('../../telemetry/log');

const initDB = makeStoreInit('UserStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            "displayName" TEXT,
            "firstName" TEXT,
            "lastName" TEXT,
            email TEXT,
            phone TEXT,
            avatar TEXT,
            "avatarType" TEXT,
            "passwordHash" TEXT,
            role TEXT DEFAULT 'user',
            groups TEXT DEFAULT '[]',
            "masterWrappedDEK" TEXT,
            "wrappedDEK" TEXT,
            "kekSalt" TEXT,
            "recoverySalt" TEXT,
            "recoveryWrappedDEK" TEXT,
            "ssoEncryptionSetup" INTEGER DEFAULT 0,
            "passwordResetRequired" INTEGER DEFAULT 0,
            "dekUnwrapFailures" INTEGER DEFAULT 0,
            "dekLockoutUntil" TEXT,
            "recoveryUnwrapFailures" INTEGER DEFAULT 0,
            "recoveryLockoutUntil" TEXT,
            "appPassword" TEXT,
            "appPasswordCreated" TEXT,
            "orgRole" TEXT DEFAULT '',
            "organizationId" TEXT DEFAULT '',
            "opaqueRecord" TEXT,
            "kdfMode" TEXT DEFAULT 'legacy_argon2',
            "createdAt" TEXT,
            status TEXT DEFAULT 'active',
            "activeIconPackId" TEXT
        );

        CREATE TABLE IF NOT EXISTS organizations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            tagline TEXT,
            address TEXT,
            email TEXT,
            phone TEXT,
            website TEXT,
            kvk TEXT,
            vat TEXT,
            logo TEXT,
            "footerText" TEXT,
            "defaultGroups" TEXT DEFAULT '[]',
            "allowSignup" TEXT DEFAULT '0',
            "authMethod" TEXT,
            "autoApproveSSO" TEXT DEFAULT '0',
            "encryption_tier" TEXT DEFAULT 'none',
            "encryption_scope" TEXT DEFAULT NULL,
            "org_root_key" TEXT DEFAULT NULL,
            "org_key_version" INTEGER DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT,
            name TEXT NOT NULL,
            description TEXT,
            permissions TEXT DEFAULT '[]',
            roles TEXT DEFAULT '[]',
            "userCount" INTEGER DEFAULT 0,
            "allowedAgentTypes" TEXT DEFAULT '[]',
            "allowedTiers" TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            permissions TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS subscription_plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            max_messages_per_month INTEGER,
            max_messages_by_type TEXT DEFAULT '{}',
            max_tokens_per_month INTEGER,
            max_cost_per_month REAL,
            max_users INTEGER,
            max_agents INTEGER,
            max_knowledge_sources INTEGER,
            allowed_features TEXT DEFAULT '[]',
            allowed_models TEXT DEFAULT '[]',
            is_default BOOLEAN DEFAULT FALSE,
            price REAL,
            currency TEXT DEFAULT 'EUR',
            billing_interval TEXT DEFAULT 'monthly',
            trial_days INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            is_public BOOLEAN DEFAULT FALSE,
            stripe_price_id TEXT,
            stripe_product_id TEXT,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS organization_subscriptions (
            id TEXT PRIMARY KEY,
            organization_id TEXT REFERENCES organizations(id),
            plan_id TEXT REFERENCES subscription_plans(id),
            status TEXT DEFAULT 'active',
            max_messages_per_month INTEGER,
            max_messages_by_type TEXT,
            max_tokens_per_month INTEGER,
            max_cost_per_month REAL,
            max_users INTEGER,
            max_agents INTEGER,
            max_knowledge_sources INTEGER,
            allowed_features TEXT,
            allowed_models TEXT,
            billing_cycle_start TEXT,
            notes TEXT,
            trial_end_date TEXT,
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            payment_status TEXT DEFAULT 'none',
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS subscription_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            changed_by TEXT,
            old_values TEXT,
            new_values TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Persistent audit trail for access-control changes (users, roles,
        -- groups, invitations, orgs). Mirrors subscription_audit_log but
        -- keeps the row count off the billing path. Querying by
        -- (organization_id, created_at) covers the "show me who changed
        -- access in org X over the last 90 days" GDPR Art. 30 / SOC 2 case.
        CREATE TABLE IF NOT EXISTS access_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            organization_id TEXT,
            changed_by TEXT,
            old_values TEXT,
            new_values TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- One-shot notification ledger. Anything that is "send this email
        -- exactly once for this subscription/event" — trial-ending warnings,
        -- payment-failed notices, dunning warnings, breach notifications —
        -- registers a row keyed on (target_type, target_id, kind). The
        -- UNIQUE constraint is the idempotency primitive; re-delivered
        -- webhooks attempt the insert and bail on conflict.
        CREATE TABLE IF NOT EXISTS notifications_sent (
            id TEXT PRIMARY KEY,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            recipient TEXT,
            payload TEXT,
            sent_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (target_type, target_id, kind)
        );

        -- Append-only consent ledger. One row per legal document accepted at a
        -- given moment (signup clickwrap, OAuth pending-signup, invite, re-consent
        -- or paid-checkout withdrawal waiver). Deliberately has NO uniqueness — the
        -- full acceptance history IS the legal evidence that discharges the Dutch
        -- "ter hand stellen" burden of proof (BW 6:233/6:234) and GDPR
        -- accountability. Mirrors access_audit_log.
        CREATE TABLE IF NOT EXISTS consent_acceptances (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            email TEXT,
            account_type TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            doc_version INTEGER NOT NULL,
            doc_sha256 TEXT,
            method TEXT NOT NULL,
            route TEXT,
            ip TEXT,
            user_agent TEXT,
            organization_id TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    // ── Kolom- en indexmigraties via runDdl (stores/lib/_ddl.js) ─────────────
    // Fouten worden per statement verzameld en luid gelogd in plaats van stil
    // ingeslikt als "column already exists" — een statement_timeout of
    // lock-wait las hier voorheen exact hetzelfde als een bestaande kolom.
    // Backfills die op een kolom uit een ándere store wachten, tolereren
    // alléén die verwachte code (zie de betreffende statements).
    await runDdl('userSchema', [
        `CREATE INDEX IF NOT EXISTS idx_access_audit_log_org_time ON access_audit_log (organization_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_access_audit_log_target ON access_audit_log (target_type, target_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_consent_acceptances_user ON consent_acceptances (user_id, created_at DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_consent_acceptances_doc ON consent_acceptances (doc_id, doc_version, created_at DESC)`,

        // ── Column migrations (safe for existing DBs) ─────────────────────────
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`,
        // Cached summary { docId: acceptedVersion } for fast re-consent detection.
        // The consent_acceptances ledger remains the authoritative legal evidence.
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "accepted_legal_versions" TEXT DEFAULT '{}'`,
        // Optional/marketing consent state { consentId: { granted, version, updatedAt } }.
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "optional_consents" TEXT DEFAULT '{}'`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "activeIconPackId" TEXT`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "autoApproveSSO" TEXT DEFAULT '0'`,
        // Pooled vs per-user AI-usage budget. '1' = org-wide pool (default,
        // matches legacy behaviour); '0' = cost cap is split evenly across
        // active seats so each user gets their own slice.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "usage_pooled" TEXT DEFAULT '1'`,
        // Org lifecycle state. 'active' is the default; 'suspended' blocks all
        // mutations (read-only) and is used for payment disputes / ToS holds;
        // 'archived' hides the org from listings and locks reads to owners.
        // Hard-delete remains a separate (irreversible) action.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'active'`,
        `CREATE INDEX IF NOT EXISTS idx_orgs_status ON organizations(status) WHERE status <> 'active'`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "enabledIntegrations" TEXT DEFAULT NULL`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "allowed_domains" TEXT DEFAULT NULL`,
        // Org-admin "active" subsets of the super-admin allow-lists. The super
        // admin grants capabilities (enabledIntegrations / beta_features); the
        // org admin then chooses which of those to actually turn on for their
        // org. Empty array (default) = nothing on. The runtime gates intersect
        // these with the allow-list before letting tools/routes through.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_enabled_integrations" TEXT DEFAULT '[]'`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_enabled_beta_features" TEXT DEFAULT '[]'`,

        // ── Unified entitlement grant layer ──
        // org_granted_capabilities holds the org-wide ("All members") grants for the
        // CORE and MCP capability kinds (integration/beta grants keep their existing
        // org_enabled_* columns above). The resolver (server/core/entitlements.js)
        // intersects these with the plan/license ceiling. Grant-only by design — see
        // the unified entitlement plan. Backfill seeds the user-facing core toggles
        // that were implicitly on-for-everyone before this layer existed, so no org
        // loses access to notebooks/projects/component_designer on first boot.
        // DEFAULT carries the user-facing core toggles so BOTH existing rows (Postgres
        // backfills them from the populated default on ADD COLUMN) AND newly-created
        // orgs grant notebooks/projects/component_designer to all members out of the
        // box — preserving today's "everyone gets these core features" behaviour. The
        // UPDATE is a belt-and-suspenders pass for a column that pre-existed at '[]'.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_granted_capabilities" TEXT DEFAULT '["notebooks","projects","component_designer"]'`,
        // ── Content encryption: tier + per-surface scope ──
        // DEFAULT 'none' is deliberate and load-bearing. An existing deployment
        // upgrading to this build must behave exactly as it did before: every
        // read path detects the on-disk format for itself, so plaintext rows keep
        // working, but nothing starts writing ciphertext until an operator opts
        // the org in. Flipping the tier later is safe in BOTH directions for the
        // same reason. See server/stores/encryptionPolicy.js.
        // org_root_key holds the per-org root key as an orgVault envelope; it is
        // created lazily on first use, never at migration time.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "encryption_tier" TEXT DEFAULT 'none'`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "encryption_scope" TEXT DEFAULT NULL`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_root_key" TEXT DEFAULT NULL`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_key_version" INTEGER DEFAULT 1`,
        // The per-org transcript DEK, WRAPPED by the org root key. Wrapped and
        // not derived on purpose: derived keys do not survive a root-key
        // rotation, and a transcription archive that forbids rotation forever
        // is a trap. orgEscrow.rotateOrgRootKey rewraps this in the same
        // all-or-nothing phase it rewraps every member DEK.
        // See server/auth/transcriptEscrow.js.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_transcript_dek" TEXT DEFAULT NULL`,
        // Any org row that predates the column gets the safe value explicitly,
        // rather than relying on the DEFAULT having applied.
        `UPDATE organizations SET "encryption_tier" = 'none' WHERE "encryption_tier" IS NULL`,
        `UPDATE organizations
            SET "org_granted_capabilities" = '["notebooks","projects","component_designer"]'
            WHERE "org_granted_capabilities" = '[]' OR "org_granted_capabilities" IS NULL`,

        // org_available_capabilities = the per-org ACCESS MENU set by the super-admin:
        // which matrix capabilities (within the plan/license ceiling) this org may use.
        // It is NOT a grant (it doesn't give anyone the capability) — it's the upper
        // bound the org-admin distributes within. NULL = no restriction (the org may
        // use everything its ceiling allows), preserving prior behaviour on upgrade.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_available_capabilities" TEXT DEFAULT NULL`,

        // org_beta_everyone = which GROUP-SCOPED betas (betaFeatures.js
        // `groupScoped`, e.g. meeting_notes) the org hands to ALL members. A
        // group-scoped beta outside this list reaches only the groups granted it
        // in the Access matrix. NULL = every group-scoped beta is for everyone,
        // which is exactly the behaviour before this column existed, so no org
        // changes on upgrade until its admin makes a choice. Deliberately NOT
        // org_enabled_beta_features: that column holds stale arrays that would
        // silently switch betas off for whole organisations if it were read again.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_beta_everyone" TEXT DEFAULT NULL`,

        // One-shot backfill: any org that already has a super-admin allow-list
        // gets that list copied into the new "enabled" column so today's
        // behaviour is preserved. Only rows still at the '[]' default are
        // touched, so this stays idempotent on subsequent boots.
        `UPDATE organizations
            SET "org_enabled_integrations" = "enabledIntegrations"
            WHERE "org_enabled_integrations" = '[]'
              AND "enabledIntegrations" IS NOT NULL
              AND "enabledIntegrations" != '[]'`,
        {
            sql: `UPDATE organizations
                SET "org_enabled_beta_features" = COALESCE("beta_features", '[]')
                WHERE "org_enabled_beta_features" = '[]'
                  AND "beta_features" IS NOT NULL
                  AND "beta_features" != '[]'`,
            tolerate: CODES.UNDEFINED_COLUMN,
            reden: 'beta_features column is added lazily by betaFeatures.js; backfill will run next boot once it exists',
        },

        // ── Azure AD Group Sync columns ──
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "azureTenantId" TEXT`,
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "azureTenantId" TEXT`,
        `CREATE TABLE IF NOT EXISTS microsoft_sso_link_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, object_id TEXT NOT NULL,
            email TEXT NOT NULL DEFAULT '', expires_at TIMESTAMPTZ NOT NULL,
            UNIQUE (tenant_id, object_id))`,
        `CREATE TABLE IF NOT EXISTS azure_sync_memberships (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            organization_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
            PRIMARY KEY (user_id,group_id))`,
        `CREATE TABLE IF NOT EXISTS microsoft_sso_binding_audit (
            id BIGSERIAL PRIMARY KEY, actor_id TEXT NOT NULL, user_id TEXT NOT NULL,
            tenant_id TEXT, object_id TEXT, action TEXT NOT NULL CHECK (action IN ('bind','unbind','migrate')),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
        `CREATE INDEX IF NOT EXISTS idx_microsoft_sso_binding_revision ON microsoft_sso_binding_audit(user_id,id DESC)`,
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "azureGroupId" TEXT`,
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'manual'`,
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "lastSyncedAt" TEXT`,
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "orgRole" TEXT DEFAULT ''`,
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "allowedTiers" TEXT DEFAULT '[]'`,
        // Per-group NC integration opt-out (Fase G). Org-admin uses this to
        // disable specific Nextcloud tools for members of a group. Empty array
        // means "inherit org-wide setting".
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "disabled_integrations" TEXT DEFAULT '[]'`,
        // Per-group GRANT list (all capability kinds: core/beta/integration/mcp).
        // The org-admin Access & Permissions matrix writes this; the resolver unions
        // each user's groups' grants and intersects with the ceiling. Grant-only —
        // there is no per-group "disable" in the new model. The legacy
        // disabled_integrations column above is still honoured by the resolver as a
        // transitional NC opt-out (enable-wins) so existing deployments don't loosen.
        `ALTER TABLE groups ADD COLUMN IF NOT EXISTS "granted_capabilities" TEXT DEFAULT '[]'`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "azureUserId" TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_microsoft_identity ON users (LOWER("azureTenantId"), LOWER("azureUserId")) WHERE "azureTenantId" IS NOT NULL AND "azureUserId" IS NOT NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_microsoft_identity ON groups ("organizationId", LOWER("azureTenantId"), LOWER("azureGroupId")) WHERE "azureTenantId" IS NOT NULL AND "azureGroupId" IS NOT NULL`,
    ]);

    await runDdl('userSchema', [
        // ── Nextcloud connector binding (instance ↔ org, NC uid ↔ user) ──
        // Each NC instance maps 1-op-1 to an org via ocs/v2.php/cloud/capabilities `instanceid`.
        // Auto-provisioned users carry `nc_uid` for sync + dedup; `provider` distinguishes
        // 'nextcloud_connector' from 'oauth_google' / 'local' for downstream auth flows.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_instance_id" TEXT`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_base_url" TEXT`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_admin_uid" TEXT`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_provisioned_at" TIMESTAMPTZ`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "connector_callback_url" TEXT`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_nc_instance_id ON organizations ("nc_instance_id") WHERE "nc_instance_id" IS NOT NULL`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "nc_uid" TEXT`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "provider" TEXT`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS "auto_provisioned" BOOLEAN DEFAULT FALSE`,
        `CREATE INDEX IF NOT EXISTS idx_users_nc_uid_org ON users ("organizationId", "nc_uid") WHERE "nc_uid" IS NOT NULL`,

        // BFSF-286: provenance — how the organisation was registered. 'direct'
        // (signup/OAuth wizard), 'admin' (admin panel), 'nextcloud_connector'
        // (connector bootstrap fresh-org). NULL = unknown/legacy (rendered as
        // "Unknown" in the admin UI so missing instrumentation stays visible).
        // Write-once at creation; unlike authMethod it is never rewritten by
        // pairing binds or unbinds (deliberately absent from updateOrganization's
        // colMap). Backfill: migrations/org-registration-source-2026-07.js
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "registration_source" TEXT`,

        // ── NC user/group sync configuration (per org) ──
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_mode" TEXT DEFAULT 'mirror_all'`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_groups" TEXT DEFAULT '[]'`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_excluded_groups" TEXT DEFAULT '[]'`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_new_user_default_status" TEXT DEFAULT 'active'`,
        // orgRole assigned to NC users auto-provisioned via the connector JWT path
        // ([server/auth/connectorJwt.js]). Without this column the default in
        // connectorJwt.js (agent_editor) applies, which gives standard agent/skill/
        // knowledge author rights. Operators can downgrade individual orgs by
        // updating this column directly (e.g. 'member' for chat-only deployments).
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_new_user_default_org_role" TEXT`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_last_sync_at" TIMESTAMPTZ`,
        // One-shot backfill: NC users provisioned before this column existed
        // landed with orgRole = '', which means the permission resolver gives them
        // only the page_chat fallback. Bump them to the agent_editor default so
        // Studio / Webpages / Meeting Notes routes stop 403-ing under their JWTs.
        `UPDATE users
             SET "orgRole" = 'agent_editor'
           WHERE provider = 'nextcloud_connector'
             AND ("orgRole" IS NULL OR "orgRole" = '')`,
        // First-run wizard flag — null until org-admin completes the App Store
        // onboarding. connectorJwt.js gates auto-provision on this so other NC
        // users wait at a "Setup in progress" screen until the admin is done.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_onboarding_completed_at" TIMESTAMPTZ`,

        // ── Onboarding-wizard outputs (deployment + selected plan) ──
        // Set once during the App Store wizard so the SaaS knows whether the org
        // intends to ride on Bee Flow Cloud vs self-hosted, and which subscription
        // the admin pre-selected. Neither activates a license — `selected_plan_id`
        // is a hint surfaced in License & Usage for the upsell flow.
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "deployment_mode" TEXT`,
        `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "selected_plan_id" TEXT`,
    ]);

    // ── Pending NC bindings (deferred adoption) ──
    // When a connector bootstraps and the NC admin's email maps to an
    // existing Bee Flow org without nc_instance_id, we DO NOT bind
    // automatically — that would let an attacker hosting a fake NC adopt
    // someone else's org. Instead a pending row is created here and the
    // org-admin must explicitly approve the binding from the authenticated
    // SaaS UI.
    await runDdl('userSchema', [
        `CREATE TABLE IF NOT EXISTS pending_nc_bindings (
            id              TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            nc_instance_id  TEXT NOT NULL,
            nc_base_url     TEXT NOT NULL,
            nc_admin_uid    TEXT NOT NULL,
            nc_admin_email  TEXT NOT NULL,
            nc_admin_display_name TEXT,
            connector_callback_url TEXT,
            theming_name    TEXT,
            nc_version      TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ NOT NULL,
            approved_at     TIMESTAMPTZ,
            approved_by_user_id TEXT
        )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_nc_bindings_active
            ON pending_nc_bindings (org_id, nc_instance_id) WHERE status = 'pending'`,
        `CREATE INDEX IF NOT EXISTS idx_pending_nc_bindings_org_status
            ON pending_nc_bindings (org_id, status)`,

        // Phase-2 pairing-code branch: org-admin generates a code in Bee Flow,
        // hands it to whoever installs the connector on a new NC. The code lives
        // in the same table as email-match pending bindings so the lifecycle
        // (pending/approved/denied/expired) stays unified. Nullable NC fields
        // because we don't know the target NC until the code is redeemed.
        `ALTER TABLE pending_nc_bindings
            ADD COLUMN IF NOT EXISTS pairing_code             TEXT,
            ADD COLUMN IF NOT EXISTS pairing_code_consumed_at TIMESTAMPTZ`,
        `ALTER TABLE pending_nc_bindings
            ALTER COLUMN nc_instance_id  DROP NOT NULL,
            ALTER COLUMN nc_base_url     DROP NOT NULL,
            ALTER COLUMN nc_admin_uid    DROP NOT NULL,
            ALTER COLUMN nc_admin_email  DROP NOT NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_nc_bindings_pairing_code_active
            ON pending_nc_bindings (pairing_code)
            WHERE pairing_code IS NOT NULL
              AND status = 'pending'
              AND pairing_code_consumed_at IS NULL`,

        // Email-code verification branch: when a connector bootstraps and the NC
        // admin email's DOMAIN matches an existing un-bound org (or exactly matches
        // a user), we send a one-time code to that mailbox and let the admin confirm
        // the binding from inside the embedded Nextcloud view — no external SaaS
        // login. The code is hashed at rest (salted with org_id:nc_instance_id);
        // attempts are capped. These rows always carry a real nc_instance_id, which
        // distinguishes them from pairing-code rows (nc_instance_id NULL until
        // redeemed) and from plain approval rows (verification_code_hash NULL).
        `ALTER TABLE pending_nc_bindings
            ADD COLUMN IF NOT EXISTS verification_code_hash TEXT,
            ADD COLUMN IF NOT EXISTS verification_email      TEXT,
            ADD COLUMN IF NOT EXISTS verification_attempts   INTEGER DEFAULT 0`,
    ]);

    await runDdl('userSchema', [
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
    ]);
    // Trial history — email-scoped, all-time. The trial_used_at column on
    // orgs/users is ephemeral (gone when the row is hard-deleted), so a
    // delete-and-recreate with the same email defeats the one-shot gate.
    // This table is the durable enforcement: a (scope, email) pair can
    // appear at most once, ever.
    await exec(`
        CREATE TABLE IF NOT EXISTS trial_history (
            id SERIAL PRIMARY KEY,
            scope TEXT NOT NULL CHECK (scope IN ('organization','consumer')),
            email_normalized TEXT NOT NULL,
            subscriber_id TEXT,
            plan_id TEXT,
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            trial_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            trial_end_date TIMESTAMPTZ
        )
    `);
    await runDdl('userSchema', [
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
    ]);
    // 'community' and 'full' are license-key tier concepts, not subscription
    // tiers. Strip them from subscription_plans so the cloud catalogue stays
    // clean; tier resolution still falls back to the community floor for
    // free/null-tier subscriptions, so behaviour is preserved.
    try {
        const result = await run(`UPDATE subscription_plans SET tier = NULL WHERE tier IN ('community', 'full') AND name <> '__consumer_default__'`);
        const n = result?.rowCount ?? 0;
        if (n > 0) log.info(`[UserStore] migrated ${n} subscription plan(s) off license-only tiers (community/full → NULL)`);
    } catch (e) { log.error('[UserStore] tier-migratie (community/full → NULL) gefaald:', e.message); /* niet-fataal */ }
    await runDdl('userSchema', [
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
    ]);

    // Seed a single €0 "Free" org plan once. New orgs auto-assign whichever
    // plan carries is_default (see loginRoutes/oauthRoutes), so Free becomes
    // the no-payment default tier and can be assigned from the admin Orgs view.
    // Only runs when no Free org plan exists yet — never clobbers admin edits.
    try {
        // Skip if ANY free org tier already exists (a plan named 'Free' OR any
        // €0 org plan) — avoids seeding a duplicate when the operator has
        // already created their own free plan (e.g. "Bee Flow Free").
        const existingFree = await getOne(
            `SELECT id FROM subscription_plans
              WHERE (plan_type = 'organization' OR plan_type IS NULL)
                AND (name = 'Free' OR price = 0)
              LIMIT 1`
        );
        if (!existingFree) {
            const freeId = crypto.randomUUID();
            // Preserve the single-default invariant the admin CRUD enforces.
            await run(`UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE`);
            await run(
                `INSERT INTO subscription_plans (
                    id, name, plan_type, description, price, currency, billing_interval, billing_model,
                    markup_percent, trial_days, max_cost_per_month, max_users, max_agents, max_knowledge_sources,
                    allowed_features, allowed_models, allowed_integrations, allowed_beta_features,
                    is_public, is_default, nc_recommended, sort_order, created_at, updated_at
                 ) VALUES (
                    $1, 'Free', 'organization', 'Free tier — limited AI usage, no payment required.', 0, 'EUR', 'monthly', 'fixed',
                    0, 0, 5, 3, 1, 5,
                    '[]', '[]', '[]', '[]',
                    FALSE, TRUE, FALSE, 0, NOW(), NOW()
                 )`,
                [freeId]
            );
            log.info('[UserStore] seeded default Free org plan', freeId);
        }
    } catch (e) { log.warn('[UserStore] Free plan seed skipped:', e.message); }

    // Seat-cap atomic enforcement support index (PR 1.C). The serializable
    // transaction in createUserWithSeatCheck reads a COUNT()...FOR UPDATE
    // and benefits from a covering partial index.
    await runDdl('userSchema', [
        `CREATE INDEX IF NOT EXISTS idx_users_org_status
            ON users ("organizationId", status)
            WHERE "organizationId" IS NOT NULL AND "organizationId" != ''`,
    ]);
}

// ── Migration from JSON ─────────────────────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

async function migrateJsonToDb() {
    await initDB();
    if (fs.existsSync(USERS_FILE)) {
        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            for (const [id, u] of Object.entries(users)) {
                const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
                if (!existing) {
                    const mwDek = u.masterWrappedDEK ? (typeof u.masterWrappedDEK === 'string' ? u.masterWrappedDEK : JSON.stringify(u.masterWrappedDEK)) : null;
                    const wDek = u.wrappedDEK ? (typeof u.wrappedDEK === 'string' ? u.wrappedDEK : JSON.stringify(u.wrappedDEK)) : null;
                    await run(`INSERT INTO users (id, username, "displayName", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt")
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,

                        [id, u.username, u.displayName || u.username, u.passwordHash, u.role || 'user',
                            JSON.stringify(u.groups || []), mwDek, wDek, '', '',
                            u.createdAt || new Date().toISOString().split('T')[0]]);
                    if (u.appPassword) {
                        await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3',
                            [typeof u.appPassword === 'object' ? JSON.stringify(u.appPassword) : u.appPassword, u.appPasswordCreated || new Date().toISOString(), id]);
                    }
                }
            }
            fs.renameSync(USERS_FILE, `${USERS_FILE}.bak`);
            log.info('[UserStore] Migrated users.json to database');
        } catch (err) { log.error('[UserStore] Failed to migrate users.json:', err); }
    }
    if (fs.existsSync(GROUPS_FILE)) {
        try {
            const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            for (const [id, g] of Object.entries(groups)) {
                const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount") VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [id, null, g.name, g.description || '', JSON.stringify(g.permissions || []), JSON.stringify(g.roles || []), g.userCount || 0]);
            }
            fs.renameSync(GROUPS_FILE, `${GROUPS_FILE}.bak`);
            log.info('[UserStore] Migrated groups.json to database');
        } catch (err) { log.error('[UserStore] Failed to migrate groups.json:', err); }
    }
    if (fs.existsSync(ROLES_FILE)) {
        try {
            const roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
            for (const [id, r] of Object.entries(roles)) {
                const ex = await getOne('SELECT id FROM roles WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO roles (id, name, description, permissions) VALUES ($1,$2,$3,$4)',
                    [id, r.name, r.description || '', JSON.stringify(r.permissions || [])]);
            }
            fs.renameSync(ROLES_FILE, `${ROLES_FILE}.bak`);
            log.info('[UserStore] Migrated roles.json to database');
        } catch (err) { log.error('[UserStore] Failed to migrate roles.json:', err); }
    }
}

migrateJsonToDb().catch(err => log.error('[UserStore] Migration error:', err.message));

module.exports = { initDB };
