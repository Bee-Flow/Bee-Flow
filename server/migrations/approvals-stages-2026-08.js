/**
 * Migration: approval STAGES — an ordered chain of up to five (2026-08).
 *
 * Panels made the decider plural; this makes the decision SEQUENTIAL. An
 * approval can now carry an ordered list of named stages — "Cost-centre
 * check" → "Finance sign-off" → "Board" — each with its own approvers and
 * its own rule (all / first / quorum), each announced to its own people only
 * when its turn arrives.
 *
 * The design trick that makes this a pure add-and-backfill: EVERY STAGE
 * CARRIES ITS OWN KEY, and the rows that exist today are backfilled with the
 * keys 'panel' and 'final' — exactly the two literals the v2 panel code
 * already writes into automation_approval_votes.stage. So:
 *
 *   • the votes table needs NO migration — not one row is rewritten;
 *   • both partial-unique indexes (one vote per seat, one per person per
 *     stage) keep their exact meaning, and therefore so does every race
 *     guard built on them;
 *   • advanceApprovalStage already takes {from, to} and works unchanged.
 *
 * Every lookup becomes "find the stage whose key === approval.stage" — never
 * index arithmetic against a literal, so a chain of five reads the same way
 * as the legacy chain of two.
 *
 *   approval_stages     ordered array, 1..5. Element shape:
 *                       { key, name, description, approvers[], rule, quorum,
 *                         skipped? }  — `skipped` marks a stage whose `when`
 *                       condition was false at request time. Skipped stages
 *                       are KEPT rather than dropped: "why did this never go
 *                       to finance?" is an audit question, and a silently
 *                       absent stage cannot answer it.
 *   stage_participants  a flat, de-duplicated seat index across ALL stages.
 *                       Exists so the viewer-scope WHERE stays ONE indexable
 *                       scan instead of a nested jsonb_array_elements over
 *                       stages × seats (which no index can serve).
 *   stage_entered_at    when the CURRENT stage began — the per-stage clock
 *                       reminders are re-armed from.
 *
 * Rows with no panel (a plain single assignee) keep approval_stages NULL and
 * are left exactly as they are: hasPanel() stays false for them and the
 * non-panel decide branch never enters the stage engine. Deliberate — there
 * is nothing to gain from forcing every legacy row through it.
 *
 * The five panel-era columns (approvers, approval_rule, quorum_count,
 * final_approver_*) become WRITE-THROUGH LEGACY MIRRORS: creation keeps
 * populating them from the first (and, when there are exactly two, the last)
 * stage, so any read path, support query or export not yet migrated still
 * works. They are deprecated, not dead; they go in a later release once
 * nothing reads them.
 *
 * Idempotent throughout.
 */

const { exec } = require('../db');

/** Product cap. Mirrored by MAX_APPROVAL_STAGES in automation/approvalStages.js. */
const MAX_STAGES = 5;

async function up() {
    await exec(`
        ALTER TABLE automation_approvals
            ADD COLUMN IF NOT EXISTS approval_stages    JSONB,
            ADD COLUMN IF NOT EXISTS stage_participants JSONB,
            ADD COLUMN IF NOT EXISTS stage_entered_at   TIMESTAMPTZ;
    `);

    // ── Backfill (a): the two-stage panel → final rows ───────────────────
    // Keys 'panel' and 'final' are the literals the votes table already
    // carries, so existing votes keep pointing at the right stage.
    await exec(`
        UPDATE automation_approvals SET approval_stages = jsonb_build_array(
            jsonb_build_object(
                'key', 'panel', 'name', 'Approval', 'description', NULL,
                'approvers', approvers,
                'rule', COALESCE(approval_rule, 'all'),
                'quorum', quorum_count),
            jsonb_build_object(
                'key', 'final', 'name', 'Final sign-off', 'description', NULL,
                'approvers', CASE
                    WHEN final_approver_user_id IS NOT NULL
                        THEN jsonb_build_array(jsonb_build_object('userId', final_approver_user_id))
                    ELSE jsonb_build_array(jsonb_build_object('groupId', final_approver_group_id))
                END,
                'rule', 'first', 'quorum', NULL))
         WHERE approvers IS NOT NULL
           AND approval_stages IS NULL
           AND (final_approver_user_id IS NOT NULL OR final_approver_group_id IS NOT NULL)
    `);

    // ── Backfill (b): single-stage panel rows ───────────────────────────
    await exec(`
        UPDATE automation_approvals SET approval_stages = jsonb_build_array(
            jsonb_build_object(
                'key', 'panel', 'name', 'Approval', 'description', NULL,
                'approvers', approvers,
                'rule', COALESCE(approval_rule, 'all'),
                'quorum', quorum_count))
         WHERE approvers IS NOT NULL
           AND approval_stages IS NULL
           AND final_approver_user_id IS NULL
           AND final_approver_group_id IS NULL
    `);

    // ── Backfill (c): the participant index + the stage clock ───────────
    await exec(`
        UPDATE automation_approvals a SET stage_participants = (
            SELECT jsonb_agg(DISTINCT seat)
              FROM jsonb_array_elements(a.approval_stages) st,
                   jsonb_array_elements(st->'approvers') seat)
         WHERE a.approval_stages IS NOT NULL
           AND a.stage_participants IS NULL
    `);
    await exec(`
        UPDATE automation_approvals SET stage_entered_at = COALESCE(updated_at, created_at)
         WHERE approval_stages IS NOT NULL AND stage_entered_at IS NULL
    `);

    // One indexable scan for "is this viewer a participant anywhere in the
    // chain" — jsonb_path_ops because every query is a containment test.
    await exec(`CREATE INDEX IF NOT EXISTS idx_approvals_stage_participants
                    ON automation_approvals USING GIN (stage_participants jsonb_path_ops)`);

    // NOT VALID keeps the boot migration off a full-table scan; the separate
    // VALIDATE below takes only a SHARE UPDATE EXCLUSIVE lock and is safe to
    // re-run (it is a no-op once the constraint is validated).
    await exec(`ALTER TABLE automation_approvals DROP CONSTRAINT IF EXISTS approvals_stage_count`);
    await exec(`ALTER TABLE automation_approvals ADD CONSTRAINT approvals_stage_count
                    CHECK (approval_stages IS NULL
                        OR (jsonb_typeof(approval_stages) = 'array'
                            AND jsonb_array_length(approval_stages) BETWEEN 1 AND ${MAX_STAGES}))
                    NOT VALID`);
    try {
        await exec(`ALTER TABLE automation_approvals VALIDATE CONSTRAINT approvals_stage_count`);
    } catch (e) {
        // A pre-existing row outside the cap must not stop the server booting;
        // the constraint still guards every INSERT and UPDATE from here on.
        console.warn(`[Migration] approvals-stages-2026-08: constraint left NOT VALID (${e.message})`);
    }

    console.log('[Migration] approvals-stages-2026-08 applied');
}

module.exports = { up, MAX_STAGES };
