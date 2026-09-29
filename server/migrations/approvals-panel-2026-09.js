/**
 * Migration: approval PANELS — multiple approvers, decision rules, and an
 * optional final sign-off stage (2026-09).
 *
 * V2 made the approval row source-agnostic; this makes the DECIDER plural.
 * A row may now carry a panel:
 *
 *   approvers      JSONB [ {userId} | {groupId}, … ]  — the SEATS (≤ 10).
 *                  A group seat is filled by whichever member votes first.
 *                  NULL = the v1/v2 single-assignee behaviour, byte-for-byte.
 *   approval_rule  'all'    every seat must approve; ONE reject declines
 *                           immediately (the requester hears fast, the rest
 *                           are stood down).
 *                  'first'  the first vote decides for the whole panel.
 *                  'quorum' approved at quorum_count approvals; declined the
 *                           moment quorum_count can no longer be reached.
 *   quorum_count   N for rule 'quorum'.
 *   stage          'panel' → collecting votes; 'final' → the panel passed and
 *                  the designated final approver has the last word. NULL =
 *                  no stages (legacy single-assignee rows). The row's STATUS
 *                  stays 'pending' through both stages — terminal statuses
 *                  and everything that hangs off them (resume, events, hooks)
 *                  fire exactly once, at the end.
 *   final_approver_user_id / final_approver_group_id
 *                  the optional second stage's decider.
 *
 * Votes live in their own append-only table — a vote is evidence, the row's
 * decided_* columns stay the terminal VERDICT. Two partial-unique indexes are
 * the concurrency story: one vote per SEAT and one vote per PERSON per stage,
 * so two members of the same group racing produces exactly one seat vote and
 * the loser gets a clean 409, never a double count.
 *
 * Idempotent throughout.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        ALTER TABLE automation_approvals
            ADD COLUMN IF NOT EXISTS approvers              JSONB,
            ADD COLUMN IF NOT EXISTS approval_rule          TEXT,
            ADD COLUMN IF NOT EXISTS quorum_count           INT,
            ADD COLUMN IF NOT EXISTS stage                  TEXT,
            ADD COLUMN IF NOT EXISTS final_approver_user_id  TEXT,
            ADD COLUMN IF NOT EXISTS final_approver_group_id TEXT;
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_approval_votes (
            id TEXT PRIMARY KEY,
            approval_id TEXT NOT NULL REFERENCES automation_approvals(id) ON DELETE CASCADE,
            stage TEXT NOT NULL DEFAULT 'panel',
            seat_index INT,
            voter_id TEXT NOT NULL,
            voter_name TEXT,
            decision TEXT NOT NULL,
            reason TEXT,
            answers JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_votes_seat
                    ON automation_approval_votes (approval_id, stage, seat_index)
                 WHERE seat_index IS NOT NULL`);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_votes_voter
                    ON automation_approval_votes (approval_id, stage, voter_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approval_votes_approval
                    ON automation_approval_votes (approval_id, created_at)`);

    console.log('[Migration] approvals-panel-2026-09 applied');
}

module.exports = { up };
