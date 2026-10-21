// @typecheck
'use strict';
/**
 * The call wrapper every MCP tool surface of the automations shares: look the
 * tool up by name, run it, and turn a refusal into `{ error, code }`. It never
 * throws, so an MCP client always gets an answer it can read.
 */

const { HttpError } = require('../core/http/errors');
const log = require('../telemetry/log');

/**
 * @param {Record<string, (userId: string, args: Record<string, any>) => any>} handlers
 * @returns {(name: string, args: unknown, ctx: { userId: string }) => Promise<any>}
 */
function makeToolCall(handlers) {
    return async function call(name, args, { userId }) {
        const handler = handlers[name];
        if (!handler) return { error: `Unknown tool: ${name}` };
        try {
            return await handler(userId, args && typeof args === 'object' ? /** @type {Record<string, any>} */ (args) : {});
        } catch (e) {
            if (e instanceof HttpError) return { error: e.message, code: e.code };
            log.error(`[automations-mcp] ${name} failed: ${e instanceof Error ? e.message : e}`);
            return { error: `${name} failed.`, code: 'internal_error' };
        }
    };
}

module.exports = { makeToolCall };
