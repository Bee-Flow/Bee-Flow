/**
 * Migration: the approval DELIVERY LEDGER (2026-08).
 *
 * An approval card delivered OUTSIDE the app — a Nextcloud Talk message, a
 * Nextcloud notification — leaves a receipt somewhere we do not control. The
 * only thing that comes BACK is an event about that receipt: "someone reacted
 * 👍 to message 1567 in room a1b2c3d4". Nothing in it names an approval.
 *
 * This table is the map that makes such an event routable:
 *
 *      (channel, external_ref) ──→ approval_id
 *
 * Without it `talk.reaction.added` is a dead letter — which is exactly why it
 * ships in the same release as the card, not after it.
 *
 *   channel       'nc_talk'          a bot/chat message carrying the card
 *                 'nc_notification'  the passive bell (deep link, no buttons —
 *                                    INotification::addAction() is PHP-only,
 *                                    so no external service can put buttons in
 *                                    a Nextcloud notification)
 *   external_ref  the channel's own identifier for what it delivered:
 *                   nc_talk          {roomToken, messageId, referenceId, via}
 *                   nc_notification  {ncUid, apiVersion}
 *                 JSONB rather than columns because the two channels have
 *                 nothing in common but "an id on someone else's server", and
 *                 a third channel would otherwise mean a third migration.
 *   stage         which stage the card announced. A five-stage chain posts a
 *                 card per stage, and a 👍 must be counted against the stage
 *                 it was asked for, never the one that happens to be current.
 *   status/error  'sent' | 'failed' — the ATTEMPT is recorded either way.
 *                 dispatchRunNotification is fire-and-forget (no queue, no
 *                 retry, no dead letter), so a row that says `failed` is the
 *                 only evidence a Nextcloud outage swallowed a card.
 *
 * The unique index over (roomToken, messageId) is the routing key AND the
 * dedupe guard: one Talk message belongs to exactly one approval, so a replayed
 * reaction webhook resolves to the same row and the decision path's own
 * one-decision-ever conditional UPDATE absorbs the repeat.
 *
 * Rows with no message id are kept deliberately: a bot-posted card cannot
 * learn its own message id (POST /bot/{token}/message answers `201` with an
 * empty body — verified in spreed's BotController::sendMessage), so when the
 * id lookup fails the delivery still happened and still carries a deep link;
 * it simply cannot count reactions. The partial index lets those rows exist
 * without fighting each other for the unique key.
 *
 * ON DELETE CASCADE from automation_approvals: the ledger is evidence about a
 * row, worthless once the row is gone.
 *
 * Idempotent throughout.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_approval_deliveries (
            id              TEXT PRIMARY KEY,
            approval_id     TEXT NOT NULL REFERENCES automation_approvals(id) ON DELETE CASCADE,
            stage           TEXT,
            channel         TEXT NOT NULL,
            organization_id TEXT,
            external_ref    JSONB NOT NULL DEFAULT '{}'::jsonb,
            user_id         TEXT,
            nc_uid          TEXT,
            status          TEXT NOT NULL DEFAULT 'sent',
            error           TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // Tolerate a table created by an earlier revision of this file.
    await exec(`
        ALTER TABLE automation_approval_deliveries
            ADD COLUMN IF NOT EXISTS stage           TEXT,
            ADD COLUMN IF NOT EXISTS organization_id TEXT,
            ADD COLUMN IF NOT EXISTS user_id         TEXT,
            ADD COLUMN IF NOT EXISTS nc_uid          TEXT,
            ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'sent',
            ADD COLUMN IF NOT EXISTS error           TEXT;
    `);

    // THE routing key: one Talk message ↔ one approval. Partial, because a
    // card whose message id could not be recovered still deserves a row.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_appr_deliv_talk_msg
                    ON automation_approval_deliveries
                       ((external_ref->>'roomToken'), (external_ref->>'messageId'))
                 WHERE channel = 'nc_talk' AND external_ref->>'messageId' IS NOT NULL`);

    // "What did we send for this approval, and did it land?" — the reminder
    // sweep's re-delivery question and the support answer to "they say they
    // never got it".
    await exec(`CREATE INDEX IF NOT EXISTS idx_appr_deliv_approval
                    ON automation_approval_deliveries (approval_id, created_at)`);

    console.log('[Migration] approvals-deliveries-2026-08 applied');
}

module.exports = { up };
