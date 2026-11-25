// @typecheck
/**
 * The apps a Cowork run may use while nobody watches (./runApps.mts): a tool of an app on the organisation's list
 * stays, a tool of no app stays, the rest goes; no list is every app; a tool nobody can attribute goes while a list
 * holds. With the real tool registry loaded, the same holds for real tool names.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test core/cowork/runApps.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { withinApps, appsLeftOut, appsOfRun, withinRunApps } = require('./runApps.mts');

/** @param {string} name */
const tool = (name, extra = {}) => ({ function: { name }, ...extra });
/** @type {Record<string, string | null>} */
const APPS = { gmail_search: 'gmail', outlook_create_draft: 'outlook', web_search: null, set_reminder: null };
/** @param {{ function?: { name?: unknown } | null } | null | undefined} t */
const appOf = (t) => (typeof t?.function?.name === 'string' && t.function.name in APPS ? APPS[t.function.name] : undefined);
const names = (/** @type {Array<{ function: { name: string } }>} */ tools) => tools.map((t) => t.function.name);

test('under a list, a tool of a listed app and a tool of no app stay; another app\'s tool goes', () => {
    const tools = ['gmail_search', 'outlook_create_draft', 'web_search', 'set_reminder'].map((n) => tool(n));
    assert.deepStrictEqual(names(withinApps(tools, ['gmail'], appOf)), ['gmail_search', 'web_search', 'set_reminder']);
    assert.deepStrictEqual(appsLeftOut(tools, ['gmail'], appOf), ['outlook']);
});

test('no list is every app; an empty list keeps only the tools of no app', () => {
    const tools = ['gmail_search', 'outlook_create_draft', 'web_search'].map((n) => tool(n));
    assert.strictEqual(withinApps(tools, null, appOf), tools);
    assert.deepStrictEqual(names(withinApps(tools, [], appOf)), ['web_search']);
});

test('a tool nobody can attribute goes while a list holds, except the review tool', () => {
    const tools = [tool('mystery_tool'), tool('cowork_request_review'), tool('gmail_search')];
    assert.deepStrictEqual(names(withinApps(tools, ['gmail'], appOf)), ['cowork_request_review', 'gmail_search']);
    const blind = () => undefined;
    assert.deepStrictEqual(names(withinApps(tools, ['gmail'], blind)), ['cowork_request_review'], 'a registry that cannot tell closes everything else');
});

test('the list travels on the task; anything but a list of strings is no list', () => {
    assert.deepStrictEqual(appsOfRun({ unattendedApps: ['gmail', 7] }), ['gmail']);
    assert.strictEqual(appsOfRun({ unattendedApps: null }), null);
    assert.strictEqual(appsOfRun({}), null);
    assert.strictEqual(appsOfRun(null), null);
});

test('with the real registry: under ["gmail"], a prompt run keeps gmail tools and loses outlook\'s and an MCP server\'s', () => {
    const { appIdForTool, isAttributionAvailable } = require('../agentRuntime/toolPolicy/appIndex.js');
    assert.ok(isAttributionAvailable(), 'run with --require ./testUtils/registerFeatures.js');
    const gmail = ['gmail_search', 'gmail_search_emails', 'gmail_list_messages'].find((n) => appIdForTool(n) === 'gmail');
    const outlook = ['outlook_search', 'outlook_search_emails', 'outlook_list_messages', 'outlook_create_draft'].find((n) => appIdForTool(n) === 'outlook');
    assert.ok(gmail && outlook, 'a gmail and an outlook tool name exist in the registry');
    const tools = [tool(gmail), tool(outlook), tool('anything', { _mcp: { serverId: 'srv1' } })];
    assert.deepStrictEqual(names(withinRunApps({ unattendedApps: ['gmail'] }, tools)), [gmail]);
    assert.strictEqual(withinRunApps({ unattendedApps: null }, tools).length, 3);
});
