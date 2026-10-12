// @typecheck
/**
 * JSON-RPC batches on the MCP endpoints.
 *
 * One HTTP request may carry an array of messages. Left unbounded (the body
 * limit is 8 MB) a single request could carry thousands of tool calls and
 * walk around any per-request rate limit, so a batch is capped and the gate
 * charges the limiters per message.
 */

'use strict';

const MAX_BATCH_SIZE = 20;

/** Is this request body a batch larger than the cap? */
const batchTooLarge = (body) => Array.isArray(body) && body.length > MAX_BATCH_SIZE;

/** Refuse an oversized batch as a JSON-RPC Invalid Request. Nothing was executed. */
function rpcBatchTooLarge(res) {
    return res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `Invalid Request: a batch can hold at most ${MAX_BATCH_SIZE} messages.` },
    });
}

module.exports = { MAX_BATCH_SIZE, batchTooLarge, rpcBatchTooLarge };
