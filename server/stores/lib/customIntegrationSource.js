/**
 * Which family an org_custom_integrations row belongs to, read from the row
 * alone: an MCP library install (kind 'mcp_remote' whose running definition
 * carries `meta.source === 'mcp_library'`) or an AI Integration Builder row.
 *
 * Pure, and kept here rather than in core/customIntegrations/mcpLibrary/gate.js
 * so the platform side (core/entitlements/capabilityRegistry.js) can classify a
 * row without reaching up into core. gate.js re-exports these.
 */

'use strict';

const LIBRARY_SOURCE = 'mcp_library';

/** The definition that runs: the activated snapshot, or the draft for a draft row. */
function runningDefinition(row) {
    if (!row || typeof row !== 'object') return null;
    return row.activatedDefinition || row.activated_definition || row.definition || null;
}

function isLibraryRow(row) {
    if (!row || row.kind !== 'mcp_remote') return false;
    const def = runningDefinition(row);
    return !!(def && def.meta && def.meta.source === LIBRARY_SOURCE);
}

module.exports = { LIBRARY_SOURCE, runningDefinition, isLibraryRow };
