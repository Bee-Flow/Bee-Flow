/**
 * Migration: root_run_id on automation_runs — the JOURNEY identity (2026-08).
 *
 * A routine that pauses on a `form_page` (or an approval) is continued by
 * `resumeFromStep`, which starts a CHILD run linked by `parent_run_id`. That is
 * deliberate — the ancestor chain is how a resume replays what already ran, and
 * "does a child exist?" is how reapExpiredFormWaits proves a form was actually
 * submitted. But it means one visitor journey through a three-question form
 * lands in the owner's run history as FOUR rows, three of which say nothing but
 * "Resumed from the form — see child run …".
 *
 * `root_run_id` names the journey those rows belong to. Every run has one: a
 * fresh run is its own root, and a run that CONTINUES a pause inherits its
 * parent's. The history then lists roots only and reads each row's outcome off
 * the newest run in the journey.
 *
 * A CONTINUATION is not the only thing that sets parent_run_id. A retry of a
 * failed run does (webhooksAndRunOps' retry endpoint), and so does a partial
 * "▶ Execute from here" run, which parents itself onto the automation's most
 * recent live run. Those are separate attempts and must keep their own line in
 * the history. The runner tells them apart exactly: only resumeFromStep passes
 * a rootRunId, and only when the run it resumes was still awaiting_* — i.e.
 * actually paused mid-journey.
 *
 * The BACKFILL has no such status to read; those parents were finalised long
 * ago. It uses the marker the finalisers write into the parent's summary
 * ("Resumed from the form — see child run <id>" / "Resumed via approval — …"),
 * accepting a child that the marker NAMES, or one that at least shares the
 * parent's trigger kind — a parent that paused twice names only the last child
 * it handed off to, while a partial run adopted onto a form journey's parent
 * is 'manual' against the journey's 'form' and stays out.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill only touches rows
 * whose root is still NULL — guarded by an existence probe so a normal boot
 * does not build the recursive CTE at all.
 */

const { exec, run, getOne } = require('../db');

// How far back the backfill reconstructs journeys. Runs older than this are
// past the default run retention anyway, so they simply become their own root
// (see the safety net below) — which is exactly how they render today.
const BACKFILL_WINDOW = '90 days';

// Did `child` continue the run it names as its parent? `p` is the joined parent
// row, LEFT-joined in the base branch (so a parentless run answers FALSE).
const CONTINUES_PARENT = (child) => `(
    p.id IS NOT NULL
    AND p.summary IS NOT NULL
    AND p.summary LIKE 'Resumed %see child run%'
    AND (p.summary LIKE 'Resumed %see child run ' || ${child}.id
         OR ${child}.trigger_kind = p.trigger_kind)
)`;

async function up() {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS root_run_id TEXT`);
    // Every journey query asks for COALESCE(root_run_id, id) — rows written
    // before this column existed have to keep matching themselves — so the
    // index has to be on that expression. A plain index on root_run_id cannot
    // answer it. The trailing columns are the ORDER BY of the leaf lookup.
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_journey
                    ON automation_runs ((COALESCE(root_run_id, id)), started_at DESC, id DESC)`);
    // The history lists heads only, newest-first, per user.
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_user_heads
                    ON automation_runs (user_id, started_at DESC, id DESC)
                 WHERE root_run_id IS NULL OR root_run_id = id`);

    const pending = await getOne(`SELECT 1 AS x FROM automation_runs WHERE root_run_id IS NULL LIMIT 1`);
    if (!pending) {
        console.log('[Migration] automation-run-root-2026-08 applied');
        return;
    }

    // Walk the parent_run_id chain, but only across links that were a PAUSE
    // handoff. A run whose parent is not such a handoff (no parent at all, a
    // retry, a partial ▶ Execute — those set parent_run_id too) is itself the
    // head of a journey and seeds the recursion.
    //
    // CONTINUES_PARENT is the link test, and the two branches below must stay
    // exactly complementary — a row produced twice leaves `UPDATE … FROM`
    // picking between them arbitrarily.
    await run(`
        WITH RECURSIVE journey AS (
            SELECT r.id, r.id AS root
              FROM automation_runs r
              LEFT JOIN automation_runs p ON p.id = r.parent_run_id
             WHERE r.started_at > NOW() - INTERVAL '${BACKFILL_WINDOW}'
               AND NOT ${CONTINUES_PARENT('r')}
            UNION ALL
            SELECT c.id, j.root
              FROM automation_runs c
              JOIN journey j ON c.parent_run_id = j.id
              JOIN automation_runs p ON p.id = c.parent_run_id
             WHERE ${CONTINUES_PARENT('c')}
        )
        UPDATE automation_runs r
           SET root_run_id = j.root
          FROM journey j
         WHERE r.id = j.id
           AND r.root_run_id IS NULL
    `);
    // Safety net, and the thing that stops the probe above from re-running the
    // walk on every boot: anything the recursion did not reach — older than the
    // window, a broken parent link, a cycle — belongs to itself.
    const { rowCount } = await run(`UPDATE automation_runs SET root_run_id = id WHERE root_run_id IS NULL`);
    if (rowCount) console.log(`[Migration] automation-run-root-2026-08: ${rowCount} run(s) fell back to their own root`);

    console.log('[Migration] automation-run-root-2026-08 applied');
}

module.exports = { up };
