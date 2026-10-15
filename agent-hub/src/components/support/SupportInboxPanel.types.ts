/**
 * The shapes the support inbox reads off /api/support/*. Only the fields the
 * panel itself touches are named; the server sends more.
 */

export interface SupportThread {
    id: string;
    status: string;
    priority: string;
    subject: string;
    source?: string;
    category?: string | null;
    requester_name?: string | null;
    requester_email: string;
    requester_org_role?: string | null;
    requester_org_name?: string | null;
    last_message_at: string | null;
    first_response_at?: string | null;
    csat_score?: number | null;
    tags?: string[] | null;
    ai_handled?: boolean | null;
    ai_escalated_reason?: string | null;
    followup_needed_at?: string | null;
    followup_reason?: string | null;
    sla_first_response_due_at?: string | null;
    sla_resolution_due_at?: string | null;
    sla_first_response_breached_at?: string | null;
    sla_resolution_breached_at?: string | null;
    sla_paused?: boolean | null;
}

export interface SupportMessage {
    id: string;
    author_kind: string;
    author_display?: string | null;
    internal_note?: boolean | null;
    created_at: string;
    body?: string | null;
    body_html?: string | null;
    email_send_status?: { ok?: boolean; error?: string } | null;
    kb_citations?: { title?: string }[] | null;
}

export interface SupportEvent {
    id: string;
    created_at: string;
    actor_kind: string;
    actor_user_id?: string | null;
    action: string;
    payload?: Record<string, unknown> | null;
}

export interface CannedResponse {
    id: string;
    title: string;
    shortcut?: string | null;
    body: string;
    organization_id?: string | null;
}

export interface SupportMailbox {
    connected?: boolean;
    count?: number;
    activeCount?: number;
    lastAt?: string | null;
}

export type ThreadPatch = Partial<Pick<SupportThread, 'status' | 'priority' | 'tags'>>;

export interface SlaBadgeProps {
    thread: SupportThread;
}

export interface TagChipsProps {
    tags?: string[] | null;
    onRemove?: (tag: string) => void;
}

export interface CsatStarsProps {
    score?: number | null;
}

export interface SupportInboxPanelProps {
    focusThreadId?: string | null;
}
