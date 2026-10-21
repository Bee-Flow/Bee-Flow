// @typecheck
'use strict';
/**
 * Limits of the run reads (mcpRunReads.js). The caps are environment variables
 * with a generous default; 0 = unlimited.
 */

/** @param {string} name @param {number} fallback  A non-negative integer; 0 = unlimited. */
function envCap(name, fallback) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Apply a cap where 0 means "no cap". */
const capped = (n, cap) => (cap > 0 ? Math.min(n, cap) : n);

const caps = () => ({
    list: envCap('AUTOMATION_MCP_RUN_LIST_MAX', 100),
    steps: envCap('AUTOMATION_MCP_RUN_STEPS_MAX', 2000),
    files: envCap('AUTOMATION_MCP_RUN_FILES_MAX', 500),
    keys: envCap('AUTOMATION_MCP_RUN_SHAPE_MAX_KEYS', 500),
    nodes: envCap('AUTOMATION_MCP_RUN_SHAPE_MAX_NODES', 200000),
    bytes: envCap('AUTOMATION_MCP_RUN_READ_MAX_BYTES', 1024 * 1024),
});

const DEFAULT_LIST_LIMIT = 25;
const ERROR_SUMMARY_CHARS = 200;
const STEP_ERROR_CHARS = 300;
const MAX_PATH_CHARS = 500;
const MAX_ID_CHARS = 200;

module.exports = { envCap, capped, caps, DEFAULT_LIST_LIMIT, ERROR_SUMMARY_CHARS, STEP_ERROR_CHARS, MAX_PATH_CHARS, MAX_ID_CHARS };
