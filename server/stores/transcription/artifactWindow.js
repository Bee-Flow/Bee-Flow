// @typecheck strict
/**
 * The SQL for the three artifact columns (action_items / decisions /
 * questions) of a regeneration: the database clock and the windowed merge
 * updateTranscription writes them with.
 */

/**
 * ── THE WINDOW OF A REGENERATION (M4) ────────────────────────────────
 *
 * "Regenerate" reads the note, then talks for minutes with a model and only then
 * writes. The merge in core/meetingNotes/actionItems.js protects what a person has
 * written down — but only rows that were in that SNAPSHOT. Whoever in the meantime
 * records a line as a decision in the transcript tab (the "Regenerate" banner sits
 * above that tab) writes in precisely that window: for the merge that row is
 * invisible, and the landing update wipes it. No notice, no undo — and the response
 * then neatly shows the reality in which the row has just disappeared. The same
 * goes for an existing item that someone CHECKS OFF or retypes in that window: the
 * merge ran against a snapshot from before that tick.
 *
 * The answer to that does NOT belong in the route: it knows nothing about what
 * happened after its read. It belongs in the SQL of the write action, because that
 * is where the column's current state is visible. The rule is: replace only what
 * was already there before the starting point of the run; whatever came into
 * existence or CHANGED after it stays.
 *
 * ── ONE CLOCK ────────────────────────────────────────────────────────
 * Both the starting point (`readAt`, passed in by getTranscription) and the
 * `createdAt`/`touchedAt` of each artifact row come from `NOW()` of THIS database.
 * Node's clock does not come into it, nor does the client's: two clocks that
 * differ by milliseconds would decide the wrong way precisely at the edges of this
 * window. Hence one fixed, lexicographically comparable format instead of a cast
 * that might fall over on an odd value.
 *
 * IN MICROSECONDS, NOT IN MILLISECONDS. Postgres's `NOW()` runs in microseconds,
 * and this format dropped three digits (it was identical to JS' toISOString). Two
 * transactions in the same millisecond then got the same stamp, and `>` makes equal
 * into "before the run": a tick that landed in the same millisecond as the read of
 * "Regenerate" was silently overwritten. With the full clock, equal now practically
 * only means: the same transaction (NOW() is the start of it).
 * Stamps from before this line still carry three digits ("…12.345Z"). Against a new
 * one that only compares differently if the time falls in the same millisecond, and
 * an old stamp and a new read are at least one deploy apart.
 *
 * NO OPTIMISTIC LOCK. A version check would refuse the whole write action because
 * something somewhere changed; that turns a successful run of minutes into an error
 * message. A timestamp per row says exactly enough.
 */
const DB_CLOCK_ISO = `to_char(NOW() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// The stamp for a row that is already in the column but does not carry one yet:
// written before this line existed, by the bare UPDATE of /reprocess, or by the
// INSERT of an auto-import. Same clock, same format.
//
// IT WAS `updated_at` HERE, AND THAT WIDENED. `updated_at` is the moment of the
// previous write action on the NOTE, and that falls AFTER the starting point of a
// running run as soon as anything else was written to the row during that run
// (patching a title, renaming a speaker, the audio backfill job). An unstamped AI
// row then got a stamp INSIDE the window and survived as "created during the run" —
// exactly the row that "Regenerate" should replace, and the user saw old AI items
// come back.
//
// `created_at` is the creation moment of the NOTE. That lies by definition before
// every read of that row, and so before every possible starting point, and it never
// moves again. A row without a stamp cannot be proven newer than the starting point,
// and therefore counts guaranteed as old — the side where the ordinary merge rule
// applies, which already protects a person's rows.
const ROW_UNSTAMPED_ISO = `to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Een JSON-scalar in een array-kolom telt als leeg — zelfde regel als parseJsonArray.
 * @param {string} expr
 */
function jsonbArrayOf(expr) {
    return `CASE WHEN jsonb_typeof(${expr}) = 'array' THEN ${expr} ELSE '[]'::jsonb END`;
}

/**
 * The content of one artifact row WITHOUT the two stamps.
 *
 * This answers the question "has this row actually changed": the stamps themselves
 * do not count, otherwise every rewrite would report itself as a change. A row that
 * is not an object passes untouched — it cannot handle the `- 'key'` operator, and
 * "unknown" should end here as "changed" (narrowing: the row then counts as touched
 * during the run).
 * @param {string} expr
 */
