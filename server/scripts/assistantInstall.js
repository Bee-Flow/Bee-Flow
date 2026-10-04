#!/usr/bin/env node
/**
 * Personal assistant — per-owner provisioning.
 *
 * The assistant learns, and everything it learns lives in datatables. Those
 * tables are what make it PERSONAL: one set per owner, never shared, so what
 * one person teaches their assistant can never shape somebody else's. A
 * automation can be copied (export → import rebinds every datatable step by its
 * `datatableKey`), but the tables themselves have to exist first — nothing in
 * the blueprint installer creates them. This script is that step.
 *
 * Idempotent: an existing table is reported and left alone, missing columns are
 * added, parameters are seeded only when the table was empty.
 *
 * Run inside the server container:
 *   docker exec -i beeflow-server node /app/scripts/assistantInstall.js --org <orgId> --owner <userId>
 *
 * Options:
 *   --org <id>          organisation the tables belong to (required)
 *   --owner <userId>    owner recorded on the tables and rows (required)
 *   --starter-rules     also seed the org's sender rules with the domains of
 *                       existing rules from another org (off by default)
 *   --base-url <url>    rewrite the /f/<token> links inside the automations'
 *                       notification bodies to this host (e.g. https://app.example.com)
 *   --automation <id>   automation to rewrite links in (repeatable; needs --base-url)
 *   --dry-run           report what would happen, change nothing
 */

const datatableStore = require('../stores/datatableStore');
const datatableDbStore = require('../stores/datatableDbStore');
const queryCompiler = require('../core/dataEngine/queryCompiler');
const { synthesizeAccess } = require('../auth/datatableAccess');
const { migrationPlan } = require('../core/dataEngine/dataModel/migrationPlan');
const { ddlForTable } = require('../core/dataEngine/dataModel/ddl');
const { normalizeFields } = require('../core/dataEngine/dataModel/datatableFields');
const { assertDatatableQuota } = require('../core/dataEngine/datatableLimits');
const db = require('../db');

const PG = { dialect: 'pg' };
const t = (key, name, type = 'text') => ({ key, name, type });

/**
 * The eight tables the assistant reads and writes. `key` is the contract: an
 * imported automation's datatable steps carry the same keys and are rebound to
 * whatever ids these get (automation/portability.js rebindDatatables).
 * NOTE: every table already has a built-in `created_at` — declaring one is
 * rejected by normalizeFields.
 */
