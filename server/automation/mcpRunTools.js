// @typecheck strict
'use strict';
/**
 * The tools of the automations MCP server that work on runs and on saved test
 * data, as one set: the run reads (mcpRunReads.js) and the form scenarios
 * (mcpFormScenarios.js). mcpBuilder.js asks this module for the tool list, the
 * guide text and the dispatch instead of knowing each part.
 */

const runReads = require('./mcpRunReads');
const formScenarios = require('./mcpFormScenarios');

/** @type {any[]} */
const RUN_TOOLS = [...runReads.RUN_READ_TOOLS, ...formScenarios.FORM_SCENARIO_TOOLS];

/** Tools that act on a run or a scenario, not on the automation of an `automationId` envelope. */
const RUN_TOOL_NAMES = new Set([...runReads.RUN_READ_TOOL_NAMES, ...formScenarios.FORM_SCENARIO_TOOL_NAMES]);

/** Run-only tools: no automation is named at all. */
const RUN_ONLY_TOOL_NAMES = runReads.RUN_ONLY_TOOL_NAMES;

/** The guide sections of both parts, joined. */
const guideSection = () => [runReads.guideSection(), formScenarios.guideSection()].filter(Boolean).join('\n\n');

/**
 * Run one of the tools. Never throws: a refusal comes back as `{ error, code }`.
 * @param {string} name
 * @param {any} args
 * @param {{ userId: string }} ctx
 */
function callRunTool(name, args, ctx) {
    return formScenarios.FORM_SCENARIO_TOOL_NAMES.has(name)
        ? formScenarios.callFormScenarioTool(name, args, ctx)
        : runReads.callRunTool(name, args, ctx);
}

module.exports = { RUN_TOOLS, RUN_TOOL_NAMES, RUN_ONLY_TOOL_NAMES, guideSection, callRunTool };
