// @typecheck strict
/**
 * The columns of `cowork_runs` for the review queue and the per-run activity (2026-11), as idempotent boot DDL that
 * stores/coworkStore.js applies through runDdl with its other run columns.
 */

const RUN_COLUMNS = Object.freeze([
    // The conversation this run wrote into (an agent run): the run opens it, and a
    // follow-up continues in it. Each mail run has its own, so the schedule's
    // single conversation_id cannot say which one a run used.
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS conversation_id TEXT`,
    // A run the agent asked a person to review (cowork_request_review,
    // core/cowork/reviewTool.mts) closes as status 'needs_review' with these:
    // the agent's reason, its question and its summary of what it did; and,
    // once the item's owner handled it, how ('answered' | 'done_myself' |
    // 'not_needed'), by whom and when. Those stay in the history.
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS review_reason TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS review_question TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS review_summary TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS review_resolution TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS review_resolved_by TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS review_resolved_at TIMESTAMPTZ`,
    // An answered review starts a follow-up run: its parent, and how many answers
    // deep it is (COWORK_REVIEW_MAX_FOLLOWUPS caps that).
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT`,
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS followup_depth INTEGER NOT NULL DEFAULT 0`,
    // What the run did, in names, outcomes and counts only (core/cowork/runActivity.mts):
    // the tools it called and how each ended, the skills that took part. Never
    // tool arguments, mail text, names or addresses.
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS activity_json TEXT`,
    // What a follow-up needs to run under the same policy, server-side only (never in
    // the API): the tool names the run was offered, whether it was unattended, and
    // for a mail run the provider, message, thread and mailbox ids (no addresses).
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS run_context_json TEXT`,
    // The subject of the mail that started a mail run, for the review queue.
    `ALTER TABLE cowork_runs ADD COLUMN IF NOT EXISTS mail_subject TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_cowork_runs_open_review ON cowork_runs(schedule_id)
        WHERE status = 'needs_review' AND review_resolved_at IS NULL`,
]);

module.exports = { RUN_COLUMNS };