const TABLES = [
    {
        key: 'inbox_log', name: 'Inbox log (personal assistant)',
        description: 'Audit trail of every mail the assistant triaged: classification, urgency, what it did, and any correction the owner made afterwards. Prevents double processing and feeds sender history back into the classifier.',
        fields: [
            t('message_id', 'Message id'), t('thread_id', 'Thread id'), t('from_address', 'From'), t('sender_domain', 'Sender domain'),
            t('subject', 'Subject'), t('received_at', 'Received at', 'datetime'), t('processed_at', 'Processed at', 'datetime'),
            t('class', 'Class'), t('urgency', 'Urgency', 'number'), t('confidence', 'Confidence', 'number'), t('account', 'Account'),
            t('topic', 'Topic'), t('language', 'Language'), t('needs_reply', 'Needs reply', 'bool'), t('summary', 'Summary'),
            t('reason', 'Reason'), t('action', 'Action taken'), t('due_date', 'Due date'), t('amount', 'Amount', 'number'),
            t('currency', 'Currency'), t('vendor', 'Vendor'), t('invoice_number', 'Invoice number'), t('fingerprint', 'Fingerprint'),
            t('rule_pattern', 'Rule pattern'), t('vip', 'VIP', 'bool'), t('sentiment', 'Sentiment'),
            t('outcome', 'Outcome'), t('draft_id', 'Draft id'), t('sent_at', 'Sent at', 'datetime'),
            t('corrected_class', 'Corrected class (owner)'), t('replied_manually_at', 'Replied manually at', 'datetime'),
        ],
    },
    {
        key: 'sender_rules', name: 'Sender rules (personal assistant)',
        description: 'Per sender or domain: class override, account, VIP, mute, never draft, and whether a reply may be sent after approval. Human corrections to the AI classification without editing the flow. Rules the assistant proposed itself run on a trial until trial_until.',
        fields: [
            t('pattern', 'Pattern (domain or address, lowercase)'), t('class_override', 'Class override'), t('account', 'Account'),
            t('vip', 'VIP', 'bool'), t('mute', 'Mute (archive silently)', 'bool'), t('no_draft', 'Never draft a reply', 'bool'),
            t('active', 'Active', 'bool'), t('note', 'Note'), t('hits', 'Hits', 'number'), t('last_hit_at', 'Last hit at', 'datetime'),
            t('send_mode', 'Send mode (draft | ask)'), t('trial_until', 'Trial until', 'datetime'), t('applied_by', 'Applied by (owner | learned)'),
        ],
    },
    {
        key: 'invoice_register', name: 'Invoice register (personal assistant)',
        description: 'Invoices the assistant filed: number, vendor, amount, due date and the Drive link of the stored attachment. Catches duplicates and tracks payment terms.',
        fields: [
            t('invoice_number', 'Invoice number'), t('vendor', 'Vendor'), t('amount', 'Amount', 'number'), t('currency', 'Currency'),
            t('invoice_date', 'Invoice date'), t('due_date', 'Due date'), t('message_id', 'Message id'), t('subject', 'Subject'),
            t('drive_file_id', 'Drive file id'), t('drive_link', 'Drive link'), t('filename', 'Filename'), t('status', 'Status'),
            t('received_at', 'Received at', 'datetime'), t('year', 'Year'), t('sender_domain', 'Sender domain'), t('paid_at', 'Paid at', 'datetime'),
        ],
    },
    {
        key: 'assistant_actions', name: 'Assistant actions (personal assistant)',
        description: 'Every approval the assistant asked for and what the owner decided, with the reason and answers. Feeds the learning loop and shows what is still waiting.',
        fields: [
            t('approval_id', 'Approval id'), t('kind', 'Kind'), t('prompt', 'Prompt'), t('status', 'Status'),
            t('reason', 'Reason'), t('answers', 'Answers (JSON)'), t('requested_at', 'Requested at', 'datetime'),
            t('expires_at', 'Expires at', 'datetime'), t('decided_at', 'Decided at', 'datetime'), t('decided_by', 'Decided by'),
            t('run_id', 'Run id'), t('automation_id', 'Automation id'), t('source_event', 'Source event'),
        ],
    },
    {
        key: 'assistant_profile', name: 'Assistant profile (personal assistant)',
        description: 'What the assistant knows about its owner: tone, language, sign-off, working hours, VIPs, quiet topics, briefing style. Filled by the onboarding interview, the style read of sent mail, and the weekly refresh. Every AI step reads the active rows first. Set active to false to undo anything.',
        fields: [
            t('key', 'Key'), t('value', 'Value'), t('evidence', 'Evidence'), t('confidence', 'Confidence', 'number'),
            t('source', 'Source (interview | learned | chat_memory)'), t('last_confirmed_at', 'Last confirmed at', 'datetime'),
            t('expires_at', 'Expires at', 'datetime'), t('active', 'Active', 'bool'), t('note', 'Note'),
        ],
    },
    {
        key: 'reply_exemplars', name: 'Reply exemplars (personal assistant)',
        description: 'Every draft the assistant wrote next to what the owner actually sent, with how much they changed. The reply writer gets the closest few as style examples. Contains customer text; never leaves Bee Flow.',
        fields: [
            t('message_id', 'Message id'), t('thread_id', 'Thread id'), t('from_address', 'From'), t('sender_domain', 'Sender domain'),
            t('class', 'Class'), t('subject', 'Subject'), t('draft', 'Draft (assistant)'), t('final', 'Final (owner)'),
            t('edited', 'Edited', 'bool'), t('edit_ratio', 'Edit ratio', 'number'), t('mode', 'Mode (sent | drafted | replied_manually)'),
            t('reviewed', 'Reviewed by owner', 'bool'), t('run_id', 'Run id'),
        ],
    },
    {
        key: 'assistant_params', name: 'Assistant parameters (personal assistant)',
        description: 'Tunable thresholds: confidence gate, when to ask before sending, briefing length, meeting lead time, exemplar count. The weekly review may move the auto_tunable ones within [min, max] and records why. Set learning to off to stop every write to the learned tables.',
        fields: [
            t('key', 'Key'), t('value', 'Value'), t('min', 'Min', 'number'), t('max', 'Max', 'number'),
            t('auto_tunable', 'Auto-tunable', 'bool'), t('changed_at', 'Changed at', 'datetime'),
            t('changed_by', 'Changed by (owner | learned)'), t('reason', 'Reason'),
        ],
    },
    {
        key: 'assistant_feedback', name: 'Assistant feedback (personal assistant)',
        description: 'Thumbs up or down from the owner on a briefing, meeting brief, draft or triage decision, with an optional note.',
        fields: [
            t('run_id', 'Run id'), t('kind', 'Kind'), t('rating', 'Rating (+1 | -1)', 'number'),
            t('note', 'Note'), t('source', 'Source (owner | auto)'),
        ],
    },
    {
        key: 'assistant_metrics_daily', name: 'Assistant metrics (personal assistant)',
        description: 'One row per day: triaged, drafted, sent unchanged, sent after editing, rejected, replied manually, corrections, expired requests, feedback. The evidence for whether the assistant is getting better.',
        fields: [
            t('day', 'Day (YYYY-MM-DD)'), t('triaged', 'Triaged', 'number'), t('drafted', 'Drafted', 'number'),
            t('sent_unchanged', 'Sent unchanged', 'number'), t('sent_edited', 'Sent edited', 'number'), t('rejected', 'Rejected', 'number'),
            t('replied_manually', 'Replied manually', 'number'), t('corrections', 'Corrections', 'number'),
            t('approvals_expired', 'Approvals expired', 'number'), t('feedback_up', 'Feedback up', 'number'), t('feedback_down', 'Feedback down', 'number'),
        ],
    },
];

