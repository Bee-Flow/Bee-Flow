// @typecheck
'use strict';
/**
 * Read-only run inspection over MCP: what an external authoring agent needs to
 * see what an automation DID, without being handed the data it processed.
 *
 *   automations_list_runs       the runs of one automation (status, timing, version, trigger kind)
 *   automations_get_run_steps   per step: type, status, timing, error, and the SHAPE of its input
 *                               and output (keys, types, list lengths, counts), never raw values
 *   automations_get_step_output one step's output, privacy-protected by default: every value that
 *                               is not structure becomes a typed placeholder («string:12»)
 *   automations_list_run_files  file metadata of a run, never bytes
 *
 * WHY SHAPE FIRST. A run's payloads are the organisation's data (customer
 * records, mail bodies), and an MCP client hands whatever it reads to a model
 * that may live outside Bee Flow. Fixing a mapping needs the keys, the types
 * and the list lengths, almost never the values, so that is what the default
 * answer holds.
 *
 * RAW VALUES are opt-in twice: the caller passes `raw: true` AND the
 * organisation allows it (setting below, off by default). Each raw read writes
 * a row to the access audit log first (WHAT was read: run, step, path, size;
 * never the values) and is refused if that row cannot be written.
 *
 * "Raw" covers everything that can carry a run value, not only step outputs:
 * the text of an error (a stop_error message is a template filled with run
 * values, an integration error often echoes its input) and the name of a
 * generated file (interpolated from run data). By default an error comes back
 * with its class and a scrubbed text, and a file name as its length and
 * extension; `raw: true` on the same tools, under the same two conditions and
 * with the same audit row, returns the real text and names.
 *
 * SCOPE is the one the other tools of this surface use: the automation must be
 * owned by the token's user, in that user's organisation. A run of anybody
 * else's automation answers 404, the same as a run that does not exist. On top
 * comes the run-data read check every run read makes
 * (core/automationModel/callerRunVisibility.js): a run that used its starter's
 * own connections shows its data to the starter alone.
 *
 * CAPS are environment variables with a generous default; 0 = unlimited.
 *   AUTOMATION_MCP_RUN_LIST_MAX        runs per automations_list_runs page          (default 100)
 *   AUTOMATION_MCP_RUN_STEPS_MAX       step rows per automations_get_run_steps      (default 2000)
 *   AUTOMATION_MCP_RUN_FILES_MAX       files per automations_list_run_files         (default 500)
 *   AUTOMATION_MCP_RUN_SHAPE_MAX_KEYS  keys shown per object in a shape             (default 500)
 *   AUTOMATION_MCP_RUN_SHAPE_MAX_NODES values walked per payload                    (default 200000)
 *   AUTOMATION_MCP_RUN_READ_MAX_BYTES  size of one step output answer               (default 1048576)
 *
 * Collaborators are injected (makeRunReads) so the tests hand in a store; the
 * module requires nothing from the database layer at load time.
 *
 * Layout: this file wires and dispatches; the tool descriptors are in
 * mcpRunReadTools.js, the handlers in mcpRunReadHandlers.js, scope and the raw
 * policy in mcpRunReadAccess.js, shapes in mcpRunReadShape.js, text scrubbing
 * in mcpRunReadScrub.js and the caps in mcpRunReadCaps.js.
 */

const { HttpError } = require('../core/http/errors');
const log = require('../telemetry/log');
const { makeAccess, rawPolicyKey, RAW_READ_AUDIT_ACTION } = require('./mcpRunReadAccess');
const { envCap } = require('./mcpRunReadCaps');
const handlerFns = require('./mcpRunReadHandlers');
const { RUN_READ_TOOLS, RUN_READ_TOOL_NAMES, RUN_ONLY_TOOL_NAMES, guideSection } = require('./mcpRunReadTools');
const { shapeOf, describePayload, placeholderize, safeKey, newCounts } = require('./mcpRunReadShape');
const { valueFreeErrorLine, fileNameShape } = require('./mcpRunReadScrub');

/** @param {Parameters<typeof makeAccess>[0]} [overrides] */
function makeRunReads(overrides = {}) {
    const access = makeAccess(overrides);

    const handlers = {
        automations_list_runs: (userId, args) => handlerFns.listRuns(access, userId, args),
        automations_get_run_steps: (userId, args) => handlerFns.getRunSteps(access, userId, args),
        automations_get_step_output: (userId, args) => handlerFns.getStepOutput(access, userId, args),
        automations_list_run_files: (userId, args) => handlerFns.listRunFiles(access, userId, args),
    };

    /**
     * Run one of the four tools. Never throws: a refusal comes back as
     * `{ error, code }` like every other tool result of this surface.
     */
    async function call(name, args, { userId }) {
        const handler = handlers[name];
        if (!handler) return { error: `Unknown tool: ${name}` };
        try {
            return await handler(userId, args && typeof args === 'object' ? args : {});
        } catch (e) {
            if (e instanceof HttpError) return { error: e.message, code: e.code };
            log.error(`[automations-mcp] ${name} failed: ${e.message}`);
            return { error: `${name} failed.`, code: 'internal_error' };
        }
    }

    return { call, rawReadsAllowed: access.rawReadsAllowed, setRawReadsAllowed: access.setRawReadsAllowed };
}

const defaultReads = makeRunReads();

module.exports = {
    RUN_READ_TOOLS,
    RUN_READ_TOOL_NAMES,
    RUN_ONLY_TOOL_NAMES,
    callRunTool: defaultReads.call,
    rawRunReadsAllowed: defaultReads.rawReadsAllowed,
    setRawRunReadsAllowed: defaultReads.setRawReadsAllowed,
    guideSection,
    makeRunReads,
    RAW_READ_AUDIT_ACTION,
    _test: { shapeOf, describePayload, placeholderize, safeKey, rawPolicyKey, envCap, newCounts, valueFreeErrorLine, fileNameShape },
};
