/**
 * Support thread shapes. Columns come straight off the `support_threads` and
 * `support_messages` tables (server/stores/supportStore.js), so they are
 * snake_case.
 */

/**
 * `GET /api/support/threads/mine`. `status` is one of the six
 * CHECK-constrained values: open | ai_responding | awaiting_user |
 * awaiting_agent | resolved | closed.
 */
export interface SupportThread {
    id: string;
    subject: string;
    status: string;
    priority?: string;
    created_at: string;
    updated_at?: string;
    last_message_at?: string | null;
    ai_handled?: boolean;
    resolved_at?: string | null;
}

/** A row of `support_messages`. `author_kind` distinguishes the AI responder
 *  from a human agent — worth showing, since the first reply is usually AI. */
export interface SupportMessage {
    id: string;
    body: string;
    author_kind: string;
    author_display?: string | null;
    created_at: string;
}

/** `GET /api/support/threads/:id`. */
export interface SupportThreadDetail {
    thread: SupportThread;
    messages: SupportMessage[];
    viewerIsStaff: boolean;
}

/** `POST /api/support/threads`. */
export interface CreatedThread {
    ok?: boolean;
    threadId?: string | null;
}
