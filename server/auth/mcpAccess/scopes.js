// @typecheck
/**
 * What a named MCP token may do: which servers, at which level, which tools.
 *
 *   {
 *     "integrations": { "level": "read" | "write", "tools": ["optional", "list"] },
 *     "automations":  { "level": "write" },
 *     "studio":       { "level": "read" },
 *     "cms":          { "level": "write", "publish": true }
 *   }
 *
 * A server absent from the object is a server the token cannot reach. `read`
 * allows only tools classified read-only (an unclassified tool counts as
 * write, so a new tool is never reachable by omission). `tools`, when present,
 * is an extra allow-list of names inside that server. `cms.publish` is the
 * separate switch for publish / set-live tools and is false unless granted.
 */

'use strict';

const { badRequest } = require('../../shared/httpErrors');

const SERVERS = Object.freeze(['integrations', 'automations', 'studio', 'cms']);
const LEVELS = Object.freeze(['read', 'write']);
const MAX_TOOLS = 200;
const MAX_TOOL_NAME = 128;

/** A pre-existing `bfmcp.` token: every server at write level, no publishing. */
const LEGACY_SCOPES = Object.freeze({
    integrations: Object.freeze({ level: 'write' }),
    automations: Object.freeze({ level: 'write' }),
    studio: Object.freeze({ level: 'write' }),
    cms: Object.freeze({ level: 'write', publish: false }),
});

function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a requested scope object and return its canonical form.
 *
 * @param {unknown} input
 * @returns {Record<string, {level: 'read'|'write', tools?: string[], publish?: boolean}>}
 * @throws {import('../../shared/httpErrors').HttpError} 400 on bad input
 */
function normalizeScopes(input) {
    if (!isPlainObject(input)) throw badRequest('invalid_scopes', 'Scopes must be an object keyed by server.');
    const keys = Object.keys(input);
    if (keys.length === 0) throw badRequest('invalid_scopes', 'A token needs access to at least one server.');
    /** @type {Record<string, any>} */
    const out = {};
    for (const server of keys) {
        if (!SERVERS.includes(server)) {
            throw badRequest('invalid_scopes', `Unknown server "${server.slice(0, 40)}". Choose from: ${SERVERS.join(', ')}.`);
        }
        const spec = input[server];
        if (!isPlainObject(spec)) throw badRequest('invalid_scopes', `The scope for "${server}" must be an object.`);
        for (const key of Object.keys(spec)) {
            if (key === 'level' || key === 'tools' || (key === 'publish' && server === 'cms')) continue;
            throw badRequest('invalid_scopes', `"${key}" is not a valid setting for "${server}".`);
        }
        if (!LEVELS.includes(spec.level)) {
            throw badRequest('invalid_scopes', `The level for "${server}" must be "read" or "write".`);
        }
        const entry = { level: spec.level };
        if (spec.tools !== undefined && spec.tools !== null) {
            if (!Array.isArray(spec.tools)) throw badRequest('invalid_scopes', `The tool list for "${server}" must be an array of names.`);
            if (spec.tools.length > MAX_TOOLS) throw badRequest('invalid_scopes', `The tool list for "${server}" can hold at most ${MAX_TOOLS} names.`);
            const names = [];
            for (const name of spec.tools) {
                if (typeof name !== 'string' || !name.trim() || name.length > MAX_TOOL_NAME) {
                    throw badRequest('invalid_scopes', `The tool list for "${server}" holds an invalid name.`);
                }
                if (!names.includes(name.trim())) names.push(name.trim());
            }
            if (names.length > 0) entry.tools = names;
        }
        if (server === 'cms') {
            if (spec.publish !== undefined && typeof spec.publish !== 'boolean') {
                throw badRequest('invalid_scopes', 'cms.publish must be true or false.');
            }
            if (spec.publish === true && spec.level === 'read') {
                throw badRequest('invalid_scopes', 'cms.publish needs the "write" level.');
            }
            entry.publish = spec.publish === true;
        }
        out[server] = entry;
    }
    return out;
}

/**
 * May a token with these scopes call `toolName` on `server`?
 *
 * Fail closed on anything unexpected: a missing server, an unknown level, a
 * `read` token and a tool that is not positively known to be read-only.
 *
 * @param {Record<string, any>|null|undefined} scopes
 * @param {string} server
 * @param {string} toolName
 * @param {{ readOnly?: boolean, publish?: boolean }} [flags]
 * @returns {boolean}
 */
function scopeAllowsTool(scopes, server, toolName, { readOnly = false, publish = false } = {}) {
    const spec = isPlainObject(scopes) ? scopes[server] : undefined;
    if (!isPlainObject(spec)) return false;
    if (spec.level !== 'read' && spec.level !== 'write') return false;
    if (spec.level === 'read' && readOnly !== true) return false;
    if (publish === true && spec.publish !== true) return false;
    if (Array.isArray(spec.tools) && !spec.tools.includes(toolName)) return false;
    return true;
}

/**
 * Keep the tools of an MCP tools/list answer the scopes allow.
 *
 * @template {{ name: string, annotations?: any }} T
 * @param {Record<string, any>|null|undefined} scopes
 * @param {string} server
 * @param {T[]} tools
 * @param {{ isReadOnly?: (tool: T) => boolean, isPublish?: (tool: T) => boolean }} [classify]
 * @returns {T[]}
 */
function filterToolsByScope(scopes, server, tools, { isReadOnly, isPublish } = {}) {
    const readOnlyOf = isReadOnly || ((t) => t?.annotations?.readOnlyHint === true);
    const publishOf = isPublish || (() => false);
    return (tools || []).filter((tool) => scopeAllowsTool(scopes, server, tool?.name, {
        readOnly: readOnlyOf(tool) === true,
        publish: publishOf(tool) === true,
    }));
}

module.exports = { SERVERS, LEVELS, LEGACY_SCOPES, normalizeScopes, scopeAllowsTool, filterToolsByScope };
