/**
 * One DSR request as the register lists it (GET /api/dsr/requests, routes/dsr.js
 * `listRow` over the dsr_requests columns of stores/dsrStore.js). The readers in
 * dsrArticles.js tolerate both spellings of the clock columns, so every field is
 * optional; `state` is the server's CLOCK (ok · urgent · overdue · none).
 */
export type DsrRow = {
    id: number | string;
    request_type?: string | null;
    subject_email?: string | null;
    subject_email_masked?: string | null;
    status?: string | null;
    state?: string | null;
    channel?: string | null;
    identity_status?: string | null;
    identity_verified_at?: string | null;
    notes?: string | null;
    result_summary?: string | null;
    created_at?: string | null;
    received_at?: string | null;
    due_at?: string | null;
    extended_until?: string | null;
    started_at?: string | null;
};
