// @typecheck
'use strict';

/**
 * Characterisation (golden) test for buildToolHint: the hint text for tool
 * lists that reach every line it can add (each family by its prefix or exact
 * name, alone and all together in their order), the n8n run list and the
 * read-only / write variants of workflow management, Outlook with and
 * without compose, the Nextcloud families against Nextcloud Files, MCP tools
 * grouped per server (more and fewer than five), and custom org integrations
 * through the lazy store (found, without a name, missing, unparsable, a store
 * that throws).
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/integrations/toolHint.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createBuildToolHint } = require('./toolHint');

const GOLDEN = path.join(__dirname, 'toolHint.characterisation.golden.json');

/** One tool definition. @param {string} name @param {string} [description] */
const tool = (name, description) => ({ type: 'function', function: { name, ...(description ? { description } : {}) } });

// One name per family the hint knows, in no particular order.
const FAMILY_NAMES = [
    'gmail_search', 'calendar_list', 'drive_search', 'docs_create', 'contacts_search', 'keep_list', 'groups_list',
    'youtrack_search', 'afas_query', 'nmbrs_list_debtors', 'vplan_list_boards', 'firebird_query', 'frappe_crm_list_leads',
    'scaleway_list_invoices', 'signrequest_send', 'fireflies_list', 'gamma_create', 'generate_image', 'create_presentation',
    'create_word_document', 'create_spreadsheet', 'generate_music', 'generate_video', 'agent_search', 'browse_web', 'read_url',
    'workspace_read', 'notebook_write', 'kb_search', 'kb_get_original', 'maps_directions', 'linkedin_post', 'github_list',
    'ms_calendar_list', 'onedrive_search', 'ms_contacts_search', 'transcribe_audio', 'nextcloud_calendar_list',
    'nextcloud_contacts_list', 'nextcloud_deck_list', 'nextcloud_notifications_list', 'nextcloud_talk_list', 'nextcloud_tasks_list',
    'nextcloud_notes_list', 'nextcloud_activity_list', 'nextcloud_status_get', 'nextcloud_list_files',
];

const STORE_ROWS = /** @type {Record<string, { name?: string } | null>} */ ({ abcd: { name: 'Billing API' }, efgh: { name: '' }, ijkl: null });

/** @param {{ throws?: boolean }} [o] */
function lazy(o = {}) {
    return {
        customIntegrationRunner: () => ({
            parsePrefixedName: (/** @type {string} */ n) => {
                const m = /^cint_([a-z0-9]{4,16})_([a-z][a-z0-9_]{2,40})$/.exec(n);
                return m ? { slug: m[1], toolName: m[2] } : null;
            },
        }),
        orgCustomIntegrationStore: () => ({
            getBySlug: async (/** @type {string} */ slug) => {
                if (o.throws) throw new Error('db down');
                return STORE_ROWS[slug] ?? null;
            },
        }),
    };
}

const mcp = (/** @type {string} */ server, /** @type {number} */ n) => Array.from({ length: n }, (_, i) => tool(`mcp_${server}_t${i}`, i % 2 ? `Tool ${i} of ${server}` : undefined));

/** @type {Record<string, [ReturnType<typeof tool>[], { throws?: boolean }?]>} */
const CASES = {
    none: [[]],
    unknownOnly: [[tool('something_else'), tool('weather_now')]],
    ...Object.fromEntries(FAMILY_NAMES.map((n) => [`only_${n}`, [[tool(n)]]])),
    allFamilies: [FAMILY_NAMES.map((n) => tool(n))],
    allFamiliesReversed: [[...FAMILY_NAMES].reverse().map((n) => tool(n))],
    namesNotExact: [[tool('generate_image_hd'), tool('kb_searcher'), tool('read_url_x'), tool('transcribe_audio2')]],
    n8nRun: [[tool('n8n_run_invoice', 'Send invoices'), tool('n8n_run_sync'), tool('n8n_run_report', 'Weekly report')]],
    n8nReadOnly: [[tool('n8n_workflow_list'), tool('n8n_execution_list')]],
    n8nExecutionOnly: [[tool('n8n_execution_get_detail')]],
    ...Object.fromEntries(['n8n_workflow_create', 'n8n_workflow_update', 'n8n_workflow_patch', 'n8n_workflow_delete', 'n8n_workflow_execute', 'n8n_workflow_activate', 'n8n_workflow_deactivate']
        .map((n) => [`n8nWrite_${n}`, [[tool('n8n_workflow_list'), tool(n)]]])),
    n8nWriteWithoutList: [[tool('n8n_workflow_create')]],
    n8nRunAndManage: [[tool('n8n_run_x', 'X'), tool('n8n_workflow_get')]],
    outlookCompose: [[tool('outlook_search'), tool('outlook_compose')]],
    outlookReadOnly: [[tool('outlook_search'), tool('outlook_read')]],
    nextcloudSubOnly: [[tool('nextcloud_deck_list'), tool('nextcloud_talk_send')]],
    nextcloudFilesAndSub: [[tool('nextcloud_deck_list'), tool('nextcloud_upload_file')]],
    mcpFew: [mcp('github', 3)],
    mcpMany: [[...mcp('jira_cloud', 7), ...mcp('linear', 5), ...mcp('x', 6)]],
    mcpNoServer: [[tool('mcp_'), tool('mcp')]],
    cint: [[tool('cint_abcd_list_invoices'), tool('cint_abcd_get_invoice'), tool('cint_efgh_list_x'), tool('cint_ijkl_list_y'), tool('cint_BAD_x'), tool('cint_zzzz_list_z')]],
    cintStoreThrows: [[tool('cint_abcd_list_invoices'), tool('gmail_search')], { throws: true }],
    everything: [[...FAMILY_NAMES.map((n) => tool(n)), tool('n8n_run_a', 'A'), tool('n8n_workflow_patch'), tool('outlook_compose'), ...mcp('srv', 2), tool('cint_abcd_list_invoices')]],
};

test('buildToolHint: every case matches the golden result', async () => {
    /** @type {Record<string, string>} */
    const actual = {};
    for (const [name, [tools, o]] of Object.entries(CASES)) {
        const build = createBuildToolHint({ lazy: lazy(o) });
        actual[name] = await build(/** @type {any} */ (tools), 'u1');
    }
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(actual)) assert.equal(actual[name], golden[name], name);
});
