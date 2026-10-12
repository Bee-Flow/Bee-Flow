#!/usr/bin/env node
/**
 * Print the Playbook briefs as harness briefs — so the two live-run gates
 * (scripts/builder-live-run.sh, scripts/app-builder-live-run.sh --brief …)
 * rehearse exactly what a phase will send, against a REAL table on the box.
 *
 *   node server/scripts/print-playbook-briefs.js --table-id tbl_… --table-key facturen \
 *        --table-name Facturen --folder /Invoices-Test --user-id <owner uid> \
 *        [--mirror] [--no-status] [--locale nl|en] [--out-dir server/scripts/builder-briefs]
 *
 * Writes playbook-invoice-automation.json, playbook-invoice-app.json and
 * playbook-invoice-approvals.json (a second AUTOMATION — Studio → Approvals decides).
 * Pure: reads only the recipe.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const recipe = require('../playbooks/recipes/invoiceTracker');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

// The demo's language: the briefs, the table's column keys and the titles
// follow it, exactly as a playbook started in that interface language does.
const locale = arg('locale', 'nl');
const table = {
    id: arg('table-id', 'tbl_000000000000'),
    key: arg('table-key', 'facturen'),
    name: arg('table-name', recipe.tableTitleFor(locale)),
    mapping: recipe.schemaMapping(locale),
    isMirror: flag('mirror'),
    hasStatus: !flag('no-status'),
};
if (!table.hasStatus) delete table.mapping.status;
const folderPath = arg('folder', '/Invoices-Test');
const userId = arg('user-id', 'u_owner');
const outDir = arg('out-dir', path.join(__dirname, 'builder-briefs'));

const six = ['datum', 'leverancier', 'factuurnummer', 'excl_btw', 'btw', 'totaal'].map((r) => table.mapping[r]).filter(Boolean);
const automation = {
    brief: recipe.composeAutomationBrief({ table, folderPath, locale }),
    tier: 'fast',
    expect: {
        finalized: true, maxFailedCalls: 1, maxRounds: 8, triggerKind: 'manual',
        chain: [
            { type: 'integration_action', tool: 'nextcloud_list_files', inputs: { path: folderPath } },
            { type: 'integration_action', tool: 'nextcloud_read_file', forEachOver: '$0.output.items' },
            { type: 'data_extraction', forEachOver: '$1.output.results', fields: six },
            { type: 'datatable', op: 'add_row', datatableId: table.id, forEachOver: '$2.output.results', valuesKeys: [...six, ...(table.hasStatus ? ['status'] : [])] },
        ],
    },
};
const app = {
    brief: recipe.composeAppBrief({ table, title: table.name, locale }),
    tier: 'fast', planMode: 'never',
    expect: {
        finalized: true, maxFailedCalls: 2, maxRounds: 8, maxRepeated: 2,
        linkedTable: { key: table.key, minRows: 1 },
        components: ['stat', 'chart', 'data_grid', 'filter_bar', 'record_detail'],
        minComponents: 7, minScreens: 2,
        noTools: ['app_seed_records', 'app_upsert_table'],
    },
};
// The approval flow is a AUTOMATION (Studio → Approvals decides; the app is not
// touched): run it with scripts/builder-live-run.sh like the first one.
const approvals = {
    brief: recipe.composeApprovalsBrief({ table, approver: { userId }, locale }),
    tier: 'fast',
    expect: {
        finalized: true, maxFailedCalls: 2, maxRounds: 10, triggerKind: 'manual',
        chain: [
            { type: 'datatable', op: 'find_rows', datatableId: table.id },
            { type: 'datatable', op: 'update_rows', datatableId: table.id },
            { type: 'approval' },
            { type: 'datatable', op: 'update_rows', datatableId: table.id },
        ],
    },
};

fs.mkdirSync(outDir, { recursive: true });
for (const [name, body] of [['playbook-invoice-automation.json', automation], ['playbook-invoice-app.json', app], ['playbook-invoice-approvals.json', approvals]]) {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`wrote ${file} (${body.brief.length} brief chars)`);
}
