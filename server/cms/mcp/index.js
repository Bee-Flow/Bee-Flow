/**
 * CMS over MCP — the feature's entry point.
 *
 * `isEnabled()` is the operator's switch and the single predicate both
 * index.js (to mount the route) and the tests read. Strict '1', like the Studio
 * and Automations endpoints: this surface edits the public website with a static
 * token, so it should be switched on by someone who meant to, not by an empty
 * string or a stray "false" that a tolerant parser waves through.
 *
 * The pieces are factories with injected collaborators; routes/mcpCms.js wires
 * the real ones (it may require routes/ and the access gate, this folder may not).
 */

'use strict';

const { createCmsMcp } = require('./dispatch');
const { createUploadTickets } = require('./uploadTickets');
const { createUploadReceiver } = require('./uploadReceiver');
const { createScreenshotRenderer } = require('./screenshot');
const { createAccessCheck } = require('./accessCheck');

function isEnabled() {
    return process.env.CMS_MCP_ENABLED === '1';
}

module.exports = { isEnabled, createCmsMcp, createUploadTickets, createUploadReceiver, createScreenshotRenderer, createAccessCheck };