const PARAM_SEEDS = [
    { key: 'learning', value: 'on', min: 0, max: 1, auto_tunable: false, reason: 'Learning on by default; set to off to stop every write to the learned tables.' },
    { key: 'confidence_gate', value: '0.55', min: 0.4, max: 0.9, auto_tunable: true, reason: 'Below this confidence a mail goes to Triage/Review instead of a class branch.' },
    { key: 'urgency_ask_threshold', value: '2', min: 1, max: 3, auto_tunable: true, reason: 'At or above this urgency a reply is sent only after approval.' },
    { key: 'briefing_max_lines', value: '25', min: 10, max: 40, auto_tunable: true, reason: 'Length of the morning briefing.' },
    { key: 'meeting_lead_minutes', value: '30', min: 10, max: 120, auto_tunable: false, reason: 'How long before a meeting the briefing arrives (mirrors the calendar trigger filter).' },
    { key: 'newsletter_mute_after', value: '5', min: 3, max: 15, auto_tunable: true, reason: 'Ignored newsletters from one domain before it is muted on trial.' },
    { key: 'exemplar_count', value: '3', min: 1, max: 6, auto_tunable: true, reason: 'How many past replies the reply writer sees as style examples.' },
];

function parseArgs(argv) {
    const out = { automations: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--org') out.org = argv[++i];
        else if (a === '--owner') out.owner = argv[++i];
        else if (a === '--base-url') out.baseUrl = argv[++i];
        else if (a === '--automation') out.automations.push(argv[++i]);
        else if (a === '--starter-rules') out.starterRules = true;
        else if (a === '--dry-run') out.dryRun = true;
    }
    return out;
}

