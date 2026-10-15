// Shapes the Support settings tabs share (the support-inbox endpoints' rows).

export interface SupportInbox {
    id: string;
    provider?: string;
    display_name?: string | null;
    email_address?: string | null;
    organization_id?: string | null;
    connected?: boolean;
    default_agent_id?: string | null;
    kb_ids?: string[] | null;
    kb_ingest_enabled?: boolean;
    kb_ingest_kb_id?: string | null;
    kb_ingest_automation_id?: string | null;
    reply_mode?: string;
    autoresolve_threshold?: number | string | null;
    signature?: string | null;
    enabled_tool_ids?: string[];
    tools_enabled?: boolean;
    operator_user_id?: string | null;
    classify_non_support_enabled?: boolean;
    classify_sensitivity?: number | string | null;
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
    name?: string | null;
    email?: string | null;
}

/** The signed-in user fields the Support screens read. */
export interface SupportUser {
    id?: string;
    isAdmin?: boolean;
    role?: string;
    orgRole?: string;
    permissions?: string[];
}
