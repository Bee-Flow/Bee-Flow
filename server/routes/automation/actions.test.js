/**
 * routes/automation/actions.js — duplicate, save as template, the description
 * suggestion and the header counts, over a real Express app with every
 * dependency injected through makeActionsRouter (no module mocking).
 *
 * Proven:
 *   - duplicate: a new draft "<title> (copy)" owned by the caller, same
 *     definition minus the app-button back-pointer, same folder and icon,
 *     described as a copy; form, usage and knowledge links provisioned;
 *   - save as template: edit only; the export sanitiser runs (pinned samples
 *     and the test input do not travel); the card comes back as source 'org';
 *   - suggest-description: the fast tier, the step summary and step names in,
 *     one cleaned sentence out; a model failure is a 502 with a code; an
 *     empty automation is refused before any model call;
 *   - counts: run-only callers count only their own runs;
 *   - roles: a viewer may duplicate but not template or suggest.
 *
 * Run: cd server && node --test routes/automation/actions.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeActionsRouter, copyTitle, sanitiseSuggestion } = require('./actions');
const { serve } = require('../../core/http/routeHarness');
const { accessByRole } = require('./testing/accessByRole');

const DEF = {
    trigger: { id: 't', type: 'trigger', kind: 'manual', appRef: { appId: 'app1', screenId: 's', componentId: 'c' } },
    steps: [
        { id: 'read', type: 'integration_action', tool: 'nextcloud_list_files', label: 'Read invoice', pinnedOutput: { files: ['secret.pdf'] } },
        { id: 'n', type: 'note', text: 'hi' },
    ],
    edges: [{ from: 't', to: 'read' }],
    manualTriggerPayload: { subject: 'Invoice from Jan' },
};

let calls;
let automations;
let chatImpl;

function fakeStore() {
    return {
        async getAutomation(id) { return automations[id] ? { ...automations[id] } : null; },
        async createAutomation(input) {
            calls.create.push(input);
            const row = { id: 'copy1', userId: input.userId, title: input.title, description: input.description, definition: input.definition, version: 1, isDraft: true, isActive: false, builderSession: { secret: true } };
            automations.copy1 = row;
            return { ...row };
        },
        async updateAutomation(id, updates) {
            calls.update.push([id, updates]);
            Object.assign(automations[id], updates);
            return { ...automations[id] };
        },
        async createAutomationTemplate(input) {
            calls.template.push(input);
            return { id: 'org-t1', ...input, createdAt: '2026-09-28T10:00:00.000Z' };
        },
        async countsForAutomation(id, opts) {
            calls.counts.push([id, opts]);
            return { runs7d: opts.onlyUserId ? 1 : 12, runsFailed7d: opts.onlyUserId ? 0 : 1, versions: 5 };
        },
    };
}

const access = accessByRole({ owner: 'owner', ed: 'edit', vic: 'view', ron: 'run' });

let api;

beforeEach(() => {
    calls = { create: [], update: [], template: [], counts: [], provision: [], usage: [], kb: [], chat: [], model: [] };
    automations = {
        a1: { id: 'a1', userId: 'owner', kind: 'automation', title: 'Invoices', description: 'Reads invoices', icon: 'file-text', folderId: 'f1', definition: DEF, version: 3, pendingChanges: 2 },
        empty: { id: 'empty', userId: 'owner', title: 'Empty', definition: { trigger: { kind: 'manual' }, steps: [{ id: 'n', type: 'note' }] }, version: 1 },
        blk: { id: 'blk', userId: 'owner', kind: 'block', title: 'Step', definition: DEF, version: 1 },
    };
    chatImpl = async () => ({ content: '  "Every morning this reads new invoices and posts a summary in Talk."  ' });
});

before(() => {
    api = serve('/', makeActionsRouter({
        store: fakeStore(),
        access,
        orgOf: async () => 'org1',
        provisionForm: async (a, def) => { calls.provision.push([a.id, def]); return { answers: null, usage: [] }; },
        syncDatatableUsage: async (...args) => { calls.usage.push(args); },
        syncKbSources: async (...args) => { calls.kb.push(args); },
        validateApprovalAssignees: async () => [],
        resolveModel: async (tier, opts) => { calls.model.push([tier, opts]); return 'fast-model'; },
        chat: async (...args) => { calls.chat.push(args); return chatImpl(); },
        limiter: (req, res, next) => next(),
        log: { warn() {}, error() {} },
    }));
});
after(() => api.close());

const call = (method, path, body, user = 'owner') => api.call(method, path, { body, user: { id: user } });

test('duplicate: a draft copy for the caller, same steps, no app-button link, same folder and icon', async () => {
    const { status, body } = await call('POST', '/a1/duplicate', undefined, 'vic');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.automation.id, 'copy1');
    assert.strictEqual(body.automation.title, 'Invoices (copy)');
    assert.strictEqual(body.automation.myRole, 'owner');
    assert.strictEqual(body.duplicatedFrom, 'a1');
    const [input] = calls.create;
    assert.strictEqual(input.userId, 'vic', 'the copy belongs to whoever made it');
    assert.strictEqual(input.organizationId, 'org1');
    assert.strictEqual(input.definition.trigger.appRef, undefined);
    assert.strictEqual(input.definition.steps[0].id, 'read');
    assert.strictEqual(DEF.trigger.appRef.appId, 'app1', 'the source definition is not touched');
    assert.deepStrictEqual(input.versionMeta.descriptionJson, [{ code: 'duplicated_from', params: { title: 'Invoices', automationId: 'a1' } }]);
    assert.deepStrictEqual(calls.update, [['copy1', { folderId: 'f1', icon: 'file-text' }]]);
    assert.strictEqual(calls.provision.length, 1);
    assert.strictEqual(calls.usage[0][0], 'copy1');
    assert.strictEqual(calls.kb[0][0], 'copy1');
    assert.ok(body.warnings.length >= 1, 'the removed app link is reported');
});

test('duplicate refuses a body, a reusable step, and a stranger', async () => {
    assert.strictEqual((await call('POST', '/a1/duplicate', { title: 'x' })).status, 400);
    const blk = await call('POST', '/blk/duplicate');
    assert.strictEqual(blk.status, 400);
    assert.strictEqual(blk.body.code, 'unsupported_kind');
    assert.strictEqual((await call('POST', '/a1/duplicate', undefined, 'ron')).status, 403);
    assert.strictEqual((await call('POST', '/zz/duplicate')).status, 404);
});

test('save as template: sanitised like an export, source org, edit only', async () => {
    const { status, body } = await call('POST', '/a1/save-as-template', { title: 'Invoice flow' }, 'ed');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.template.id, 'org-t1');
    assert.strictEqual(body.template.source, 'org');
    assert.strictEqual(body.template.title, 'Invoice flow');
    assert.strictEqual(body.template.definition, undefined, 'the card carries no definition');
    const [input] = calls.template;
    assert.strictEqual(input.organizationId, 'org1');
    assert.strictEqual(input.createdBy, 'ed');
    assert.strictEqual(input.description, 'Reads invoices');
    assert.strictEqual(input.icon, 'file-text');
    assert.strictEqual(input.definition.steps[0].pinnedOutput, undefined, 'pinned samples do not travel');
    assert.strictEqual(input.definition.manualTriggerPayload, undefined, 'the test input does not travel');
    assert.strictEqual(input.definition.trigger.appRef, undefined);
    assert.ok(Array.isArray(body.warnings) && body.warnings.length >= 2);
    assert.strictEqual((await call('POST', '/a1/save-as-template', {}, 'vic')).status, 403);
    assert.strictEqual((await call('POST', '/a1/save-as-template', { title: '' })).status, 400);
    const empty = await call('POST', '/empty/save-as-template', {});
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.body.code, 'nothing_to_save');
});

test('suggest-description: fast tier, step summary and names in, one clean sentence out', async () => {
    const { status, body } = await call('POST', '/a1/suggest-description', {}, 'ed');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.description, 'Every morning this reads new invoices and posts a summary in Talk.');
    assert.strictEqual(calls.model[0][0], 'fast');
    const [modelId, messages, opts] = calls.chat[0];
    assert.strictEqual(modelId, 'fast-model');
    assert.match(messages[0].content, /Write in English/);
    assert.match(messages[1].content, /Name: Invoices/);
    assert.match(messages[1].content, /Step names: 2\. Read invoice/);
    assert.doesNotMatch(messages[1].content, /secret\.pdf|Invoice from Jan/, 'no pinned sample, no test input');
    assert.strictEqual(opts.maxTokens, 160);
    const nl = await call('POST', '/a1/suggest-description', { language: 'nl' });
    assert.strictEqual(nl.status, 200);
    assert.match(calls.chat[1][1][0].content, /Write in Dutch/);
});

test('suggest-description: model failure is a 502 with a code; empty automation and viewers are refused first', async () => {
    chatImpl = async () => { throw new Error('upstream'); };
    const failed = await call('POST', '/a1/suggest-description', {});
    assert.strictEqual(failed.status, 502);
    assert.strictEqual(failed.body.code, 'suggestion_failed');
    const empty = await call('POST', '/empty/suggest-description', {});
    assert.strictEqual(empty.status, 400);
    assert.strictEqual(empty.body.code, 'nothing_to_describe');
    assert.strictEqual((await call('POST', '/a1/suggest-description', {}, 'vic')).status, 403);
    assert.strictEqual((await call('POST', '/a1/suggest-description', { language: 'Dutch!' })).status, 400);
});

test('counts: the four badges; a run-only share counts only its own runs', async () => {
    const own = await call('GET', '/a1/counts');
    assert.deepStrictEqual(own.body, { runs7d: 12, runsFailed7d: 1, versions: 5, pendingChanges: 2 });
    assert.deepStrictEqual(calls.counts[0], ['a1', { days: 7, onlyUserId: null }]);
    const runner = await call('GET', '/a1/counts', undefined, 'ron');
    assert.strictEqual(runner.status, 200);
    assert.deepStrictEqual(calls.counts[1], ['a1', { days: 7, onlyUserId: 'ron' }]);
    assert.strictEqual((await call('GET', '/a1/counts', undefined, 'nobody')).status, 403);
    assert.strictEqual((await call('GET', '/a1/counts?x=1')).status, 400);
});

test('helpers: copy titles stay under the limit; suggestions are cleaned', () => {
    assert.strictEqual(copyTitle('Invoices'), 'Invoices (copy)');
    assert.ok(copyTitle('x'.repeat(300)).length <= 200);
    assert.strictEqual(sanitiseSuggestion('\n "Hello\n  world." '), 'Hello world.');
});
