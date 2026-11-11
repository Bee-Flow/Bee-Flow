// @typecheck strict
/**
 * Step kind `code`: a short JavaScript function the server runs in the code sandbox
 * (automation/codeSandbox.js, isolated-vm) over values the step's `inputs` resolved first.
 *
 * What the code can reach is its inputs and ctx.log, nothing else: no network, no
 * integrations, no database, no secrets. The inputs are read before the sandbox starts,
 * by the ordinary binding resolution under the row access of whoever runs the action, so
 * the code has no identity of its own. Its return value lands in `resultVar`; writes are
 * ordinary steps after it that read vars.<resultVar>. Executor: actionExecutor/steps/code.mts.
 */

'use strict';

const { LIMITS } = require('../limits');

/** The sandbox's wall-clock ceiling (codeSandbox.js MAX_LIMITS.wallMs) and its floor. */
const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 30000;

module.exports = {
    kind: 'code',
    since: 3,
    side: 'server',
    fields: {
        code: { type: 'code', required: true, maxLen: LIMITS.MAX_CODE_STEP_CHARS },
        inputs: { type: 'recordValues' },
        resultVar: { type: 'string', maxLen: 60 },
        timeoutMs: { type: 'int', min: TIMEOUT_MIN_MS, max: TIMEOUT_MAX_MS },
    },
    childSlots: [],
    // Nothing leaves the sandbox but its return value: running it again changes nothing.
    retrySafe: true,
    policy: { click: 'step', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'run', public: 'step' },
    // A role is needed to run it (it spends server CPU), and it has its own per-minute
    // bucket, STUDIO_APP_CODE_RPM (routes/studioAppStepBudget.mts).
    budget: 'heavy',
    handler: 'file',
    inLoop: {
        severity: 'warning', code: 'action.code_in_loop',
        message: 'A "code" step runs inside a loop — one sandbox run per iteration.',
        hint: 'Pass the whole list as one input and loop inside the code instead: one run, and no per-minute limit reached halfway.',
    },
    summary: (/** @type {Record<string, unknown>} */ step) => `code→${typeof step.resultVar === 'string' && step.resultVar ? step.resultVar : '?'}`,
    description: 'Runs a small JavaScript function on the server over named inputs. '
        + 'Write `function main(inputs, ctx) { ... }` and return a JSON value: it lands in vars.<resultVar> for the steps after it. '
        + '`inputs` maps a name to a binding ({ "lines": { "kind": "records", "tableId": "tbl_lines", "filter": [...] }, "rate": { "kind": "static", "value": 21 } }); '
        + 'every binding is resolved before the code starts, under the row access of the person running the action, and the code sees plain values (inputs.lines is an array of rows). '
        + 'ctx.log(...) writes a line the run report shows. There is no network, no database, no integrations and no secrets: ctx.http, ctx.integrations and ctx.db are refused, so a write is an ordinary step after it (create_record or update_record with a formula on vars.<resultVar>). '
        + 'Example: { "kind": "code", "code": "function main(inputs) {\\n  const total = inputs.lines.reduce((s, l) => s + l.qty * l.price, 0);\\n  return { total, vat: Math.round(total * inputs.rate) / 100 };\\n}", '
        + '"inputs": { "lines": { "kind": "records", "tableId": "tbl_lines" }, "rate": { "kind": "static", "value": 21 } }, "resultVar": "totals" }. '
        + `Limits: code at most ${LIMITS.MAX_CODE_STEP_CHARS} characters, at most ${LIMITS.MAX_CODE_STEP_INPUTS} inputs, a records input reads 50 rows unless its binding sets limit (at most 200), the return value at most 1 MB, and by default 1 s of CPU within 5 s. timeoutMs (${TIMEOUT_MIN_MS}..${TIMEOUT_MAX_MS}) sets both time limits instead (CPU at most 10 s). `
        + 'Do NOT use it for what a formula or an ordinary step already does: a sum, a lookup, a text or date calculation is a formula (set_variable or a binding with kind formula), a write is create_record/update_record, a model call is ai_generate. '
        + 'Use it only for logic a formula cannot say, such as a loop with running state, a parse of a pasted text, or a custom score over many rows. '
        + 'Inside a loop it runs once per row: pass the list as one input and loop in the code instead. If the server has no code sandbox the step fails with code_unavailable.',
};
