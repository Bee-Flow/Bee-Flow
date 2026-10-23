/**
  * testSetFacts — the FACTS behind the test set card, apart from how they are
  * drawn (Bee Flow Builder redesign, Sep 2026; A4 part D).
  *
  * Pure: what `GET /agents/:id/tests` and `GET /agents/:id/tests/runs` return
  * goes in, facts come out — no sentences. The sentences live in the card,
  * because that is also where the literal `t()` keys that the i18n guard reads
  * live.
  *
  * ── "11 / 12 PASSED" IS A COUNT OVER ONE RUN ────────────────────────
  * And so not a property of the test set. Four states, and three of them must
  * NEVER appear on screen as a number:
  *
  *   never       it has never run. That is not "0 / 12 passed": that number
  *               would claim that twelve questions were asked and all twelve
  *               answered wrongly. Nothing was asked.
  *   unknown     the last run could not be read (`lastRunUnknown`). Not a 0
  *               either: "I don't know" is a third answer.
  *   unfinished  there is a row, but it contradicts itself — no `total`, more
  *               `passed` than `total`, or an `items` list that is not as long
  *               as `total`. A run that fell over halfway is not a result, and
  *               "3 of 3 green" out of nine questions is the most misleading
  *               line this card can show.
  *   result      a finished run. Only here is there a number.
  *
  * The route already refuses to SAVE an aborted run (routes/agents/tests.js), so
  * `unfinished` should be rare. It is there because the card may not ASSUME that
  * promise: a row from before that rule, a manual edit or a half-written JSONB
  * arrives here as an ordinary row.
  *
  * ── AND IT DESCRIBES THE QUESTIONS OF THEN ──────────────────────────
  * A run describes the questions as they were at that moment, and the agent as
  * it ran at that moment. That is why `summariseRun` also computes two things
  * the card must be ABLE to say: how many of the CURRENT questions this run
  * covered (`coverage`), and whether anything about the set has changed since
  * (`stale`). Without those two, "11 / 12 passed" reads as a statement about the
  * set that is there now, and that is exactly what it is not.
  *
  * ── A REFUSAL IS NOT A FAILED TEST ──────────────────────────────────
  * "No model has been set up to judge these answers" comes back as an HTTP
  * refusal before a single turn has run. That must never land on the card as red
  * tests: someone would go and fix their agent while nothing is wrong with their
  * agent. `refusalFor` translates those answers into a closed vocabulary, so the
  * card can draw them as a refusal and leave the count alone.
 */

/** One result of a test within a run (`results.items[]`). */
export interface TestItem {
    testId?: string;
    name?: string;
    status: string;
    reason?: string;
    decidedBy?: string;
    forbiddenHits?: string[];
    toolsMissing?: string[];
    toolsWithheld?: string[];
}

/** The outcomes that belong to a saved run. */
export interface TestRunResults {
    items?: TestItem[];
    source?: string;
    unpublishedChanges?: number | string | null;
    testCount?: number | string | null;
}

/** A row from `GET /agents/:id/tests` (`lastRun`) or `/tests/runs`. */
export interface TestRun {
    id?: string;
    total?: number | string | null;
    passed?: number | string | null;
    results?: TestRunResults | null;
    ranAt?: string | null;
    version?: number | string | null;
}

/** One question of the test set as it is NOW. */
export interface AgentTest {
    id: string;
    name?: string;
    question?: string;
    createdAt?: string | number | Date;
    updatedAt?: string | number | Date;
    writtenBy?: Record<string, unknown> | null;
}

/** The closed answer of `refusalFor`. */
export interface Refusal {
    kind: string;
    code: string | null;
    status: number;
    retryable: boolean;
    serverMessage: string;
}

/** A run while it is running, or just finished. */
export interface RunProgress {
    status: string;
    total: number | null;
    done: number;
    items: TestItem[];
    passed: number | null;
    notStored: string | null;
    run?: TestRun | null;
    refusal?: Refusal | null;
}

/** What `summariseRun` claims about the last run. */
export interface RunSummary {
    state: string;
    passed: number | null;
    total: number | null;
    items: TestItem[];
    itemsKnown: boolean;
    ranAt: string | null;
    version: number | null;
    source: string | null;
    unpublishedChanges: number | null;
    coverage: { ran: number | null; of: number | null; when: string } | null;
    stale: { added: boolean; changed: boolean; removed: boolean };
    isStale: boolean;
}

/**
  * What the card may claim about the last run.
  *
  * @param {object} input
  * @param {object|null} input.lastRun        the row from `GET /:id/tests`
  * @param {boolean} input.lastRunUnknown     the read failed
  * @param {Array} input.tests                the questions as they are NOW
 * @returns {{state: string, passed: number|null, total: number|null,
 *            items: Array, itemsKnown: boolean, ranAt: string|null,
 *            version: number|null, source: string|null,
 *            unpublishedChanges: number|null,
 *            coverage: {ran: number, of: number|null}|null,
 *            stale: {added: boolean, changed: boolean, removed: boolean},
 *            isStale: boolean}}
 */
export interface SummariseRunArgs {
    lastRun?: TestRun | null;
    tests?: AgentTest[] | null;
    lastRunUnknown?: boolean;
}

/**
  * An answer that was not a run.
  *
  * `null` means "this was not a refusal". Everything that IS a refusal gets a
  * `kind` from the vocabulary above — even a code this file does not know,
  * because an unknown refusal is still a refusal and must certainly not land on
  * the card as a test result.
 *
 * @param {{status?: number, body?: object, code?: string}} input
 */
export interface RefusalForArgs {
    body?: Record<string, unknown> | null;
    status?: number;
    code?: string | null;
}
