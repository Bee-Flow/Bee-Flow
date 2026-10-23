import type { SupportUser } from './supportStudio.types';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/** One ticket, as the list and the open conversation read it. */
export interface SupportThread {
    id: string;
    status: string;
    subject?: string | null;
    requester_email?: string | null;
    priority?: string | null;
    assignee_user_id?: string | null;
    tags?: string[];
    csat_score?: number | null;
    csat_comment?: string | null;
    sla_first_response_breached_at?: string | null;
    sla_resolution_breached_at?: string | null;
}

/** One message of a ticket. */
export interface SupportMessage {
    id: string;
    author_kind: string;
    author_display?: string | null;
    body?: string | null;
    body_html?: string | null;
    internal_note?: boolean;
    email_send_status?: { state?: string; ok?: boolean } | null;
    attachments?: Array<{ filename?: string; mimeType?: string }> | null;
    kb_citations?: Array<{ title?: string; score?: number | string | null }> | null;
}

/** What the "Customer" strip shows about the person who wrote in. */
export interface TicketContext {
    profile?: { name?: string; organizationName?: string; orgRole?: string; loggedIn?: boolean } | null;
    subscription?: { status?: string; planName?: string; planTier?: string } | null;
    recentThreads?: Array<{ subject?: string | null; status: string }>;
}

export interface DotProps {
    status: string;
}

/**
 * SupportStudio — tenant customer-support inbox inside the Studio.
 * Backend: /api/support-inbox/* (support_inbox license + beta + permission).
 */
/**
 * @param {string} [initialTicketId] Open this thread on mount instead of the
 *   "Select a ticket" pane. Same seam SkillsStudio, KBsStudio, AgentStudio and
 *   NotebooksPage already expose (`initialSkillId`, `initialKbId`, …) — it is
 *   how a deep link, and the public demo, land on something worth reading
 *   rather than on an empty right-hand pane.
 */
export interface SupportStudioProps {
    user: SupportUser | null;
    initialTicketId?: string | null;
}

export interface EmptyStateProps {
    hasConnected: boolean;
    onSettings: () => void;
}

export interface TicketDetailProps {
    user?: SupportUser | null;
    threadId: string;
    onChanged: () => Promise<void>;
    autoRefreshMs?: number;
}

export interface MessageBubbleProps {
    m: SupportMessage;
    t: TranslateFn;
}
