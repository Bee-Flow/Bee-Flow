// @typecheck
const { initDB, run, getOne, getAll } = require('./core');
const { rowToRun, rowToRunStep } = require('./rowMappers');
const { redactForPersistence, safeOutputKeysForTool } = require('../../automation/runLogRedaction');
const { truncatePayload } = require('../../automation/payloadTruncation');
const { persistableOutput } = require('./runFullOutputs');
const { persistableBindingWarnings } = require('./bindingWarnings');
const log = require('../../telemetry/log');

async function recordRunStep(args) {
    await initDB();
    return recordRunStepWith(run, args);
}

/**
 * recordRunStep's body over an injected `run(sql, params)`, so a test can put
 * its real SQL against an in-process Postgres without mocking the store's db.
 */
async function recordRunStepWith(run, { runId, stepId, parentStepId = null, stepType, attempts = 1, status, startedAt, finishedAt, input, output, error, errorClass = null, branchIndex = null, piiSummary = null, secretValues = [], publicValues = [], toolName = null, toolsWithheld = null, errorInfo = null, bindingWarnings = null, identityUserId = null }) {
    if (!runId || !stepId) {
        // Defensive: NOT NULL columns; skip rather than crash the whole run.
        log.warn(`[AutomationStore] recordRunStep called with null runId/stepId — skipping (runId=${runId}, stepId=${stepId})`);
        return;
    }
    // WS5.2 — this is the single persistence chokepoint for step payloads:
    // redact secrets BEFORE truncation so the truncation head sample is
    // already clean, then cap payload size. In-memory runState stays raw.
    // An OUTPUT over the cap keeps a full copy beside the row (BFSF-435,
    // runFullOutputs.persistableOutput): a resume rebuilds runState from these
    // rows, and the sentinel alone left the step as a silent hole.
    // Exempt known public-identifier fields for this tool (e.g. a Nextcloud
    // Talk room `token`) from the key-name redaction — they're not credentials
    // and downstream steps need them. Secret shapes/values are still masked.
    const allowKeys = safeOutputKeysForTool(toolName);
    /**
     * @param {string} v
     */
    const redact = (v) => redactForPersistence(v, { secretValues, allowKeys, publicValues }).value;
    // NUL bytes can't live in jsonb/text columns — Postgres rejects them with
    // "unsupported Unicode escape sequence" and aborts the whole run record.
    // A single NUL in extracted tool output (e.g. a CID-font PDF) would
    // otherwise kill the run here, so scrub it at this persistence chokepoint.
    // Strip real NUL characters from the RAW value (string leaves, walked
    // recursively) BEFORE JSON.stringify — NOT via a post-hoc regex on the
    // already-stringified JSON. A regex against the stringified form (the
    // old approach) corrupted the JSON whenever a string value contained a
    // literal backslash immediately followed by the 6-char text 'u0000':
    // JSON.stringify escapes that backslash to two backslashes, so matching
    // one backslash + 'u0000' stripped the wrong span and left a dangling
    // unescaped backslash before the closing quote, failing the jsonb insert.
    const NUL = String.fromCharCode(0);
    const stripNulDeep = (v) => {
        if (typeof v === 'string') return v.indexOf(NUL) === -1 ? v : v.split(NUL).join('');
        if (Array.isArray(v)) return v.map(stripNulDeep);
        if (v && typeof v === 'object') {
            const out = {};
            for (const k of Object.keys(v)) out[k] = stripNulDeep(v[k]);
            return out;
        }
        return v;
    };
    const inputJson = input != null ? JSON.stringify(stripNulDeep(truncatePayload(redact(input)).value)) : null;
    const outputValue = output != null
        ? await persistableOutput({ value: redact(output), ref: { runId, stepId, attempts }, clean: stripNulDeep })
        : null;
    const outputJson = outputValue != null ? JSON.stringify(stripNulDeep(outputValue)) : null;
    const errorText = error ? redact(String(error)).replace(/\u0000/g, '') : null;
    // parent_step_id is set on INSERT only (deliberately absent from the
    // conflict-update list): a step's nesting parent is fixed by the graph
    // shape at dispatch time and never changes across attempt upserts.
    // pii_summary is aggregate metadata (category/group COUNTS — see
    // safety.buildPiiSummary), never detected values, so it needs neither
    // redaction nor truncation. Its own column keeps it clear of the 256 KB
    // output truncation and out of the bindable output namespace.
    const piiJson = piiSummary != null ? JSON.stringify(piiSummary) : null;
    // Handoff 5: tools an agent step was not given, and the structured error
    // ({ code, settingKey, fixes }). toolsWithheld is metadata: no redaction
    // pass. errorInfo is NOT: its `technical` is the raw message and its
    // params quote the step's settings, so it gets the same pass as `error`.
    const withheldJson = toolsWithheld != null ? JSON.stringify(toolsWithheld) : null;
    const errorInfoJson = errorInfo != null ? JSON.stringify(stripNulDeep(redact(errorInfo))) : null;
    // The mappings that found nothing while the step ran (bindingWarnings.js):
    // paths and names, never the data, but a formula's text can quote a
    // literal, so the same redaction pass as `error`. Null when none missed.
    const warnings = persistableBindingWarnings(bindingWarnings, { clean: (v) => stripNulDeep(redact(v)) });
    const warningsJson = warnings ? JSON.stringify(warnings) : null;
    await run(
        `INSERT INTO automation_run_steps (run_id, step_id, parent_step_id, step_type, attempts, status, started_at, finished_at, input_json, output_json, error, error_class, branch_index, pii_summary, tools_withheld, error_info, binding_warnings, identity_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (run_id, step_id, attempts) DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            -- COALESCE, not a plain overwrite: the engine pre-inserts a
            -- 'running' row with no input so the form's progress trail has
            -- something to read, and that null must not erase the real input
            -- the completing upsert wrote (or, in the other order, be written
            -- over it). Every step of every run went input-less for a day
            -- because this line was missing.
            input_json = COALESCE(EXCLUDED.input_json, automation_run_steps.input_json),
            output_json = EXCLUDED.output_json,
            error = EXCLUDED.error,
            error_class = EXCLUDED.error_class,
            branch_index = EXCLUDED.branch_index,
            pii_summary = EXCLUDED.pii_summary,
            -- COALESCE like input_json: a later upsert that does not know
            -- about these (runDag flipping a row to handled_error) must not
            -- erase what the step recorded.
            tools_withheld = COALESCE(EXCLUDED.tools_withheld, automation_run_steps.tools_withheld),
            error_info = COALESCE(EXCLUDED.error_info, automation_run_steps.error_info),
            binding_warnings = COALESCE(EXCLUDED.binding_warnings, automation_run_steps.binding_warnings),
            identity_user_id = COALESCE(EXCLUDED.identity_user_id, automation_run_steps.identity_user_id)`,
        [
            runId, stepId, parentStepId || null, stepType, attempts, status,
            startedAt || null, finishedAt || null,
            inputJson,
            outputJson,
            errorText,
            errorClass || null,
            branchIndex,
            piiJson,
            withheldJson,
            errorInfoJson,
            warningsJson,
            identityUserId || null,
        ],
    );
}