async function ensureTable(scope, ownerUserId, spec, { dryRun }) {
    const key = datatableDbStore.scopeKey(scope);
    const model = await datatableStore.getModel(scope);
    const existing = (model.model.tables || []).find(x => x && x.key === spec.key);

    if (existing) {
        const stored = Array.isArray(existing.fields) ? existing.fields : [];
        const missing = spec.fields.filter(f => !stored.some(s => s.key === f.key));
        if (!missing.length) return { key: spec.key, id: existing.id, action: 'unchanged' };
        if (dryRun) return { key: spec.key, id: existing.id, action: 'would-add-columns', columns: missing.map(m => m.key) };
        const norm = normalizeFields([...stored, ...missing], stored);
        if (!norm.ok) throw new Error(`${spec.key}: ${norm.error}`);
        const next = JSON.parse(JSON.stringify(model.model));
        const tbl = next.tables.find(x => x.id === existing.id);
        tbl.fields = norm.fields;
        const saved = await db.withTransaction((client) => datatableStore.saveModel(scope, next, {
            expectedVersion: model.modelVersion,
            client,
            applyPhysical: async (c, { before, next: after, modelVersion }) => {
                const plan = migrationPlan(before, after, { ...PG, onlyTableIds: [existing.id] });
                if (!plan.length) return;
                const ensure = ddlForTable(tbl, { tableKeyById: new Map((after.tables || []).map(x => [x.id, x.key])), dialect: 'pg', rowScope: existing.rowScope || 'all' });
                await datatableDbStore.applyMigration(key, key, [ensure, ...plan], { client: c, targetVersion: modelVersion });
            },
        }));
        if (!saved.ok) throw new Error(`${spec.key}: version conflict (current ${saved.currentVersion})`);
        datatableDbStore.invalidate(key);
        return { key: spec.key, id: existing.id, action: 'columns-added', columns: missing.map(m => m.key) };
    }

    if (dryRun) return { key: spec.key, id: null, action: 'would-create' };
    const norm = normalizeFields(spec.fields, []);
    if (!norm.ok) throw new Error(`${spec.key}: ${norm.error}`);
    const table = await db.withTransaction(async (client) => datatableStore.createDatatable({
        scope, ownerUserId, key: spec.key, name: spec.name, description: spec.description,
        projectId: null, rowScope: 'all', fields: norm.fields,
    }, {
        client,
        assertQuota: (usage) => assertDatatableQuota(scope, { addTables: 1, usage }),
        applyPhysical: async (c, { before, next, modelVersion }) => {
            const created = next.tables[next.tables.length - 1];
            const ensure = ddlForTable(created, { tableKeyById: new Map((next.tables || []).map(x => [x.id, x.key])), dialect: 'pg', rowScope: 'all' });
            const plan = migrationPlan(before, next, { ...PG, onlyTableIds: [created.id] });
            await datatableDbStore.applyMigration(key, key, [ensure, ...plan], { client: c, targetVersion: modelVersion });
        },
    }));
    datatableDbStore.invalidate(key);
    return { key: spec.key, id: table.id, action: 'created' };
}

async function insertRows(scope, tableId, ownerUserId, orgId, rows) {
    const table = await datatableStore.getDatatable(tableId, scope);
    const meta = { ...(await datatableStore.getTableMeta(scope, tableId)), access: synthesizeAccess(table) };
    const key = datatableDbStore.scopeKey(scope);
    for (const values of rows) {
        const { sql, params } = queryCompiler.compileInsert(meta, values, { createdBy: ownerUserId, orgId: table.organizationId || orgId, dialect: 'pg' });
        await datatableDbStore.exec(key, key, sql, params);
    }
    await datatableStore.bumpAfterWrite(tableId, scope, rows.length);
    return rows.length;
}

