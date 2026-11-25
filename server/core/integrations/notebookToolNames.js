// @typecheck strict
/** The notebook tools (current and legacy names). Shared by the dispatcher family and /mcp. */
const NOTEBOOK_TOOLS = new Set([
    'notebook_read', 'notebook_write', 'notebook_replace', 'notebook_insert',
    'workspace_read', 'workspace_write', 'workspace_replace',
]);

module.exports = { NOTEBOOK_TOOLS };
