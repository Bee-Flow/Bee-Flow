#!/usr/bin/env node
/**
 * The closing review, printed — without a playbook, a browser or a write.
 *
 * For the rehearsal: run it against the real box the morning of the talk and
 * read what the room will read. It calls the same two halves the phase calls
 * (playbooks/phases/complianceFacts + compliancePhase), so a surprise here is
 * a surprise you get in private.
 *
 *   node scripts/playbook-compliance-dry-run.js --table tbl_xxx --user u1 [--org org1]
 *                                               [--automation a1 --automation a2] [--app app_1]
 *                                               [--no-model]
 *
 * Writes nothing, anywhere.
 */

'use strict';

function arg(name, fallback = null) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
function args(name) {
    const out = [];
    process.argv.forEach((a, i) => { if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
    return out;
}

(async () => {
    const tableId = arg('table');
    const userId = arg('user');
    if (!tableId || !userId) {
        console.error('usage: node scripts/playbook-compliance-dry-run.js --table <tbl_id> --user <user_id> [--org <org_id>] [--automation <id>]… [--app <id>] [--no-model]');
        process.exit(2);
    }
    const orgId = arg('org') || null;
    const noModel = process.argv.includes('--no-model');

    const datatableStore = require('../stores/datatableStore');
    const datatableAccess = require('../auth/datatableAccess');
    const datatableRuntime = require('../core/dataEngine/datatableRuntime');
    const automationStore = require('../stores/automationStore');
    const studioAppStore = require('../stores/studioAppStore');
    const frameworkPolicy = require('../compliance/frameworkPolicy');
    const frameworks = require('../compliance/frameworks');
    const { GUI_DEFAULTS } = require('../i18n/defaults/en');
    const { enrich } = require('../playbooks/phases/complianceFacts');
    const { gatherFacts, runCompliancePhase } = require('../playbooks/phases/compliancePhase');

    const principal = await datatableAccess.resolveDatatablePrincipalForUser(userId);
    const org = orgId || principal.organizationId || 'default';
    const resolved = await datatableRuntime.resolveForPrincipal(tableId, principal, { needed: 'viewer' });
    const meta = resolved.meta;
    const row = await datatableStore.getDatatable(tableId, resolved.scope);
    const fields = (meta.fields || []).map((f) => ({ key: f.key, name: f.name, type: f.type }));
    const page = await datatableRuntime.readRows(resolved, { allowColumns: fields.map((f) => f.key), limit: 50 });

    const automations = [];
    for (const id of args('automation')) {
        const a = await automationStore.getAutomation(id);
        if (a) {
            automations.push({
                title: a.title, description: a.description || null,
                trigger: a.definition?.trigger?.kind || null,
                steps: (a.definition?.steps || []).map((s) => ({ type: s && s.type })),
                definition: a.definition || null,
            });
        }
    }
    let app = null;
    const appId = arg('app');
    if (appId) {
        const r = await studioAppStore.getStudioApp(appId);
        if (r) app = { id: r.id, name: r.name, published: !!r.isPublished, sharedGroups: r.sharedGroups || [], screenCount: (r.definition?.screens || []).length, publicPages: 0 };
    }

    const active = [...await frameworkPolicy.activeRegulations(org)];
    const names = active.map((code) => {
        const fw = frameworks.byRegulation(code);
        const human = fw && fw.name_key ? GUI_DEFAULTS[fw.name_key] : null;
        return human && human !== code ? `${code} (${human})` : code;
    });

    const enrichment = await enrich({
        table: { fields }, rows: page.rows, automations, orgId: org,
        privacy: row ? { lawfulBasis: row.lawfulBasis, retentionDays: row.retentionDays, retentionField: row.retentionField, subjectColumn: row.subjectColumn, rowScope: row.rowScope } : null,
    });
    const facts = gatherFacts({
        table: { id: tableId, name: row?.name, fields, rowCount: row?.rowCount, isMirror: !!row?.managedKind },
        automations, app, access: null, frameworks: active, enrichment,
    });

    console.log(`\n── ${row?.name || tableId} ─────────────────────────────`);
    console.log(`frameworks : ${names.join(', ') || '(none active)'}`);
    console.log(`personal   : ${facts.table.personal.map((p) => p.name).join(', ') || '(none)'}  [decided by ${facts.personalMethod}]`);
    console.log(`recorded   : basis=${facts.table.lawfulBasis || '—'}  retention=${facts.table.retentionDays || '—'}  subject=${facts.table.subjectColumn || '—'}`);
    console.log(`rows read  : ${page.rows.length}`);

    const out = await runCompliancePhase(
        { facts, locale: 'en', frameworkNames: names },
        noModel
            ? { resolveModel: async () => { throw new Error('--no-model'); }, chatForcedTool: async () => ({}) }
            : undefined,
    );
    console.log(`\n${out.summary}${out.artifacts.modelFailed ? `   (model: ${out.artifacts.modelFailed})` : ''}\n`);
    for (const f of out.artifacts.findings) {
        console.log(`  [${f.severity.toUpperCase().padEnd(6)}] ${f.framework} ${f.article || ''} — ${f.title}`);
        console.log(`            ${f.subject || ''}  (${f.source})`);
        console.log(`            why: ${f.why}`);
        console.log(`            fix: ${f.fix}\n`);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
