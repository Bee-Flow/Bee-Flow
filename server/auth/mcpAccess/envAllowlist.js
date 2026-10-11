// @typecheck
/**
 * Instance-wide IP allow-lists for the MCP endpoints, set by the operator in
 * the environment (prod: the beeflow-config ConfigMap or deploy-prd server_env).
 *
 *   MCP_IP_ALLOWLIST               every MCP endpoint
 *   INTEGRATIONS_MCP_IP_ALLOWLIST  /mcp
 *   AUTOMATION_MCP_IP_ALLOWLIST    /mcp/automations
 *   STUDIO_MCP_IP_ALLOWLIST        /mcp/studio
 *   CMS_MCP_IP_ALLOWLIST           /mcp/cms (also its upload URLs)
 *
 * Entries are addresses or CIDR ranges, separated by commas, semicolons or
 * whitespace (deploy-prd's server_env splits on commas, so use `;` there).
 * Both the global and the per-server list apply: the strictest wins, on top of
 * the org policy and the token's own list. Unset or blank = no restriction.
 *
 * A list that does not parse denies everything for that server: an operator
 * who typed an allow-list meant to restrict, so a typo must not open it up.
 */

'use strict';

const { parseCidrList } = require('./ipMatch');
const log = require('../../telemetry/log');

const SERVER_VARS = Object.freeze({
    integrations: 'INTEGRATIONS_MCP_IP_ALLOWLIST',
    automations: 'AUTOMATION_MCP_IP_ALLOWLIST',
    studio: 'STUDIO_MCP_IP_ALLOWLIST',
    cms: 'CMS_MCP_IP_ALLOWLIST',
});
const GLOBAL_VAR = 'MCP_IP_ALLOWLIST';

/** raw env value → parsed list, or null when it does not parse. */
const parsed = new Map();

function parseValue(name, raw) {
    if (parsed.has(raw)) return parsed.get(raw);
    let list = null;
    try {
        list = parseCidrList(raw.split(/[\s,;]+/).filter(Boolean));
    } catch (err) {
        log.error(`[McpAccess] ${name} is not a valid IP allow-list (${err.message}); denying every request to that MCP endpoint until it is fixed.`);
    }
    if (parsed.size >= 50) parsed.clear();
    parsed.set(raw, list);
    return list;
}

/**
 * The instance allow-lists that apply to `server`.
 *
 * @param {string|undefined} server
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ ok: true, lists: string[][] } | { ok: false }}
 */
function instanceAllowlists(server, env = process.env) {
    const names = [GLOBAL_VAR];
    if (server && SERVER_VARS[server]) names.push(SERVER_VARS[server]);
    const lists = [];
    for (const name of names) {
        const raw = String(env[name] || '').trim();
        if (!raw) continue;
        const list = parseValue(name, raw);
        if (!list) return { ok: false };
        lists.push(list);
    }
    return { ok: true, lists };
}

module.exports = { instanceAllowlists, SERVER_VARS, GLOBAL_VAR };
