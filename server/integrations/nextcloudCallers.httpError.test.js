'use strict';
const test = require('node:test');
const assert = require('node:assert');

const AUTH = 'Bee Flow connector could not reach Nextcloud';

// ── The callers: a 403/404 is no longer reported as an outage ──────────────
const ncClient = require('./nextcloudClient');
const { executeNextcloudFormsTool } = require('./nextcloudFormsTools');
const { executeNextcloudTeamsTool } = require('./nextcloudTeamsTools');

async function runWith(exec, tool, args, status, body) {
    const original = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => ({
        baseUrl: 'https://nc.example.test',
        authError: AUTH,
        fetch: async () => ({ ok: status < 400, status, text: async () => body }),
    });
    try {
        return await exec(tool, args, 'u1', {});
    } finally {
        ncClient.resolveAuth = original;
    }
}

test('Forms: a 403 and a 404 name their own cause, only a 401 is the connector', async () => {
    const forbidden = await runWith(executeNextcloudFormsTool, 'nextcloud_forms_get', { formId: 1 }, 403, '{"message":"Not allowed"}');
    assert.match(forbidden.error, /Permission denied/);
    assert.ok(!forbidden.error.includes('could not reach'));
    const missing = await runWith(executeNextcloudFormsTool, 'nextcloud_forms_get', { formId: 1 }, 404, '{"message":"Form not found"}');
    assert.match(missing.error, /Form not found/);
    assert.ok(!missing.error.includes('Install'));
    const auth = await runWith(executeNextcloudFormsTool, 'nextcloud_forms_get', { formId: 1 }, 401, '');
    assert.strictEqual(auth.error, AUTH);
});

test('Teams: a 403 is a permission error, not the connector message', async () => {
    const out = await runWith(executeNextcloudTeamsTool, 'nextcloud_teams_get', { teamId: 'abc' }, 403, '');
    assert.match(out.error, /Permission denied/);
    assert.ok(!out.error.includes('could not reach'));
});

test('Teams: share_with_team returns the share id as a number, as id and shareId', async () => {
    const body = JSON.stringify({ ocs: { data: { id: '31', permissions: 1 } } });
    const out = await runWith(executeNextcloudTeamsTool, 'nextcloud_share_with_team', { path: '/a', teamId: 't1' }, 200, body);
    assert.strictEqual(out.id, 31);
    assert.strictEqual(out.shareId, 31);
});

const { executeNextcloudActivityTool } = require('./nextcloudActivityTools');
const { executeNextcloudTablesTool } = require('./nextcloudTablesTools');
const { executeSearchTool } = require('./nextcloudFiles/search');

test('Activity: an unknown filter (404 with a reason) is not "app not installed"', async () => {
    const out = await runWith(executeNextcloudActivityTool, 'nextcloud_activity_list', { filter: 'nope' }, 404, '{"message":"Unknown filter"}');
    assert.match(out.error, /Unknown filter/);
    assert.ok(!/not installed/.test(out.error));
});

test('Tables: a 500 never echoes the body, a 502 reads as unreachable', async () => {
    const leak = await runWith(executeNextcloudTablesTool, 'nextcloud_tables_list', {}, 500, 'SQLSTATE[42S22] oc_tables_x');
    assert.ok(!/SQLSTATE|oc_tables/.test(leak.error));
    const down = await runWith(executeNextcloudTablesTool, 'nextcloud_tables_list', {}, 502, '<html>bad gateway</html>');
    assert.match(down.error, /temporarily unavailable/);
});

test('Files search: a 403 is a permission error, not the connector message', async () => {
    const ctx = {
        baseUrl: 'https://nc.example.test',
        authError: AUTH,
        ncFetch: async () => ({ ok: false, status: 403, text: async () => '{"ocs":{"meta":{"message":"Search not allowed"}}}' }),
    };
    const out = await executeSearchTool('nextcloud_search_files', { query: 'x' }, ctx);
    assert.match(out.error, /Permission denied.*Search not allowed/);
});