async function getRunSteps(runId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_run_steps WHERE run_id = $1 ORDER BY started_at NULLS LAST, step_id, attempts',
        [runId],
    );
    return rows.map(rowToRunStep);
}

/**
 * Every leg of one journey, oldest first — the run itself plus anything that
 * continued it after a form or approval pause. Pass any leg's id; the root is
 * resolved from it.
 */
async function getRunsInChain(runId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_runs
          WHERE COALESCE(root_run_id, id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)
          ORDER BY started_at ASC NULLS FIRST, id ASC`,
        [runId],
    );
    return rows.map(rowToRun);
}

/**
 * The journey's step rows as ONE timeline.
 *
 * A leg only records the steps it dispatched LIVE — everything before its
 * resume boundary is replayed, not re-recorded — so reading a single leg shows
 * holes where the earlier pages ran. Concatenating oldest-leg-first fills them,
 * and when the same step_id appears twice (the paused step is re-recorded on
 * the leg that answered it) the LATER leg wins. Same precedence resumeFromStep
 * uses when it rebuilds runState from the ancestor chain.
 */
async function getRunStepsForChain(runId) {
    await initDB();
    const rows = await getAll(
        `SELECT s.* FROM automation_run_steps s
           JOIN automation_runs r ON r.id = s.run_id
          WHERE COALESCE(r.root_run_id, r.id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)
          ORDER BY r.started_at ASC NULLS FIRST, r.id ASC, s.started_at NULLS LAST, s.step_id, s.attempts`,
        [runId],
    );
    const byStep = new Map();
    for (const row of rows) byStep.set(`${row.step_id}#${row.attempts}`, row);
    return [...byStep.values()].map(rowToRunStep);
}

/**
 * The NEWEST leg of `runId`'s journey — the one carrying its current state,
 * whether that is running, paused or terminal. For a run that was never paused
 * this is the run itself.
 *
 * This is what a public form's poll must read: a resume hands off to a child
 * run, so the run the form SESSION points at may already be a finished handoff
 * while the work continues elsewhere.
 */
async function getLatestRunInChain(runId) {
    await initDB();
    const row = await getOne(
        `SELECT * FROM automation_runs
          WHERE COALESCE(root_run_id, id) = (SELECT COALESCE(root_run_id, id) FROM automation_runs WHERE id = $1)
          ORDER BY started_at DESC NULLS LAST, id DESC
          LIMIT 1`,
        [runId],
    );
    return rowToRun(row);
}

/**
 * Step rows for SEVERAL runs in one query — the replay seeding's loader
 * (BFSF-359).
 *
 * runPartial rebuilds a step's upstream from the last REPLAY_RUN_WINDOW runs.
 * Doing that with getRunSteps() is N+1, and `SELECT *` drags ten runs' worth of
 * input_json across the wire so the seeding can read six columns — on an
 * API-heavy automation that is most of the "several seconds" a single ▶ Execute
 * costs.
 *
 * NOT a drop-in replacement for getRunSteps: the projection omits input_json
 * and pii_json, so `input` and the PII summary come back undefined. It exists
 * for the replay seeding, which reads status/output/error/errorClass only.
 * Anything that needs the full row must keep using getRunSteps.
 *
 * Ordering matches getRunSteps within each run (attempts ASC last), because the
 * seeding relies on a later attempt overwriting an earlier one.
 */
async function getRunStepsForRuns(runIds) {
    await initDB();
    const ids = (Array.isArray(runIds) ? runIds : []).filter(Boolean);
    if (!ids.length) return [];
    const rows = await getAll(
        `SELECT run_id, step_id, parent_step_id, step_type, attempts, status,
                started_at, finished_at, output_json, error, error_class, branch_index
           FROM automation_run_steps
          WHERE run_id = ANY($1)
          ORDER BY run_id, started_at NULLS LAST, step_id, attempts`,
        [ids],
    );
    return rows.map(rowToRunStep);
}

module.exports = { recordRunStep, recordRunStepWith, getRunSteps, getRunsInChain, getRunStepsForChain, getLatestRunInChain, getRunStepsForRuns };
