// Shapes the Support settings tabs share (the support-inbox endpoints' rows).

export interface SupportInbox {
    id: string;
    provider?: string;
    display_name?: string;
    email_address?: string;
    organization_id?: string | null;
    connected?: boolean;
    default_agent_id?: string | null;
    kb_ids?: string[];
    kb_ingest_enabled?: boolean;
    kb_ingest_kb_id?: string | null;
    kb_ingest_automation_id?: string | null;
    reply_mode?: string;
    autoresolve_threshold?: number;
    signature?: string;
    enabled_tool_ids?: string[];
    tools_enabled?: boolean;
    operator_user_id?: string | null;
    classify_non_support_enabled?: boolean;
    classify_sensitivity?: number;
    classify_suppress_autoreply?: boolean;
}

export interface SupportAgent {
    id: string;
    name?: string;
}

export interface SupportKb {
    id: string;
    name?: string;
    organization_id?: string | null;
}

export interface SupportTeammate {
    id: string;
    name?: string;
    email?: string;
}

/** The signed-in user fields the Support screens read. */
export interface SupportUser {
    id?: string;
    isAdmin?: boolean;
    role?: string;
    orgRole?: string;
    permissions?: string[];
}

export interface SupportThread {
    id: string;
    status: string;
    priority?: string | null;
    assignee_user_id?: string | null;
    subject?: string | null;
    requester_email?: string | null;
    tags?: string[];
    csat_score?: number | null;
    csat_comment?: string | null;
    sla_first_response_breached_at?: string | null;
    sla_resolution_breached_at?: string | null;
}

export interface SupportMessage {
    id: string;
    author_kind?: string;
    author_display?: string | null;
    body?: string;
    body_html?: string | null;
    internal_note?: boolean;
    email_send_status?: { state?: string; ok?: boolean } | null;
    attachments?: { filename?: string; mime?: string }[];
    kb_citations?: { title?: string; score?: number }[];
}
