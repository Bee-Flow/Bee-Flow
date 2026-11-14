// @typecheck
'use strict';

/**
 * Characterisation (golden) test for executeCustomIntegrationTool: for each
 * scenario the returned object and every call the run makes on its
 * collaborators, in order (run gate, integration store, user lookup, org
 * resolution, entitlements, the remote-MCP delegate, connection store, the
 * outbound guard's target check and fetch with the exact url, method, headers
 * and body, the usage stamp and the log lines). Scenarios reach each refusal
 * and each branch: both run-gate switches, name parsing, the slug re-assert,
 * the organisation check, status, unattended runs, the capability backstop,
 * the remote-MCP delegation, the definition and method gates, argument
 * validation, credential resolution, the URL build, the target check, headers
 * and body, every auth type, transport failures, the capped read, vendor
 * errors, response shaping and the unexpected-failure path.
 *
 * The collaborators go in through the function's own deps parameter.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test integrations/customIntegrationRunner.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { executeCustomIntegrationTool, _internals } = require('./customIntegrationRunner');

const GOLDEN = path.join(__dirname, 'customIntegrationRunner.characterisation.golden.json');

const SLUG = 'acme1234';
// Credential-shaped values are built here so the secret scanner never meets one in this file.
const TOKEN = ['tok', 'ZYXWVUTSRQ', '987654'].join('-');
const PASS = ['pw', 'abcdefghij', '123456'].join('-');

/** @param {Record<string, unknown>} [over] */
const restDef = (over = {}) => ({
    api: { baseUrl: 'https://api.example.com/v2/', defaultHeaders: { 'X-App': 'bf', Authorization: 'never', 'X-Forwarded-For': '1.2.3.4' } },
    auth: { type: 'bearer', valueTemplate: 'Bearer {{credential.token}}' },
    tools: [
        null,
        {
            name: 'list_items', method: 'get', pathTemplate: '/items/{id}', query: { q: '{q}', tags: '{tags}', fixed: '1' },
            headers: { 'X-Tool': 'list' }, resultPath: 'data',
            parameters: { properties: { id: { type: 'string' }, q: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['id'] },
        },
        {
            name: 'create_item', method: 'POST', pathTemplate: '/items',
            body: { mode: 'json', template: { name: '{name}', n: '{n}', list: ['{name}', 'x'], kind: 'fixed' } },
            parameters: { properties: { name: { type: 'string' }, n: { type: 'integer' } } },
        },
        {
            name: 'put_item', method: 'PUT', pathTemplate: '/items/{id}', headers: { 'content-type': 'application/vnd.x+json' },
            body: { mode: 'json' }, parameters: { properties: { id: { type: 'string' } } },
        },
        { name: 'get_body', method: 'GET', pathTemplate: '/echo', body: { mode: 'json', template: { a: 1 } } },
        { name: 'form_item', method: 'DELETE', pathTemplate: '/items/{id}', body: { mode: 'form' }, parameters: { properties: { id: { type: 'string' } } } },
        { name: 'free_path', method: 'GET', pathTemplate: '/x/{p}', parameters: { properties: { p: { type: 'string' } } } },
        { name: 'bad_method', method: 'TRACE', pathTemplate: '/x' },
        { name: 'no_method', pathTemplate: '/x' },
    ],
    ...over,
});

/** @param {Record<string, unknown>} [over] */
const row = (over = {}) => ({
    id: 'int-1', slug: SLUG, orgId: 'org-a', status: 'active', kind: 'rest', allowWrites: false,
    activatedDefinition: restDef(), definition: restDef({ api: { baseUrl: 'https://draft.example.com' } }),
    ...over,
});

/** @param {Record<string, unknown>} [over] */
const conn = (over = {}) => ({
    id: 'conn-1', provider: 'custom:int-1', status: 'active', orgId: 'org-a',
    secretMeta: { boundOrigin: 'https://api.example.com' }, secret: { token: TOKEN, username: 'svc-user', password: PASS, n: 5 },
    ...over,
});

/** A function answering a fresh Response. */
const answer = (/** @type {any} */ body, /** @type {{ status?: number, type?: string | null }} */ { status = 200, type = 'application/json' } = {}) => () => new Response(
    body === null || typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
    { status, headers: type ? { 'content-type': type } : {} },
);

const withAuth = (/** @type {Record<string, unknown>} */ auth) => row({ activatedDefinition: restDef({ auth }) });
const withApi = (/** @type {Record<string, unknown>} */ api) => row({ activatedDefinition: restDef({ api: { baseUrl: 'https://api.example.com', ...api } }) });
const LIST = `cint_${SLUG}_list_items`;
const OK = answer({ data: [{ id: 1 }], other: true });

/**
 * name → { name, args, opts, env }. env: gate, row, user, capability,
 * resolution, conn, guard, fetch (a function answering a Response, or throwing).
 * @type {Record<string, { name?: unknown, args?: unknown, opts?: Record<string, unknown>, env?: Record<string, any> }>}
 */
const CASES = {
    // run gate
    gateAllOff: { env: { gate: { anyRunnable: false } } },
    gateDraftBuilderOff: { opts: { draftIntegration: row() }, env: { gate: { builderEnabled: false } } },
    gateThrows: { env: { gateThrows: new Error('config down') } },
    // name + row
    nameNotCint: { name: 'afas_list' },
    nameNoTool: { name: `cint_${SLUG}` },
    nameBadSlug: { name: 'cint_ab_list_items' },
    nameNotAString: { name: 42 },
    nameNull: { name: null },
    rowMissing: { env: { row: null } },
    rowOtherSlug: { env: { row: row({ slug: 'other5678' }) } },
    rowSlugNotAString: { env: { row: row({ slug: 7 }) } },
    rowSlugAListOfTheSlug: { env: { row: row({ slug: [SLUG] }) } },
    draftOtherSlug: { opts: { draftIntegration: row({ slug: 'other5678' }) } },
    rowNotRunnable: { env: { gate: { runnable: false } } },
    draftSkipsRunnable: { opts: { draftIntegration: row({ definition: restDef() }) }, args: { id: 'a' }, env: { gate: { runnable: false }, fetch: OK } },
    storeThrows: { env: { getBySlugThrows: new Error('db down') } },
    storeLoadThrows: { env: { integrationStoreThrows: new Error('module missing') } },
    // organisation, status, unattended
    noUserId: { opts: { userId: null } },
    userLookupThrows: { env: { getUserThrows: new Error('db down') } },
    userMissing: { env: { user: null } },
    otherOrganisation: { env: { user: { id: 'u-1', organizationId: 'org-b' } } },
    bothDefaultOrganisation: { args: { id: 'a' }, env: { user: { id: 'u-1' }, row: row({ orgId: null }), conn: conn({ orgId: null }), fetch: OK } },
    otherOrganisationBeforeStatus: { env: { user: { id: 'u-1', organizationId: 'org-b' }, row: row({ status: 'draft' }) } },
    notActive: { env: { row: row({ status: 'draft' }) } },
    draftNotActive: { opts: { draftIntegration: row({ status: 'draft', definition: restDef() }) }, args: { id: 'a' }, env: { fetch: OK } },
    unattended: { opts: { unattended: true } },
    unattendedTruthyOnly: { opts: { unattended: 'yes' }, args: { id: 'a' }, env: { fetch: OK } },
    unattendedBeforeCapability: { opts: { unattended: true }, env: { capability: false } },
    // capability backstop
    capabilityOff: { env: { capability: false } },
    capabilityThrows: { env: { capabilityThrows: new Error('entitlements down') } },
    capabilityTruthy: { args: { id: 'a' }, env: { capability: 'yes', fetch: OK } },
    draftSkipsCapability: { opts: { draftIntegration: row({ definition: restDef() }) }, args: { id: 'a' }, env: { capability: false, fetch: OK } },
    capabilityBeforeMcp: { env: { capability: false, row: row({ kind: 'mcp_remote' }) } },
    // remote MCP
    mcpResult: { args: { q: 1 }, env: { row: row({ kind: 'mcp_remote', activatedDefinition: null }), mcp: { result: 'done', truncated: true } } },
    mcpRefusal: { env: { row: row({ kind: 'mcp_remote' }), mcp: { refusal: 'Tool "list_items" is not part of this integration.' } } },
    mcpThrows: { env: { row: row({ kind: 'mcp_remote' }), mcpThrows: new Error('socket closed') } },
    mcpDraft: { opts: { draftIntegration: row({ kind: 'mcp_remote' }) }, env: { mcp: { result: '{}' } } },
    // definition
    definitionMissing: { env: { row: row({ activatedDefinition: null }) } },
    definitionNotAnObject: { env: { row: row({ activatedDefinition: 'x' }) } },
    definitionNoApi: { env: { row: row({ activatedDefinition: { tools: [] } }) } },
    definitionApiNotAnObject: { env: { row: row({ activatedDefinition: { api: 'x', tools: [] } }) } },
    definitionToolsNotAList: { env: { row: row({ activatedDefinition: { api: {}, tools: {} } }) } },
    definitionBadBaseUrl: { env: { row: row({ activatedDefinition: restDef({ api: { baseUrl: 'not a url' } }) }) } },
    definitionToolUnknown: { name: `cint_${SLUG}_nope_tool` },
    draftRunsWorkingDefinition: { opts: { draftIntegration: row({ definition: restDef({ auth: { type: 'none' }, api: { baseUrl: 'https://draft.example.com/' } }), activatedDefinition: null }) }, args: { id: 'a' }, env: { fetch: OK } },
    activeRunsFrozenDefinition: { args: { id: 'a' }, env: { row: row({ definition: null }), fetch: OK } },
    // method gate
    methodInvalid: { name: `cint_${SLUG}_bad_method` },
    methodMissing: { name: `cint_${SLUG}_no_method` },
    writeNotAllowed: { name: `cint_${SLUG}_create_item`, args: { name: 'x' } },
    writeNotAllowedTruthy: { name: `cint_${SLUG}_create_item`, args: { name: 'x' }, env: { row: row({ allowWrites: 'true' }) } },
    writeNotAllowedDraft: { name: `cint_${SLUG}_create_item`, opts: { draftIntegration: row({ definition: restDef() }) } },
    methodBeforeArguments: { name: `cint_${SLUG}_create_item`, args: { bogus: 1 } },
    // arguments
    argsUnknown: { args: { id: 'a', bogus: 1 } },
    argsMissingRequired: { args: {} },
    argsNull: { name: `cint_${SLUG}_free_path`, args: null },
    argsNotAnObject: { args: 'id=a' },
    argsList: { args: ['a'] },
    argsBeforeCredentials: { args: { bogus: 1 }, env: { resolution: { available: false } } },
    // credentials
    authNone: { args: { id: 'a' }, env: { row: withAuth({ type: 'none' }), fetch: OK } },
    authNotAnObject: { args: { id: 'a' }, env: { row: row({ activatedDefinition: restDef({ auth: 'bearer' }) }), fetch: OK } },
    credentialsNone: { args: { id: 'a' }, env: { resolution: { available: false } } },
    credentialsNoConnectionId: { args: { id: 'a' }, env: { resolution: { available: true, connectionId: null } } },
    credentialsOverride: { args: { id: 'a' }, opts: { connectionOverrideId: 'conn-9' }, env: { fetch: OK } },
    credentialsOverrideOtherProvider: { args: { id: 'a' }, opts: { connectionOverrideId: 'conn-9' }, env: { conn: conn({ provider: 'custom:int-2' }) } },
    credentialsInactive: { args: { id: 'a' }, env: { conn: conn({ status: 'revoked' }) } },
    credentialsGone: { args: { id: 'a' }, env: { conn: null } },
    credentialsOtherOrganisation: { args: { id: 'a' }, env: { conn: conn({ orgId: 'org-b' }) } },
    credentialsOtherHost: { args: { id: 'a' }, env: { conn: conn({ secretMeta: { boundOrigin: 'https://evil.example.com' } }) } },
    credentialsUnreadable: { args: { id: 'a' }, env: { conn: conn({ secret: null }) } },
    credentialsThrow: { args: { id: 'a' }, env: { resolveThrows: new Error('vault down') } },
    credentialsBeforeUrl: { name: `cint_${SLUG}_free_path`, args: {}, env: { resolution: { available: false } } },
    // url + target check
    urlMissingPathParam: { name: `cint_${SLUG}_free_path`, args: {} },
    urlTraversal: { name: `cint_${SLUG}_free_path`, args: { p: '..' } },
    urlEncodesPathAndQuery: { args: { id: 'a b/c', q: 'x&y=z', tags: ['t1', 't2'] }, env: { fetch: OK } },
    guardRefusesWithSafeMessage: { args: { id: 'a' }, env: { guardThrows: new Error('Target host could not be resolved.') } },
    guardRefusesWithOtherMessage: { args: { id: 'a' }, env: { guardThrows: new Error(`lookup failed for ${TOKEN}`) } },
    guardThrowsNothing: { args: { id: 'a' }, env: { guardThrows: null } },
    guardBeforeAuthRender: { args: { id: 'a' }, env: { guardThrows: new Error('Target address is not allowed.'), conn: conn({ secret: { other: 'x' } }) } },
    // headers, body, auth
    bodyJson: { name: `cint_${SLUG}_create_item`, args: { name: 'Widget', n: 3 }, env: { row: row({ allowWrites: true }), fetch: answer({ id: 9 }, { status: 201 }) } },
    bodyJsonOptionalAbsent: { name: `cint_${SLUG}_create_item`, args: {}, env: { row: row({ allowWrites: true }), fetch: answer({ id: 9 }) } },
    bodyNoTemplateKeepsContentType: { name: `cint_${SLUG}_put_item`, args: { id: 'a' }, env: { row: row({ allowWrites: true }), fetch: answer({}) } },
    bodyDroppedOnGet: { name: `cint_${SLUG}_get_body`, env: { fetch: OK } },
    bodyOtherModeIgnored: { name: `cint_${SLUG}_form_item`, args: { id: 'a' }, env: { row: row({ allowWrites: true }), fetch: answer(null, { status: 204, type: null }) } },
    authBasic: { args: { id: 'a' }, env: { row: withAuth({ type: 'basic' }), fetch: OK } },
    authBasicIncomplete: { args: { id: 'a' }, env: { row: withAuth({ type: 'basic' }), conn: conn({ secret: { username: 'svc-user' } }) } },
    authHeader: { args: { id: 'a' }, env: { row: withAuth({ type: 'header', header: 'X-Api-Key', valueTemplate: '{{credential.token}}' }), fetch: OK } },
    authQuery: { args: { id: 'a', q: 'find' }, env: { row: withAuth({ type: 'query', queryParam: 'api_key', valueTemplate: '{{credential.token}}' }), fetch: OK } },
    authUnknownType: { args: { id: 'a' }, env: { row: withAuth({ type: 'oauth2', valueTemplate: '{{credential.token}}' }), fetch: OK } },
    authTemplateMissing: { args: { id: 'a' }, env: { row: withAuth({ type: 'bearer' }) } },
    authCredentialKeyMissing: { args: { id: 'a' }, env: { row: withAuth({ type: 'bearer', valueTemplate: 'Bearer {{credential.apiKey}}' }) } },
    // transport
    fetchAbortError: { args: { id: 'a' }, env: { row: withApi({ timeoutMs: 500 }), fetchThrows: Object.assign(new Error('aborted'), { name: 'AbortError' }) } },
    fetchAbortErrorLongTimeout: { args: { id: 'a' }, env: { row: withApi({ timeoutMs: 99999 }), fetchThrows: Object.assign(new Error('aborted'), { name: 'AbortError' }) } },
    fetchAbortErrorDefaultTimeout: { args: { id: 'a' }, env: { row: withApi({ timeoutMs: 2500.5 }), fetchThrows: Object.assign(new Error('aborted'), { name: 'AbortError' }) } },
    fetchTimesOut: { args: { id: 'a' }, env: { row: withApi({ timeoutMs: 1 }), fetchWaitsForAbort: true } },
    fetchGuardMessage: { args: { id: 'a' }, env: { fetchThrows: new Error('Target address is not allowed.') } },
    fetchOtherError: { args: { id: 'a' }, env: { fetchThrows: new Error(`connect ECONNREFUSED https://api.example.com/?api_key=${TOKEN}`) } },
    fetchThrowsNothing: { args: { id: 'a' }, env: { fetchThrows: null } },
    // reading the answer
    answerTooLarge: { args: { id: 'a' }, env: { fetch: answer('x'.repeat(262145), { type: 'text/plain' }) } },
    answerAtTheLimit: { args: { id: 'a' }, env: { row: withApi({ maxResponseChars: 1000 }), fetch: answer('x'.repeat(262144), { type: 'text/plain' }) } },
    answerReadFails: { args: { id: 'a' }, env: { fetch: () => new Response(new ReadableStream({ pull(c) { c.error(new Error(`reset ${TOKEN}`)); } }), { status: 200 }) } },
    answerNoBody: { name: `cint_${SLUG}_free_path`, args: { p: 'a' }, env: { fetch: answer(null, { status: 204, type: null }) } },
    vendorErrorJson: { args: { id: 'a' }, env: { fetch: answer({ message: `Bad token ${TOKEN} for <b>you</b>` }, { status: 401 }) } },
    vendorErrorNested: { args: { id: 'a' }, env: { fetch: answer([{ error: { message: 'Quota   exceeded' } }], { status: 429 }) } },
    vendorErrorXml: { args: { id: 'a' }, env: { fetch: answer('<fault><message>No such item</message></fault>', { status: 404, type: 'application/xml' }) } },
    vendorErrorNoDetail: { args: { id: 'a' }, env: { fetch: answer('gateway melted', { status: 502, type: 'text/plain' }) } },
    vendorErrorNoStamp: { args: { id: 'a' }, env: { fetch: answer({}, { status: 500 }) } },
    // usage stamp + shaping
    stampFailureIgnored: { args: { id: 'a' }, env: { touchThrows: new Error('db down'), fetch: OK } },
    jsonResultPath: { args: { id: 'a' }, env: { fetch: OK } },
    jsonResultPathMissing: { args: { id: 'a' }, env: { fetch: answer({ rows: [1, 2] }) } },
    jsonPlusSuffix: { args: { id: 'a' }, env: { fetch: answer({ data: 1 }, { type: 'application/problem+json; charset=utf-8' }) } },
    jsonInvalid: { args: { id: 'a' }, env: { fetch: answer('{nope', {}) } },
    jsonTruncated: { args: { id: 'a' }, env: { row: withApi({ maxResponseChars: 1200 }), fetch: answer({ data: 'y'.repeat(5000) }) } },
    jsonBudgetFloor: { args: { id: 'a' }, env: { row: withApi({ maxResponseChars: 10 }), fetch: answer({ data: 'y'.repeat(1500) }) } },
    jsonBudgetCeiling: { args: { id: 'a' }, env: { row: withApi({ maxResponseChars: 900000 }), fetch: answer({ data: 'y'.repeat(31000) }) } },
    jsonEchoesSecret: { args: { id: 'a' }, env: { fetch: answer({ data: { seen: `Bearer ${TOKEN}`, b64: Buffer.from(TOKEN).toString('base64') } }) } },
    basicEchoesComposedSecret: { args: { id: 'a' }, env: { row: withAuth({ type: 'basic' }), fetch: answer(`auth was Basic ${Buffer.from(`svc-user:${PASS}`).toString('base64')}`, { type: 'text/plain' }) } },
    textResult: { args: { id: 'a' }, env: { fetch: answer('plain words', { type: 'text/csv' }) } },
    binaryResult: { args: { id: 'a' }, env: { fetch: answer('%PDF-1.7', { type: 'application/pdf' }) } },
    noContentType: { args: { id: 'a' }, env: { fetch: answer(Buffer.from('??'), { type: null }) } },
    // unexpected failure
    unexpectedFailure: { args: { id: 'a' }, env: { fetch: () => ({ ok: true, status: 200, body: null, headers: { get() { throw new Error(`boom ${TOKEN}`); } } }) } },
    unexpectedFailureLongName: { name: `cint_${SLUG}_${'a'.repeat(30)}`, env: { getBySlugThrows: new Error('db down') } },
    unexpectedFailureNameCutInTheLog: { name: `cint_${'x'.repeat(120)}`, env: { gateThrows: new Error('config down') } },
};

/**
 * @param {Record<string, any>} env
 * @param {unknown[][]} calls
 */
function depsFor(env, calls) {
    const record = (/** @type {unknown[]} */ ...c) => { calls.push(JSON.parse(JSON.stringify(c, (_k, v) => (v === undefined ? '<undefined>' : v)))); };
    const gate = { anyRunnable: true, builderEnabled: true, runnable: true, ...(env.gate || {}) };
    const connStore = {
        resolveOrgId: (/** @type {unknown} */ id) => { record('conn.resolveOrgId', id); return id || 'org-default'; },
        resolveConnectionForRun: async (/** @type {unknown} */ q) => {
            record('conn.resolveConnectionForRun', q);
            if (env.resolveThrows) throw env.resolveThrows;
            return env.resolution || { available: true, connectionId: 'conn-1' };
        },
        getConnectionWithSecret: async (/** @type {string} */ id) => { record('conn.getConnectionWithSecret', id); return 'conn' in env ? env.conn : conn(); },
        touchLastUsed: async (/** @type {string} */ id) => { record('conn.touchLastUsed', id); if (env.touchThrows) throw env.touchThrows; },
    };
    return {
        ..._internals.RUN_DEPS,
        loadRunGate: async () => {
            record('gate.load');
            if (env.gateThrows) throw env.gateThrows;
            return { anyRunnable: gate.anyRunnable, builderEnabled: gate.builderEnabled, isRunnable: (/** @type {{ slug?: unknown }} */ r) => { record('gate.isRunnable', r && r.slug); return gate.runnable; } };
        },
        integrationStore: () => {
            record('integrationStore');
            if (env.integrationStoreThrows) throw env.integrationStoreThrows;
            return { getBySlug: async (/** @type {string} */ slug) => { record('store.getBySlug', slug); if (env.getBySlugThrows) throw env.getBySlugThrows; return 'row' in env ? env.row : row(); } };
        },
        connectionStore: () => { record('connectionStore'); return connStore; },
        getUser: async (/** @type {string} */ id) => {
            record('getUser', id);
            if (env.getUserThrows) throw env.getUserThrows;
            return 'user' in env ? env.user : { id, organizationId: 'org-a' };
        },
        hasCapability: async (/** @type {string} */ cap, /** @type {unknown} */ who) => {
            record('hasCapability', cap, who);
            if (env.capabilityThrows) throw env.capabilityThrows;
            return 'capability' in env ? env.capability : true;
        },
        callRemoteMcpTool: async (/** @type {{ slug: string }} */ integration, /** @type {unknown} */ call) => {
            record('callRemoteMcpTool', integration.slug, call);
            if (env.mcpThrows) throw env.mcpThrows;
            return env.mcp;
        },
        ssrfGuard: {
            assertPublicHttpsTarget: async (/** @type {string} */ href) => { record('guard.assertPublicHttpsTarget', href); if ('guardThrows' in env) throw env.guardThrows; },
            safeFetch: async (/** @type {string} */ href, /** @type {{ method: string, headers: unknown, body: unknown, signal: AbortSignal }} */ init) => {
                record('guard.safeFetch', href, { method: init.method, headers: init.headers, body: init.body, signal: init.signal instanceof AbortSignal });
                if (env.fetchWaitsForAbort) {
                    // The run's own timer is unref'd: this one keeps the loop alive until it fires.
                    const keepAlive = setTimeout(() => {}, 10_000);
                    await new Promise((resolve) => init.signal.addEventListener('abort', resolve));
                    clearTimeout(keepAlive);
                    throw new Error('socket hang up');
                }
                if ('fetchThrows' in env) throw env.fetchThrows;
                return env.fetch();
            },
        },
        log: { info: (/** @type {unknown[]} */ ...a) => record('log.info', ...a), warn: (/** @type {unknown[]} */ ...a) => record('log.warn', ...a) },
    };
}

/** The credential forms a request may carry, named, so the golden holds no credential-shaped text. */
const MASKS = [
    [Buffer.from(`svc-user:${PASS}`).toString('base64'), '<base64 of user:password>'],
    [TOKEN, '<token>'],
    [PASS, '<password>'],
];
/** @param {string} text */
const masked = (text) => MASKS.reduce((out, [form, label]) => out.split(form).join(label), text);

/**
 * What the golden keeps of a value: credentials by name, a long string as its length and digest.
 * @param {unknown} value
 */
const compact = (value) => JSON.parse(JSON.stringify(value === undefined ? '<undefined>' : value, (_k, v) => {
    if (typeof v !== 'string') return v;
    return v.length > 400 ? `<${v.length} chars, sha256 ${crypto.createHash('sha256').update(v).digest('hex').slice(0, 16)}>` : masked(v);
}));

/** @param {string} name */
async function runCase(name) {
    const c = CASES[name];
    /** @type {unknown[][]} */
    const calls = [];
    const deps = /** @type {any} */ (depsFor(c.env || {}, calls));
    const toolName = 'name' in c ? c.name : LIST;
    const result = await executeCustomIntegrationTool(/** @type {string} */ (toolName), /** @type {any} */ (c.args), { userId: 'u-1', ...(c.opts || {}) }, deps);
    return { result: compact(result), calls: compact(calls), raw: result };
}

test('executeCustomIntegrationTool: result and collaborator calls per scenario match the golden file', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const name of Object.keys(CASES)) { const { result, calls } = await runCase(name); actual[name] = { result, calls }; }
    const text = `${JSON.stringify(actual, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, text);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const name of Object.keys(CASES)) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual[name])), golden[name], `scenario ${name}`);
    }
    assert.deepStrictEqual(Object.keys(golden), Object.keys(CASES));
});

test('executeCustomIntegrationTool: no secret reaches a result or a log line', async () => {
    const forms = [TOKEN, PASS, Buffer.from(TOKEN).toString('base64'), Buffer.from(`svc-user:${PASS}`).toString('base64')];
    for (const name of Object.keys(CASES)) {
        const { raw, calls } = await runCase(name);
        const visible = JSON.stringify([raw, calls.filter((c) => String(c[0]).startsWith('log.'))]);
        for (const form of forms) assert.ok(!visible.includes(form), `scenario ${name} shows a credential`);
    }
});
