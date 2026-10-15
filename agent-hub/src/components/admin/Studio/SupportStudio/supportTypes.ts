// Shapes the Support studio's tabs share: the inbox list, the teammates and
// agents they pick from, and the audit rows. They describe what the
// /api/support-inbox/* and /agents/all responses carry, only as far as the
// Studio screens read them.

import type { AuditEvent } from './auditMeta';

/** A connected mailbox (GET /api/support-inbox/inboxes). */
export interface SupportInbox {
    id: string;
    email_address?: string | null;
    display_name?: string | null;
    provider?: string | null;
    organization_id?: string | null;
    kb_ingest_enabled?: boolean | null;
    kb_ingest_kb_id?: string | null;
    kb_ingest_automation_id?: string | null;
    connected?: boolean | null;
    default_agent_id?: string | null;
    kb_ids?: string[] | null;
    reply_mode?: string | null;
    autoresolve_threshold?: number | null;
    signature?: string | null;
    enabled_tool_ids?: string[] | null;
    tools_enabled?: boolean | null;
    operator_user_id?: string | null;
    classify_non_support_enabled?: boolean | null;
    classify_sensitivity?: number | null;
    classify_suppress_autoreply?: boolean | null;
}

/** An AI agent the inbox can reply with (GET /agents/all). */
export interface SupportAgent {
    id: string;
    name: string;
}

/** A knowledge base the ingestion picker offers. */
export interface SupportKb {
    id: string;
    name: string;
    organization_id?: string | null;
}

/** A teammate the ticket assignee picker offers. */
export interface SupportTeammate {
    id: string;
    name?: string | null;
    email?: string | null;
}

/** One row of GET /api/support-inbox/audit, or /threads/:id/events. */
export interface SupportAuditEvent extends AuditEvent {
    id: string;
    created_at: string;
    inbox_id?: string | null;
    thread_id?: string | null;
    actor_user_id?: string | null;
}

/** A ticket in the list and the open conversation header (GET /threads). */
export interface SupportThread {
    id: string;
    subject?: string | null;
    requester_email?: string | null;
    status: string;
    priority?: string | null;
    assignee_user_id?: string | null;
    tags?: string[] | null;
    sla_first_response_breached_at?: string | null;
    sla_resolution_breached_at?: string | null;
    csat_score?: number | null;
    csat_comment?: string | null;
}

/** One message of a conversation (GET /threads/:id). */
export interface SupportMessage {
    id: string;
    author_kind?: string | null;
    author_display?: string | null;
    body?: string | null;
    body_html?: string | null;
    internal_note?: boolean | null;
    email_send_status?: { state?: string; ok?: boolean } | null;
    attachments?: { filename?: string | null; mimeType?: string | null }[] | null;
    kb_citations?: { title?: string | null; score?: number | null }[] | null;
}

/** A tag in the palette (GET /tags). */
export interface SupportTagItem {
    id?: string;
    name: string;
    color?: string | null;
}

/** A canned reply template. */
export interface CannedReply {
    id: string;
    title: string;
    body: string;
    shortcut?: string | null;
    organization_id?: string | null;
}

/** The customer context panel (GET /threads/:id/context). */
export interface SupportContext {
    profile?: { name?: string | null; organizationName?: string | null; orgRole?: string | null; loggedIn?: boolean | null } | null;
    subscription?: { status?: string | null; planName?: string | null; planTier?: string | null } | null;
    recentThreads?: { subject?: string | null; status?: string | null }[] | null;
}

/** The signed-in user, as far as the Support tabs read it. */
export interface SupportUser {
    id?: string;
    isAdmin?: boolean;
    orgRole?: string | null;
    role?: string | null;
    permissions?: readonly string[] | null;
}
