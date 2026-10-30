// @typecheck strict
/**
 * integrations/toolFamilies × core/tools/toolDispatcher: the walk the
 * dispatcher's former if-chain made, now as registered families.
 *
 * Pins the sequence (it decides who wins where predicates overlap), who owns
 * the names that sit on such an overlap, and the n8n write-permission
 * backstop that travels with the workflow family.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Patched BEFORE toolFamilies loads: it binds hasPermission at require time.
const permissions = require('../auth/permissions');
/** @type {string[]} */
const permissionCalls = [];
permissions.hasPermission = async (userId, perm) => { permissionCalls.push(perm); return false; };

require('../core/tools/toolDispatcher');
require('./toolFamilies');
const { listToolFamilies, getToolFamily } = require('../core/tools/toolFamilyRegistry');
const { executeTool, executeNextcloudFamilyTool } = require('../core/tools/toolDispatcher');

function ownerOf(/** @type {string} */ toolName) {
    return listToolFamilies().find(f => f.isTool(toolName))?.name || null;
}

test('the walk keeps the order of the former dispatcher chain', () => {
    assert.deepEqual(listToolFamilies().map(f => f.name), [
        'custom_integration',
        'activate_skill', 'session_skills', 'generate_image',
        'create_presentation', 'create_word_document',
        'generate_video', 'elevenlabs',
        'fireflies', 'regex_generator', 'youtrack', 'signrequest', 'gamma', 'afas', 'nmbrs', 'vplan', 'firebird',
        'scaleway_billing', 'withings',
        'gmail', 'google_calendar', 'google_docs', 'google_sheets', 'google_slides', 'google_drive',
        'google_contacts', 'google_keep', 'google_groups',
        'n8n_workflow', 'n8n',
        'agent_search', 'read_url', 'browse_web',
        'set_reminder', 'set_ai_task',
        'notebook', 'memory', 'automation_evolution', 'kb_search',
        'datatable',
        'kb_ingest', 'maps', 'linkedin', 'github',
        'nextcloud',
        'support', 'webpage_automation', 'outlook', 'ms_calendar', 'onedrive', 'ms_contacts', 'transcription',
    ]);
});

test('names on an overlap go to the family that used to win', () => {
    // Every workflow tool is also an n8n_* name: the permission-checked
    // workflow family must see it first.
    assert.equal(ownerOf('n8n_workflow_create'), 'n8n_workflow');
    assert.equal(ownerOf('n8n_execution_list'), 'n8n_workflow');
    assert.equal(ownerOf('nextcloud_deck_list_boards'), 'nextcloud');
    assert.equal(ownerOf('nextcloud_list_files'), 'nextcloud');
    assert.equal(ownerOf('generate_image'), 'generate_image');
    assert.equal(ownerOf('create_spreadsheet'), 'create_word_document');
    assert.equal(ownerOf('notebook_write'), 'notebook');
    assert.equal(ownerOf('workspace_read'), 'notebook');
    assert.equal(ownerOf('set_ai_task'), 'set_ai_task');
    assert.equal(ownerOf('no_such_tool_anywhere'), null);
});

test('custom integrations hand their name grammar to progressive disclosure', () => {
    const parse = getToolFamily('custom_integration').parseName;
    assert.deepEqual(parse('cint_acme1_list_orders'), { slug: 'acme1', toolName: 'list_orders' });
    const { groupForTool } = require('../core/tools/toolDisclosure');
    assert.equal(groupForTool({ name: 'cint_acme1_list_orders' })?.key, 'custom:acme1');
});

test('an n8n write tool is refused without modify_n8n_workflows', async () => {
    permissionCalls.length = 0;
    const out = await executeTool('n8n_workflow_create', {}, { userId: 'u-1', session: {}, orgId: 'o-1', egress: false });
    assert.match(out?.error || '', /permission to modify n8n workflows/);
    assert.deepEqual(permissionCalls, ['modify_n8n_workflows']);
});

test('the unguarded Nextcloud chain ignores names it does not own', async () => {
    assert.equal(await executeNextcloudFamilyTool('gmail_list_messages', {}, 'u-1', {}), undefined);
});
