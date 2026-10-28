// @typecheck strict
'use strict';
// runDdl statement lists for the user store's accounts, organisations and
// Nextcloud connector binding, in the order ./schema.js runs them. Each list
// is one runDdl call (one transaction); statements kept verbatim.

const { CODES } = require('../lib/_ddl');

// ── Column and index migrations via runDdl (stores/lib/_ddl.js) ──────────
// Failures are collected per statement and logged loudly instead of being
// swallowed as "column already exists": a statement_timeout or a lock wait
// used to read exactly like an existing column here. Backfills that wait on a
// column from ANOTHER store tolerate only that expected code (see those
// statements).
const ACCOUNT_MIGRATIONS = [
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
    // loses access to notebooks/projects on first boot (component_designer: gone 2026-10).
    // DEFAULT carries the user-facing core toggles so BOTH existing rows (Postgres
    // backfills them from the populated default on ADD COLUMN) AND newly-created
    // orgs grant notebooks/projects to all members out of the
    // box — preserving today's "everyone gets these core features" behaviour. The
    // UPDATE is a belt-and-suspenders pass for a column that pre-existed at '[]'.
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_granted_capabilities" TEXT DEFAULT '["notebooks","projects"]'`,
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
    // NULL only, never '[]': '[]' is what an admin's deliberate "all three off"
    // is stored as, and this runs on EVERY boot, so matching it turned that
    // choice back on at the next restart. The column DEFAULT already seeds
    // ADDed columns and new orgs, so a '[]' left over is a decision, not a gap.
    `UPDATE organizations
            SET "org_granted_capabilities" = '["notebooks","projects"]'
            WHERE "org_granted_capabilities" IS NULL`,

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

    // org_everyone_revoked = SELF-HOSTED only: the matrix-togglable core and
    // (non-group-scoped) beta capability ids the org admin switched OFF for
    // "All members". Groups can still grant them (buildGroupGrant). NULL =
    // nothing revoked, which is exactly the single-switch behaviour from
    // before this column existed, so no install changes on upgrade. A
    // deny-list on purpose: a feature added to the org's access menu later
    // must default to ON for everyone, as it always did. Cloud ignores it
    // (org_granted_capabilities leads there). Deliberately NOT
    // org_enabled_beta_features: stale arrays, see org_beta_everyone above.
    `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "org_everyone_revoked" TEXT DEFAULT NULL`,

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
];

const NC_CONNECTOR_COLUMNS = [
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

    // Provenance — how the organisation was registered. 'direct'
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
];

// ── Pending NC bindings (deferred adoption) ──
// When a connector bootstraps and the NC admin's email maps to an
// existing Bee Flow org without nc_instance_id, we DO NOT bind
// automatically — that would let an attacker hosting a fake NC adopt
// someone else's org. Instead a pending row is created here and the
// org-admin must explicitly approve the binding from the authenticated
// SaaS UI.
const PENDING_NC_BINDINGS_DDL = [
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
    // Per-row lifetime counters for the email-code branch. Unlike
    // verification_attempts (per code, reset on every new code) these never
    // reset while the row is live, so resend/retarget/re-bootstrap cannot
    // buy unlimited guesses at a 6-digit code (ncBindings.js).
    `ALTER TABLE pending_nc_bindings
            ADD COLUMN IF NOT EXISTS verification_attempts_total INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS verification_code_sends     INTEGER NOT NULL DEFAULT 0`,
];

module.exports = { ACCOUNT_MIGRATIONS, NC_CONNECTOR_COLUMNS, PENDING_NC_BINDINGS_DDL };
