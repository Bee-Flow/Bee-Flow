// @typecheck
'use strict';
/**
 * What the run-read tools look like to an MCP client (mcpRunReads.js): the
 * four descriptors in the OpenAI function shape, the name sets the dispatcher
 * routes on, and the section of the authoring guide that explains them.
 */

const { DEFAULT_LIST_LIMIT } = require('./mcpRunReadCaps');

const RAW_PROP = { type: 'boolean', description: 'Ask for the real text instead of the protected form. Refused unless the organisation allows raw run data over MCP; every such read is audited.' };

const RUN_ID_PROP = { type: 'string', description: 'The run (id from automations_list_runs).' };

/**
 * The four tools, in the same OpenAI shape as the other MCP-only tools.
 * @type {any[]}
 */
const RUN_READ_TOOLS = [
    {
        name: 'automations_list_runs',
        description: 'List the runs of one automation, newest first: id, status, startedAt, finishedAt, version, trigger kind, the error class and a short error summary (quoted text, addresses and long numbers are replaced by placeholders; `raw: true` returns the real text when the organisation allows it). Read-only. Page on with the returned nextCursor.',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'integer', description: `How many runs (default ${DEFAULT_LIST_LIMIT}; the instance may cap it lower).` },
                status: { type: 'string', description: 'Only runs with this status, for example "error", "success", "running".' },
                cursor: { type: 'string', description: 'The nextCursor of the previous page.' },
                raw: RAW_PROP,
            },
        },
    },
    {
        name: 'automations_get_run_steps',
        description: 'The steps of one run: stepId, type, status, durationMs, error and, for input and output, the SHAPE of the JSON (keys, types, list lengths) with counts. No values: an error text is scrubbed of quoted text, addresses and long numbers (`raw: true` returns it as it is when the organisation allows it). Use this to see where a run went wrong and what a step produced structurally. Read-only.',
        parameters: { type: 'object', properties: { runId: RUN_ID_PROP, raw: RAW_PROP }, required: ['runId'] },
    },
    {
        name: 'automations_get_step_output',
        description: 'The output of one step. Values are privacy-protected by default: strings become «string:<length>» and numbers «number», structure is kept. Pass `path` (for example "items[0].customer") to read part of it. `raw: true` returns real values and works only when the organisation has allowed it; every raw read is written to the audit log. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                runId: RUN_ID_PROP,
                stepId: { type: 'string', description: 'The step id (from automations_get_run_steps).' },
                path: { type: 'string', description: 'Optional path into the output, for example "items[0].name" or "[*].sku". Match segments such as [key="value"] work in raw reads only.' },
                attempts: { type: 'integer', description: 'Which attempt of a retried step; default the last one.' },
                raw: { type: 'boolean', description: 'Ask for the real values. Refused unless the organisation allows raw run data over MCP.' },
            },
            required: ['runId', 'stepId'],
        },
    },
    {
        name: 'automations_list_run_files',
        description: 'The files a run generated: fileId, name, mime, size, stepId, expiresAt. Metadata only, never the content. A name can be built from run data, so it comes back as «name:<length>».ext unless `raw: true` is passed and the organisation allows it. Read-only.',
        parameters: { type: 'object', properties: { runId: RUN_ID_PROP, raw: RAW_PROP }, required: ['runId'] },
    },
];

const RUN_READ_TOOL_NAMES = new Set(RUN_READ_TOOLS.map((t) => t.name));
/** Tools that name a run, not an automation: the dispatcher adds no automationId to them. */
const RUN_ONLY_TOOL_NAMES = new Set(RUN_READ_TOOLS.filter((t) => t.parameters.required?.includes('runId')).map((t) => t.name));

/** A short section for the guide automations_get_guide returns. */
function guideSection() {
    return [
        '## Reading runs (read-only)',
        '',
        'To see what an automation did, use the run tools. They never hand you the data it processed:',
        '- automations_list_runs { automationId, limit?, status?, cursor? }: runs with status, timing, version, trigger kind, error class and a scrubbed error summary.',
        '- automations_get_run_steps { runId }: per step the type, status, duration, error (scrubbed) and the SHAPE of input and output (keys, types, list lengths, counts).',
        '- automations_get_step_output { runId, stepId, path? }: one step output with every value replaced by a typed placeholder («string:12», «number»). Use `path` to look at one branch of it. `raw: true` returns real values only when the organisation allows it, and every such read is audited.',
        '- automations_list_run_files { runId }: file types, sizes and expiry of generated files, never their content; a name shows as «name:<length>».ext.',
        'Error texts and file names can carry run values, so `raw: true` on the run tools returns them as they are, under the same organisation setting and audit row as a raw step output.',
        'Fix mappings from the shape (keys and types), not from values.',
    ].join('\n');
}

module.exports = { RUN_READ_TOOLS, RUN_READ_TOOL_NAMES, RUN_ONLY_TOOL_NAMES, guideSection };
