/**
 * The activation tools_cache of a remote-MCP custom integration
 * (kind 'mcp_remote'), shared by the AI Integration Builder's activate route
 * and the MCP library's install path. Moved out of
 * routes/orgIntegrations/builder.js so core code builds it without importing
 * a route module.
 */

// Mirrors the runner/validator tool-name shape (combined max stays well under
// the validator's 64-char cint_<slug>_<name> cap for any legal slug).
const MAX_TOOL_NAME_CHARS = 41;

/**
 * Coerce an arbitrary remote MCP tool name into the runner's tool-name shape
 * (^[a-z][a-z0-9_]{2,40}$): lowercase, non [a-z0-9_] runs collapse to '_',
 * leading digit/underscore gets a 't_' prefix, short names are padded, long
 * names truncated to 41 chars.
 */
function safeToolName(rawName) {
    let s = String(rawName == null ? '' : rawName)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!/^[a-z]/.test(s)) s = s ? `t_${s}` : 'tool';
    if (s.length < 3) s = s.padEnd(3, '0');
    return s.slice(0, MAX_TOOL_NAME_CHARS);
}

/**
 * Numeric-suffix dedupe within MAX_TOOL_NAME_CHARS: 'name', 'name_2',
 * 'name_3', … Mutates `taken` (a Set) so successive calls stay unique.
 */
function dedupeToolName(name, taken) {
    let candidate = name;
    let n = 2;
    while (taken.has(candidate)) {
        const suffix = `_${n++}`;
        candidate = name.slice(0, MAX_TOOL_NAME_CHARS - suffix.length) + suffix;
    }
    taken.add(candidate);
    return candidate;
}

/**
 * Build the activation tools_cache for an mcp_remote integration from
 * discoverTools() output. Entries follow the OpenAI tool shape with the
 * prefixed safe name; `_cint.rawName` preserves the exact remote tool name
 * for dispatch. Tools without a usable name are dropped.
 */
function buildMcpToolsCache(tools, slug) {
    const taken = new Set();
    return (Array.isArray(tools) ? tools : [])
        .filter(t => t && typeof t === 'object' && typeof t.name === 'string' && t.name)
        .map(t => {
            const name = dedupeToolName(safeToolName(t.name), taken);
            return {
                type: 'function',
                function: {
                    name: `cint_${slug}_${name}`,
                    description: typeof t.description === 'string' ? t.description : '',
                    parameters: (t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema))
                        ? t.inputSchema
                        : { type: 'object', properties: {}, additionalProperties: false },
                },
                _cint: { rawName: t.name },
            };
        });
}

module.exports = { safeToolName, dedupeToolName, buildMcpToolsCache, MAX_TOOL_NAME_CHARS };
