// @typecheck
/**
 * Support schema — the DDL for every table this store owns, and the one-shot
 * initialiser every other module in this folder awaits before its first query.
 *
 * Tables created here:
 *   support_threads         — one row per conversation (status/assignee/SLA/CSAT)
 *   support_messages        — append-only message log per thread
 *   support_thread_events   — legacy per-thread audit trail
 *   support_audit_log       — unified audit log (threads, inboxes, config)
 *   support_canned_responses / support_sla_policies / support_tag_taxonomy
 *   support_assignment_state — round-robin cursor per org
 *   support_issue_links     — ticket ↔ YouTrack issue matches
 */

const { pool } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const log = require('../../telemetry/log');

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS support_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    requester_user_id TEXT,
    requester_email TEXT NOT NULL,
    requester_name TEXT,
    source TEXT NOT NULL CHECK (source IN ('in_app','marketing')),
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','ai_responding','awaiting_user','awaiting_agent','resolved','closed')),
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low','normal','high','urgent')),
    assignee_user_id TEXT,
    ai_handled BOOLEAN DEFAULT false,
    ai_escalated_reason TEXT,
    first_response_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ DEFAULT now(),
    requester_ip TEXT,
    requester_ua TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_threads_status_last ON support_threads(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_org ON support_threads(organization_id);
CREATE INDEX IF NOT EXISTS idx_support_threads_email ON support_threads(requester_email);
CREATE INDEX IF NOT EXISTS idx_support_threads_assignee ON support_threads(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_support_threads_requester_user ON support_threads(requester_user_id);

-- iteration 2: rol-context. Denormalized so a renamed org or a removed user
-- doesn't erase what the ticket originally said about the requester.
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS requester_org_role TEXT;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS requester_org_name TEXT;

-- iteration 3: append-only audit log of who-did-what on a thread.
CREATE TABLE IF NOT EXISTS support_thread_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    actor_user_id TEXT,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('staff','system','requester')),
    action TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_thread_events_thread ON support_thread_events(thread_id, created_at);

CREATE TABLE IF NOT EXISTS support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('requester','ai','staff','system')),
    author_user_id TEXT,
    author_display TEXT,
    body TEXT NOT NULL,
    body_html TEXT,
    internal_note BOOLEAN DEFAULT false,
    kb_citations JSONB DEFAULT '[]'::jsonb,
    ai_confidence NUMERIC(3,2),
    ai_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);

-- iteration 3: per-message email delivery status. JSONB shape:
--   { ok: true, at: '2026-…' } on success,
--   { ok: false, error: 'SMTP …', at: '2026-…' } on failure.
-- MUST come after the support_messages CREATE above: this ALTER references
-- the table, so on a fresh DB it would otherwise abort the whole INIT_SQL
-- batch (one implicit transaction) with 'relation "support_messages" does
-- not exist', leaving every support table uncreated.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS email_send_status JSONB;

-- iteration 4: full ticket-system fields — tags/category, SLA timers, CSAT,
-- and auto-assignment. All additive so existing rows keep working.
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_first_response_due_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_resolution_due_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_first_response_breached_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_resolution_breached_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_paused BOOLEAN DEFAULT false;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS csat_score SMALLINT
    CHECK (csat_score IS NULL OR (csat_score >= 1 AND csat_score <= 5));
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS csat_comment TEXT;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS csat_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS resolution_confirmed_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS resolution_disputed_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS auto_assigned BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_support_threads_tags ON support_threads USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_support_threads_sla_first
    ON support_threads(sla_first_response_due_at)
    WHERE sla_first_response_breached_at IS NULL
      AND status IN ('open','ai_responding','awaiting_user','awaiting_agent');
CREATE INDEX IF NOT EXISTS idx_support_threads_sla_res
    ON support_threads(sla_resolution_due_at)
    WHERE sla_resolution_breached_at IS NULL
      AND status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_support_threads_csat ON support_threads(csat_at);

