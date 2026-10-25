// @typecheck strict
/**
 * Few-shot worked dialogues for the builder agent (§WS5, extracted verbatim
 * from builderPrompt.js).
 *
 * Every tool ECHO in the three ordered examples is byte-true to what the real
 * builders return for that call on a lean profile (`_resultDetail:'full'`:
 * `_draftSteps` + `_wiring` on every mutator) — fewShotExamples.replay.test.js
 * replays each call through applyToolCall and compares the whole VALUE (ids
 * mapped, route-added keys aside), so a hand-written summary or a shortened
 * inspect shape fails there. The dry-run echoes follow
 * compactDryRunForModel (a runner is not replayed): status is 'success' (there is
 * no 'simulated' status; a synthesised write carries `_dryRunSynthesised`),
 * and a data_extraction step's dry-run output is the runner's typed SAMPLE
 * ("Sample <name>", 123.45, "2026-01-15"), never real values — a model that
 * has seen real-looking values in the example argues with the real run. Every
 * flat step the runner synthesises (a side-effect send, an extraction, a
 * datatable write) is pinned to the byte against the runner's own synthesis
 * functions; live reads and fan-out envelopes are shape-checked.
 */

const { batchedExample } = require('./fewShots/batchedExample');
const { invoiceTableExample } = require('./fewShots/invoiceTableExample');
const { createTableExample } = require('./fewShots/createTableExample');
const { inspectThenBindExample, updateInPlaceExample, gmailReplyExample, nextcloudTalkExample } = require('./fewShots/serialExamples');
const { attachmentToDriveExample } = require('./fewShots/attachmentToDriveExample');

/**
 * Few-shot messages prepended to the conversation when the model profile
 * asks for them (small / mid / reasoning profiles set `fewShots: 1 or 2`).
 *
 * Each example is a short [user, assistant_with_tool_calls, tool_result]
 * triplet that teaches a concrete tool-call sequence. Small models learn
 * the binding format from these much faster than from a wall of prose.
 *
 * Returns an array of OpenAI-format messages suitable for splicing into
 * the existing messages list right after the system prompt.
 *
 * The tool_call ids are sentinels (\`ex_*\`); applyToolCall is never called
 * on them — they only exist to teach the protocol.
 * @param {number} [count]
 */
function buildFewShotMessages(count = 0, { toolset = 'full' } = {}) {
    if (count <= 0) return [];

    // Each example is its own module under ./fewShots/ (the comment above
    // each factory says what it teaches); the serial ones follow the three
    // batch-protocol shots in both orders.
    const batched = batchedExample();
    const invoiceTable = invoiceTableExample();
    const createTable = createTableExample();
    const examples = [
        inspectThenBindExample(),
        updateInPlaceExample(),
        gmailReplyExample(),
        nextcloudTalkExample(),
        attachmentToDriveExample(),
    ];

    // The full-menu bands lead with the batched example: the count-1 profiles
    // (mid, reasoning — toolset 'full') see it alone, and a worked example of
    // ONE builder_add_steps call is the strongest signal a model gets that it
    // need not spend a round per step. The fan-out sits second and the
    // create-table repair third for a profile that asks for more; the serial
    // examples after them still demonstrate the full-menu tools.
    //
    // The 'core' toolset (small band, fewShots: 3) sees the same three shots
    // in a different order: invoice fan-out, create-table repair, Gmail digest
    // LAST. The digest teaches nothing the fan-out does not (plan + inspect +
    // trigger + name in reply 1, one batch with tempId refs, summarise +
    // dry-run, finalize) — the fan-out adds the chained forEach, the
    // extraction and the datatable write, and the Dutch shot adds
    // builder_create_datatable and the dry-run repair. So a `fewShots: 2`
    // override in builder_model_profiles (the one knob that needs no code
    // change) drops the shot the small band can spare, never the Dutch one.
    // 'core' used to get the serial examples because its menu lacked
    // builder_add_steps; since 2026-09-11 CORE_TOOL_NAMES carries the batch
    // tools.
    const ordered = toolset === 'core'
        ? [invoiceTable, createTable, batched, ...examples]
        : [batched, invoiceTable, createTable, ...examples];
    return ordered.slice(0, count).flat();
}

module.exports = { buildFewShotMessages };