function artifactRowBody(expr) {
    return `(CASE WHEN jsonb_typeof(${expr}) = 'object'
                  THEN (${expr}) - 'createdAt' - 'touchedAt' ELSE ${expr} END)`;
}

/**
 * The SET expression for one artifact column (action_items / decisions / questions).
 *
 * ── TWO STAMPS, ONE QUESTION ────────────────────────────────────────
 *   createdAt  when this row CAME INTO EXISTENCE (stays when rewritten).
 *   touchedAt  when this row last CHANGED in content.
 * Both from the database clock, both unreachable for the client: whatever comes in
 * is overwritten here.
 *
 * Three parts, in one statement so that no window remains between reading and
 * writing:
 *   1. If there is a row with the SAME id in the column that was touched after the
 *      starting point of the run, THAT row wins and what the writer sends is ignored.
 *   2. Otherwise: what the writer sends, with the stamps above.
 *   3. Only if there is a starting point: everything that is in the column at this
 *      moment and was touched AFTER that starting point, and is not already in (1)/(2).
 *
 * ── WHY PART 1 EXISTS ───────────────────────────────────────────────
 * Part 3 only saves rows that were CREATED during the run. An existing AI item that
 * someone CHECKS OFF during that same run keeps its old `createdAt` and simply sits
 * in the fresh list — both conditions of part 3 fail, so the minutes-old snapshot of
 * the merge overwrote the check again. That is the same finding, just in a different
 * order: the merge protects human input from before the read, this part protects
 * human input from during the run.
 *
 * The whole stored row wins, not a few fields of it: which field a person touched
 * cannot be seen here, and losing a fresh timestamp or assignee on one row does not
 * weigh against silently undoing a check or a correction. The next regeneration
 * refreshes it anyway.
 * @param {string} column
 * @param {string} valuePh
 * @param {string | null} sincePh
 */
function artifactColumnSql(column, valuePh, sincePh) {
    const stored = jsonbArrayOf(column);
    const now = `to_jsonb(${DB_CLOCK_ISO})`;
    const unstamped = `to_jsonb(${ROW_UNSTAMPED_ISO})`;
    // "This row was touched after the starting point of the run." Without a starting
    // point there is no window and the answer is always no. A row without a stamp
    // gives NULL and therefore also no — unknown narrows.
    /**
     * @param {string} expr
     */
    const touchedDuringTheRun = (expr) => (sincePh ? `(${expr})->>'touchedAt' > ${sincePh}::text` : 'false');
    const keptFromTheRun = sincePh ? `
                UNION ALL
                SELECT kept AS item, 1000000 + k.n AS ord
                  FROM jsonb_array_elements(${stored}) WITH ORDINALITY AS k(kept, n)
                 WHERE ${touchedDuringTheRun('kept')}
                   AND NOT EXISTS (
                       SELECT 1 FROM jsonb_array_elements(${valuePh}::jsonb) AS f(fresh)
                        WHERE fresh->>'id' = kept->>'id')` : '';
    return `(SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb) FROM (
                SELECT CASE
                         WHEN prev IS NOT NULL AND ${touchedDuringTheRun('prev')} THEN prev
                         ELSE e || jsonb_build_object(
                             'createdAt', COALESCE(prev->'createdAt',
                                 CASE WHEN prev IS NULL THEN ${now} ELSE ${unstamped} END),
                             'touchedAt',
                                 CASE WHEN prev IS NULL THEN ${now}
                                      WHEN ${artifactRowBody('e')} IS DISTINCT FROM ${artifactRowBody('prev')} THEN ${now}
                                      ELSE COALESCE(prev->'touchedAt', ${unstamped}) END)
                       END AS item,
                       w.n AS ord
                  FROM jsonb_array_elements(${valuePh}::jsonb) WITH ORDINALITY AS w(e, n)
                  LEFT JOIN LATERAL (
                       SELECT p FROM jsonb_array_elements(${stored}) AS o(p)
                        WHERE p->>'id' = e->>'id' LIMIT 1
                  ) AS pv(prev) ON TRUE${keptFromTheRun}
            ) AS windowed)`;
}

module.exports = { DB_CLOCK_ISO, ROW_UNSTAMPED_ISO, jsonbArrayOf, artifactRowBody, artifactColumnSql };