async function rowCount(scope, tableId) {
    const table = await datatableStore.getDatatable(tableId, scope);
    return Number(table?.rowCount ?? table?.row_count ?? 0);
}

/**
 * Rewrite the public form links inside an automation's notification bodies. The
 * links are minted per install (POST /:id/form → /f/<token>), so a copied
 * automation still points at the source instance until this runs.
 */
async function rewriteFormLinks(automationId, baseUrl, { dryRun }) {
    const automationStore = require('../stores/automationStore');
    const a = await automationStore.getAutomation(automationId);
    if (!a) return { automationId, error: 'not found' };
    const def = JSON.parse(JSON.stringify(a.definition || {}));
    const host = String(baseUrl).replace(/\/+$/, '');
    let changed = 0;
    const re = /https?:\/\/[^\s)]+\/f\/([A-Za-z0-9]+)/g;
    for (const step of def.steps || []) {
        if (step.type !== 'notification' || typeof step.body !== 'string') continue;
        const next = step.body.replace(re, (_m, token) => `${host}/f/${token}`);
        if (next !== step.body) { step.body = next; changed++; }
    }
    if (!changed || dryRun) return { automationId, title: a.title, notificationsChanged: changed, applied: false };
    // goLive: a repair of the running automation, not a pending edit (handoff 5).
    await automationStore.updateAutomation(automationId, { definition: def }, a.userId, { goLive: true });
    return { automationId, title: a.title, notificationsChanged: changed, applied: true };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.org || !args.owner) {
        console.error('Usage: node scripts/assistantInstall.js --org <orgId> --owner <userId> [--starter-rules] [--base-url <url> --automation <id>] [--dry-run]');
        process.exit(2);
    }
    const scope = datatableStore.orgScope(args.org);
    const report = { org: args.org, owner: args.owner, dryRun: !!args.dryRun, tables: [], seeded: {}, links: [] };

    for (const spec of TABLES) {
        try { report.tables.push(await ensureTable(scope, args.owner, spec, { dryRun: args.dryRun })); }
        catch (e) { report.tables.push({ key: spec.key, error: e.message }); }
    }

    const params = report.tables.find(x => x.key === 'assistant_params');
    if (params?.id && !args.dryRun) {
        const count = await rowCount(scope, params.id);
        if (count === 0) {
            const now = new Date().toISOString();
            report.seeded.assistant_params = await insertRows(scope, params.id, args.owner, args.org,
                PARAM_SEEDS.map(p => ({ ...p, changed_at: now, changed_by: 'owner' })));
        } else {
            report.seeded.assistant_params = `skipped (${count} rows already)`;
        }
    }

    if (args.starterRules && !args.dryRun) {
        const rules = report.tables.find(x => x.key === 'sender_rules');
        if (rules?.id && (await rowCount(scope, rules.id)) === 0) {
            // Deliberately generic: no personal data, only the machine senders
            // every inbox has. Real accounts are the owner's to add.
            const seeds = [
                { pattern: 'noreply', class_override: 'machine_noise', mute: false },
                { pattern: 'no-reply', class_override: 'machine_noise', mute: false },
                { pattern: 'notifications', class_override: 'machine_noise', mute: false },
            ].map(r => ({ ...r, account: '', vip: false, no_draft: true, active: true, hits: 0, send_mode: 'draft', applied_by: 'owner', note: 'starter rule — adjust or deactivate' }));
            report.seeded.sender_rules = await insertRows(scope, rules.id, args.owner, args.org, seeds);
        }
    }

    if (args.baseUrl) {
        for (const id of args.automations) {
            try { report.links.push(await rewriteFormLinks(id, args.baseUrl, { dryRun: args.dryRun })); }
            catch (e) { report.links.push({ automationId: id, error: e.message }); }
        }
    }

    console.log(JSON.stringify(report, null, 1));
    process.exit(0);
}

if (require.main === module) {
    main().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
}

module.exports = { TABLES, PARAM_SEEDS, ensureTable, rewriteFormLinks };
