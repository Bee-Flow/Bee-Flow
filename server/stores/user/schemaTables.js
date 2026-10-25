// @typecheck strict
'use strict';
// The user store's base tables (users, organizations, groups, roles,
// subscriptions, audit and consent ledgers) as one exec batch, plus the
// trial-history table. Run by ./schema.js; statements kept verbatim.

const BASE_TABLES_SQL = `
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
    `;

// Trial history — email-scoped, all-time. The trial_used_at column on
// orgs/users is ephemeral (gone when the row is hard-deleted), so a
// delete-and-recreate with the same email defeats the one-shot gate.
// This table is the durable enforcement: a (scope, email) pair can
// appear at most once, ever.
const TRIAL_HISTORY_SQL = `
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
    `;

module.exports = { BASE_TABLES_SQL, TRIAL_HISTORY_SQL };
