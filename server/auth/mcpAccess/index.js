// @typecheck
/**
 * MCP access: named tokens, scopes, the org policy and the one gate every
 * Bee Flow MCP endpoint goes through. See gate.js for the order of checks.
 */

'use strict';

const tokenStore = require('./tokenStore');
const scopes = require('./scopes');
const ipMatch = require('./ipMatch');
const orgPolicy = require('./orgPolicy');
const gate = require('./gate');

module.exports = {
    createToken: tokenStore.createToken,
    listTokens: tokenStore.listTokens,
    revokeToken: tokenStore.revokeToken,
    findByPresented: tokenStore.findByPresented,
    getTokenById: tokenStore.getTokenById,
    touchLastUsed: tokenStore.touchLastUsed,
    SERVERS: scopes.SERVERS,
    LEGACY_SCOPES: scopes.LEGACY_SCOPES,
    normalizeScopes: scopes.normalizeScopes,
    scopeAllowsTool: scopes.scopeAllowsTool,
    filterToolsByScope: scopes.filterToolsByScope,
    parseCidrList: ipMatch.parseCidrList,
    ipAllowed: ipMatch.ipAllowed,
    getOrgMcpPolicy: orgPolicy.getOrgMcpPolicy,
    saveOrgMcpPolicy: orgPolicy.saveOrgMcpPolicy,
    evaluateAccess: gate.evaluateAccess,
    evaluateAccessForOrgs: gate.evaluateAccessForOrgs,
    gateRequest: gate.gateRequest,
    rpcDenied: gate.rpcDenied,
};