-- Canned responses: org-scoped templates (NULL organization_id = system-wide).
CREATE TABLE IF NOT EXISTS support_canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    shortcut TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_canned_org ON support_canned_responses(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_canned_shortcut
    ON support_canned_responses(COALESCE(organization_id, '__system__'), shortcut)
    WHERE shortcut IS NOT NULL;

-- SLA policies: per org × priority. NULL organization_id = global default.
CREATE TABLE IF NOT EXISTS support_sla_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
    first_response_minutes INT NOT NULL,
    resolution_minutes INT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_global ON support_sla_policies(priority) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_org ON support_sla_policies(organization_id, priority) WHERE organization_id IS NOT NULL;

-- Tag taxonomy: org catalogue of tag name + colour, for consistent UI.
-- Actual thread tags stay denormalised as JSONB on support_threads.
CREATE TABLE IF NOT EXISTS support_tag_taxonomy (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    name TEXT NOT NULL,
    color TEXT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_org_name
    ON support_tag_taxonomy(COALESCE(organization_id, '__system__'), LOWER(name));

-- Round-robin cursor per org for auto-assignment ('__global__' for unscoped).
CREATE TABLE IF NOT EXISTS support_assignment_state (
    organization_id TEXT PRIMARY KEY,
    last_assignee_user_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- iteration 5: tenant Support studio — a non-global-admin org runs its OWN
-- customer-support inbox by connecting external mailbox(es) (Gmail/Outlook).
-- Bee Flow's own company inbox keeps inbox_id NULL; a tenant inbox sets
-- inbox_id to a support_inboxes row (created by supportInboxStore). inbox_id is
-- a plain UUID with NO foreign key — supportInboxStore.initDB() may run after
-- this batch, so a FK would risk "relation support_inboxes does not exist".
-- Orphan cleanup on inbox delete is handled in the application layer.
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS inbox_id UUID;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS rfc822_message_id TEXT;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS provider_thread_id TEXT;
CREATE INDEX IF NOT EXISTS idx_support_threads_inbox ON support_threads(inbox_id, last_message_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_threads_provider_thread
    ON support_threads(inbox_id, provider_thread_id) WHERE provider_thread_id IS NOT NULL;

-- Email threading + idempotency on inbound/outbound messages.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS rfc822_message_id TEXT;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS email_references TEXT;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;
-- Idempotency: a provider message is recorded at most once per thread. Makes
-- inbound sync safe under History/delta overlap, retries, and crashes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_messages_provider_msg
    ON support_messages(thread_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
-- Fast reply-correlation lookup (In-Reply-To / References → our stored msg id).
CREATE INDEX IF NOT EXISTS idx_support_messages_rfc822
    ON support_messages(rfc822_message_id) WHERE rfc822_message_id IS NOT NULL;

-- iteration 6: unified audit log. Superset of support_thread_events that can
-- also hold inbox/config-level events (no thread) and distinguishes the precise
-- actor kind — 'ai' and 'automation' in addition to staff/system/requester.
-- All scope columns are nullable: config events have no thread; the company
-- inbox has no inbox_id. No FK (support_inboxes may init after this batch, same
-- rationale as support_threads.inbox_id). recordThreadEvent dual-writes here.
CREATE TABLE IF NOT EXISTS support_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    inbox_id UUID,
    thread_id UUID,
    actor_kind TEXT NOT NULL
        CHECK (actor_kind IN ('system','automation','ai','staff','requester')),
    actor_user_id TEXT,
    action TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip TEXT,
    ua TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_audit_org_created   ON support_audit_log(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_audit_inbox_created ON support_audit_log(inbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_audit_thread        ON support_audit_log(thread_id, created_at) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_audit_action        ON support_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_support_audit_actor_kind    ON support_audit_log(actor_kind);

-- iteration 7: ticket <-> YouTrack issue links, and the ticket reference.
--
-- The reference is what stands in for the customer everywhere outside this
-- inbox. Personal data does not leave Bee Flow except over email (CLAUDE.md ->
-- Security), so YouTrack and Google Chat get 'BF-2451' and a staff-only link;
-- who that is stays here. It is a column DEFAULT rather than something
-- createThread computes, so every insert path gets one -- including the sync
-- engine and anything added later that forgets to ask.
CREATE SEQUENCE IF NOT EXISTS support_ticket_ref_seq START 1000;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS ticket_ref TEXT;
ALTER TABLE support_threads ALTER COLUMN ticket_ref SET DEFAULT ('BF-' || nextval('support_ticket_ref_seq'));
UPDATE support_threads SET ticket_ref = 'BF-' || nextval('support_ticket_ref_seq') WHERE ticket_ref IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_threads_ref ON support_threads(ticket_ref);

-- Follow-up state: a linked issue moved and somebody owes the customer a word.
-- Set by the issue sync engine, cleared when an agent actually replies.
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS followup_needed_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS followup_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_support_threads_followup
    ON support_threads(followup_needed_at DESC) WHERE followup_needed_at IS NOT NULL;

-- THE MATCH. This table is the only place that knows a customer and a YouTrack
-- issue belong together, and it never leaves the product. Many-to-many by
-- construction: one ticket takes as many issues as it needs, one issue
-- collects every ticket that reported it. UNIQUE(thread_id, issue_id) is the
-- only limit, so re-linking is idempotent rather than an error.
--
-- The issue_* / last_comment_* columns are a SNAPSHOT the sync engine refreshes.
-- The ticket view reads them and never blocks on a third party being up.
CREATE TABLE IF NOT EXISTS support_issue_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    issue_id TEXT NOT NULL,
    issue_url TEXT,
    project_short_name TEXT,
    link_kind TEXT NOT NULL DEFAULT 'linked'
        CHECK (link_kind IN ('linked','created','escalated')),
    linked_by_user_id TEXT,
    link_reason TEXT,
    issue_summary TEXT,
    issue_state TEXT,
    issue_resolved BOOLEAN DEFAULT false,
    last_comment_text TEXT,
    last_comment_author TEXT,
    last_comment_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ,
    sync_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (thread_id, issue_id)
);
CREATE INDEX IF NOT EXISTS idx_support_issue_links_thread ON support_issue_links(thread_id);
CREATE INDEX IF NOT EXISTS idx_support_issue_links_issue  ON support_issue_links(issue_id);
CREATE INDEX IF NOT EXISTS idx_support_issue_links_stale  ON support_issue_links(synced_at NULLS FIRST);

-- BFSF-446: has this link recorded a comment baseline yet? A comment only
-- raises a follow-up on a link that already knew what the latest comment was;
-- until then a sync takes the baseline silently. Linking sets it when it could
-- read the issue, so existing links (false) get one quiet first tick instead
-- of a follow-up for every old comment.
ALTER TABLE support_issue_links ADD COLUMN IF NOT EXISTS comments_seeded BOOLEAN NOT NULL DEFAULT false;
`;

const initDB = makeStoreInit('SupportStore', _initDB);

async function _initDB() {
    try {
        await pool.query(INIT_SQL);
        // Widen the source CHECK to admit inbound 'email' (tenant Support inboxes).
        // Drop-then-add so it's idempotent across reboots; existing rows
        // ('in_app'/'marketing') satisfy the superset. Kept out of INIT_SQL
        // because a bare ADD CONSTRAINT would abort the whole batch on reboot.
        try {
            await pool.query(`ALTER TABLE support_threads DROP CONSTRAINT IF EXISTS support_threads_source_check`);
            await pool.query(`ALTER TABLE support_threads ADD CONSTRAINT support_threads_source_check
                              CHECK (source IN ('in_app','marketing','email'))`);
        } catch (cErr) {
            log.warn('[SupportStore] source CHECK widening error (safe on fresh DB):', cErr.message);
        }
        log.info('[SupportStore] PostgreSQL initialized');
    } catch (err) {
        log.error('[SupportStore] Init error:', err.message);
        throw err;
    }
}

module.exports = { initDB };
