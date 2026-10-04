/**
 * Migration: automation_run_steps.input_json / output_json and
 * automation_runs.trigger_payload from JSONB to JSON.
 *
 * JSONB does not keep the order of an object's keys: it stores them sorted
 * (shorter key first, then bytewise). A code step that returned
 * `{ sku, qty, price }` came back from the database as `{ qty, sku, price }`,
 * and everything that rebuilds runState from these rows saw the reordered
 * copy: "Execute step" in the editor (replay seeding), a run resuming after an
 * approval or a form page, the run history's Input/Output panels. A
 * notification that interpolated that object then delivered
 * `[{"qty":2,"sku":"A1",...}]` — not what the author wrote.
 *
 * JSON keeps the text exactly as it was inserted, so the order the step
 * produced survives the round trip. Nothing queries inside these columns (they
 * are only ever read whole, and node-postgres parses json and jsonb alike),
 * and neither is indexed. The trigger payload is the same story one table up:
 * a form's answers or a webhook body came back in sorted order on a resume or
 * a replay. Its one query that looks inside (the run search,
 * stores/automationStore/runListing.js) casts to jsonb at query time. Rows written before this migration were already
 * sorted when they were stored; that order cannot be recovered, so they stay
 * as they are.
 *
 * Idempotent and probe-only after the first run: every boot replays the
 * migration list, so the ALTER only runs while a column is still jsonb. The
 * table is rewritten once (ACCESS EXCLUSIVE for the duration), which on a
 * large run history is the cost of the fix.
 */

/** `exec` is injectable so a test can run the real SQL against an in-process Postgres. */
async function up({ exec = (sql) => require('../db').exec(sql) } = {}) {
    await exec(`
        DO $$
        DECLARE target TEXT[];
        BEGIN
            FOREACH target SLICE 1 IN ARRAY ARRAY[
                ['automation_run_steps', 'input_json'],
                ['automation_run_steps', 'output_json'],
                ['automation_runs', 'trigger_payload']
            ] LOOP
                IF to_regclass('public.' || target[1]) IS NULL THEN CONTINUE; END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public'
                       AND table_name = target[1]
                       AND column_name = target[2]
                       AND data_type = 'jsonb'
                ) THEN
                    EXECUTE format(
                        'ALTER TABLE %I ALTER COLUMN %I TYPE JSON USING %I::json',
                        target[1], target[2], target[2]
                    );
                END IF;
            END LOOP;
        END $$;
    `);
    console.log('[Migration] automation-run-step-json-order-2026-10 applied');
}

module.exports = { up };
