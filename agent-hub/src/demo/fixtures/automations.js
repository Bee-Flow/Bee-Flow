/**
 * Fixtures for the Automations & automations demo.
 *
 * Modelled on a workflow a real team would build: pull last month's AI/SaaS
 * invoices out of the mailbox, extract the line items, total them per vendor
 * and post the result. It uses ordinary step types (`integration_action`,
 * `loop`, `ai_step`, `aggregate`, `notification`) so the canvas shows the
 * same node vocabulary the product does.
 *
 * Everything is invented. The "connected" Gmail account, the vendors and the
 * run history are all made up, and no request touches a real mailbox — the
 * demo transport answers every call from this file.
 */

import { COMMON_ROUTES, daysAgo, minutesAgo } from './common';
import { AI_ACT_ROUTES, seedAiAct } from './automationsAiAct';
import { REPEATING_ROUTES } from './automationsRepeating';
import { recordRun, runRoutes, seedRuns } from './automationsRuns';
import { SETTINGS_LIBRARY_ROUTES, SETTINGS_ROUTES, seedFolders, seedShares, seedTrash, seedWebhooks } from './automationsSettings';
import { TEMPLATE_ROUTES } from './automationsTemplates';
import { CODE_ROUTES, CODE_STEP } from './automationsCode';
import {
    MAIL_CONDITION_STEP_RESULTS, MAIL_SPLIT_STEP_RESULTS, mailConditionAutomationFields, mailSplitAutomationFields, seedMailConditionRuns, seedMailSplitRuns,
} from './automationsMailCondition';
import { MAIL_FANOUT_CATALOG_APP, MAIL_FANOUT_STEP_RESULTS, mailFanoutAutomationFields, seedMailFanoutRuns } from './automationsMailFanout';
import { MAIL_FLATTEN_STEP_RESULTS, ORDERS_FLATTEN_STEP_RESULTS, mailFlattenAutomationFields, ordersFlattenAutomationFields, seedMailFlattenRuns } from './automationsMailFlatten';
import { NESTED_CATALOG_APPS, NESTED_STEP_RESULTS, nestedAutomationFields, seedNestedRuns } from './automationsNested';
import { VERSION_ROUTES, recordSave, seedVersions } from './automationsVersions';

const AUTOMATION_ID = 'auto_demo_spend_report';
const STEP_LIBRARY_ID = 'blk_demo_vendor_lookup';

function spendReportDefinition() {
    return {
        title: 'Weekly AI/SaaS spend report',
        trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
        steps: [
            {
                id: 'search_invoices',
                type: 'integration_action',
                label: 'Search AI/SaaS billing emails (last 7 days)',
                app: 'gmail',
                action: 'gmail_search',
                params: {
                    query: 'from:(billing OR invoice OR receipt) newer_than:7d',
                    maxResults: 100,
                },
            },
            {
                id: 'read_each',
                type: 'loop',
                label: 'Read & extract each invoice',
                over: '{{ steps.search_invoices.messages }}',
                as: 'message',
                maxIterations: 100,
                steps: [
                    {
                        id: 'read_message',
                        type: 'integration_action',
                        label: 'Read message',
                        app: 'gmail',
                        action: 'gmail_read',
                        params: { messageId: '{{ message.id }}' },
                    },
                    {
                        id: 'extract_lines',
                        type: 'ai_step',
                        label: 'Extract billing line items',
                        modelTier: 'fast',
                        prompt: 'Extract every billing line item from this invoice email as JSON: vendor, description, amount, currency, period. If it is not an invoice, return an empty array.\n\n{{ steps.read_message.body }}',
                    },
                ],
            },
            {
                id: 'total_per_vendor',
                type: 'aggregate',
                label: 'Sum totals per vendor',
                over: '{{ steps.read_each.results }}',
                groupBy: 'vendor',
                operation: 'sum',
                field: 'amount',
            },
            // A code step with described inputs: the form, the checks and the
            // large editor with the assistant (automationsCode.ts).
            CODE_STEP,
            {
                id: 'over_budget',
                type: 'condition',
                label: 'Above €2,000 this week?',
                expr: '{{ steps.total_per_vendor.total }} > 2000',
            },
            {
                id: 'write_summary',
                type: 'summarize',
                label: 'Write the summary',
                source: '{{ steps.total_per_vendor.groups }}',
                style: 'bullets',
            },
            {
                id: 'notify_finance',
                type: 'notification',
                label: 'Post to finance',
                channel: 'email',
                // v5 changed the recipient; the test run of v5 bounced on it
                // (automationsRuns.ts), which is what the step drawer's error card shows.
                to: 'finance-team@example.com',
                subject: 'Weekly AI/SaaS spend — {{ now | date }}',
                body: '{{ steps.write_summary.text }}',
            },
        ],
        edges: [
            { from: 'trg', to: 'search_invoices' },
            { from: 'search_invoices', to: 'read_each' },
            { from: 'read_each', to: 'total_per_vendor' },
            { from: 'total_per_vendor', to: 'to_euros' },
            { from: 'to_euros', to: 'over_budget' },
            { from: 'over_budget', to: 'write_summary', branch: 'true' },
            { from: 'write_summary', to: 'notify_finance' },
        ],
        runPolicy: { retentionDays: 90 },
        notificationSettings: {
            onError: { enabled: true, channels: ['bell', 'email'], recipients: [{ type: 'owner' }, { type: 'group', id: 'grp_demo_finance' }], urgency: 'urgent', throttle: { maxPerHour: 1 }, delivery: 'direct' },
            onApproval: { enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'approver' }], urgency: 'normal', throttle: { maxPerHour: null }, delivery: 'direct' },
            onSuccess: { enabled: true, channels: ['bell'], recipients: [{ type: 'owner' }], urgency: 'silent', throttle: { maxPerHour: 1 }, delivery: 'digest' },
            digest: { enabled: true, time: '17:00' },
        },
    };
}

function onboardingDefinition() {
    return {
        title: 'New client intake',
        trigger: {
            id: 'trg',
            kind: 'app_event',
            event: 'file.new',
            label: 'On new file in /Clients',
            params: { path: '/Clients' },
        },
        steps: [
            {
                id: 'classify',
                type: 'ai_step',
                label: 'Classify the document',
                modelTier: 'fast',
                prompt: 'Classify this document as one of: contract, id_document, invoice, other. Answer with one word.\n\n{{ trigger.file.text }}',
            },
            {
                id: 'route',
                type: 'switch',
                label: 'Route by type',
                on: '{{ steps.classify.text }}',
                cases: ['contract', 'id_document', 'invoice'],
            },
            {
                id: 'ask_review',
                type: 'approval',
                label: 'Ask the account manager to confirm',
                assignee: 'demo@example.com',
                prompt: 'A new contract arrived. File it under the client folder?',
            },
        ],
        edges: [
            { from: 'trg', to: 'classify' },
            { from: 'classify', to: 'route' },
            { from: 'route', to: 'ask_review', branch: 'contract' },
        ],
    };
}

/** What every automation row carries; each automation below says how it differs. */
const automationRow = (fields) => ({
    userId: 'demo-user',
    organizationId: 'demo-org',
    kind: 'automation',
    isDraft: false,
    needsFirstRunConfirm: false,
    scheduleCron: null,
    scheduleTz: 'Europe/Amsterdam',
    nextRunAt: null,
    isPublished: false,
    sharedGroups: [],
    publishedVersion: null,
    exposeAsTool: false,
    icon: null,
    category: null,
    folderId: null,
    myRole: 'owner',
    accessVia: 'owner',
    neverLive: false,
    pendingChanges: 0,
    ...fields,
});

// Live state (handoff 5): `version` is the working copy, `liveVersion` what
// runs execute. The spend report and the digest are live on v3 with two
// changes not live yet, so the header offers "Make v5 live".
const AUTOMATIONS = () => ([
    automationRow({
        id: AUTOMATION_ID,
        title: 'Weekly AI/SaaS spend report',
        description: 'Reads last week’s billing emails, totals them per vendor and posts a summary.',
        definition: spendReportDefinition(),
        version: 5,
        liveVersion: 3,
        liveAt: daysAgo(12),
        pendingChanges: 2,
        isActive: true,
        triggerType: 'manual',
        lastRunAt: minutesAgo(103),
        lastStatus: 'awaiting_approval',
        exposeAsTool: true,
        icon: 'Receipt',
        folderId: 'fld_demo_finance',
        createdAt: daysAgo(46),
        updatedAt: minutesAgo(25),
    }),
    automationRow({
        id: 'auto_demo_intake',
        title: 'New client intake',
        description: 'Classifies documents dropped in /Clients and asks for a human OK before filing.',
        definition: onboardingDefinition(),
        version: 3,
        liveVersion: 3,
        liveAt: daysAgo(10),
        isActive: true,
        triggerType: 'app_event',
        lastRunAt: minutesAgo(37),
        lastStatus: 'success',
        folderId: 'fld_demo_clients',
        createdAt: daysAgo(12),
        updatedAt: minutesAgo(37),
    }),
    automationRow({
        id: 'auto_demo_digest',
        title: 'Monday morning digest',
        description: 'Every Monday at 08:00: open actions, upcoming renewals and last week’s decisions.',
        definition: {
            title: 'Monday morning digest',
            trigger: { id: 'trg', kind: 'schedule', cron: '0 8 * * 1', label: 'Mondays at 08:00' },
            steps: [
                { id: 'gather', type: 'ai_step', label: 'Gather open actions', modelTier: 'fast', prompt: 'List the open action items from last week.' },
                { id: 'send', type: 'notification', label: 'Email the team', channel: 'email', to: 'team@example.com', subject: 'Monday digest', body: '{{ steps.gather.text }}' },
            ],
            edges: [{ from: 'trg', to: 'gather' }, { from: 'gather', to: 'send' }],
        },
        version: 5,
        liveVersion: 3,
        liveAt: daysAgo(30),
        pendingChanges: 2,
        isActive: true,
        triggerType: 'schedule',
        scheduleCron: '0 8 * * 1',
        nextRunAt: daysAgo(-2),
        lastRunAt: daysAgo(5),
        lastStatus: 'success',
        createdAt: daysAgo(90),
        updatedAt: daysAgo(2),
    }),
    // Shared with the visitor by a colleague, who can edit it.
    automationRow({
        id: 'auto_demo_supplier',
        userId: 'usr_demo_sdeboer',
        title: 'Supplier onboarding',
        description: 'Adds a new supplier to the register and sends them a welcome email with our invoicing rules.',
        definition: {
            title: 'Supplier onboarding',
            trigger: { id: 'trg', kind: 'manual', label: 'Manual trigger' },
            steps: [
                { id: 'draft_welcome', type: 'ai_step', label: 'Draft the welcome email', modelTier: 'fast', prompt: 'Write a short welcome email for {{ trigger.output.supplier }} that explains how to send us invoices.' },
                { id: 'email_supplier', type: 'notification', label: 'Email the supplier', channel: 'email', to: '{{ trigger.output.email }}', body: '{{ steps.draft_welcome.text }}' },
            ],
            edges: [{ from: 'trg', to: 'draft_welcome' }, { from: 'draft_welcome', to: 'email_supplier' }],
        },
        version: 4,
        liveVersion: 4,
        liveAt: daysAgo(40),
        isActive: true,
        triggerType: 'manual',
        lastRunAt: daysAgo(2),
        lastStatus: 'success',
        myRole: 'edit',
        accessVia: 'share',
        owner: { userId: 'usr_demo_sdeboer', name: 'S. de Boer' },
        createdAt: daysAgo(70),
        updatedAt: daysAgo(40),
    }),
    // A draft that never went live: its one step still lacks a recipient.
    automationRow({
        id: 'auto_demo_vat',
        title: 'Quarterly VAT reminder',
        description: '',
        definition: {
            title: 'Quarterly VAT reminder',
            trigger: { id: 'trg', kind: 'schedule', cron: '0 9 1 1,4,7,10 *', label: 'First day of each quarter at 09:00' },
            steps: [{ id: 'remind', type: 'notification', label: 'Email the accountant', channel: 'email', to: '', subject: 'VAT return due this month' }],
            edges: [{ from: 'trg', to: 'remind' }],
        },
        version: 1,
        liveVersion: null,
        liveAt: null,
        neverLive: true,
        isDraft: true,
        isActive: false,
        triggerType: 'schedule',
        scheduleCron: '0 9 1 1,4,7,10 *',
        lastRunAt: null,
        lastStatus: null,
        folderId: 'fld_demo_finance',
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
    }),
    // Graph-shaped mail, JSON text and fenced AI JSON (automationsNested.ts).
    automationRow(nestedAutomationFields()),
    // Gmail per-item fan-out: 4 mails × 16 attachments, 3 list levels (automationsMailFanout.ts).
    automationRow(mailFanoutAutomationFields()),
    // A Condition after a list of mails with attachments (automationsMailCondition.ts).
    automationRow(mailConditionAutomationFields()),
    // The same mails split by file type with a three-output list Condition.
    automationRow(mailSplitAutomationFields()),
    automationRow(mailFlattenAutomationFields()), automationRow(ordersFlattenAutomationFields()),
]);

const TASKS = () => ([
    {
        id: 'task_demo_competitors',
        userId: 'demo-user',
        title: 'Competitor watch',
        prompt: 'Search the web for announcements from our three main competitors in the last 24 hours. Summarise anything that affects our roadmap, and say plainly if there is nothing worth reporting.',
        repeatInterval: 'daily',
        nextRunAt: daysAgo(-1),
        lastRunAt: daysAgo(1),
        lastResult: 'Nothing material in the last 24 hours. One competitor published a changelog entry about SSO; no pricing or positioning changes.',
        lastStatus: 'success',
        isActive: true,
        modelTier: 'standard',
        toolsEnabled: ['agent_search'],
        maxResultLength: 50000,
        runCount: 46,
        timezone: 'Europe/Amsterdam',
        createdAt: daysAgo(46),
        agentId: null,
        conversationId: null,
        daysOfWeek: null,
        timeOfDay: '07:30',
    },
    {
        id: 'task_demo_renewals',
        userId: 'demo-user',
        title: 'Contract renewal check',
        prompt: 'Look through the contracts knowledge base for agreements whose notice period ends in the next 45 days. List them with the deadline and the required notice method.',
        repeatInterval: 'weekly',
        nextRunAt: daysAgo(-4),
        lastRunAt: daysAgo(3),
        lastResult: 'Two agreements need attention: Van Dijk B.V. (notice by 12 September, written) and Meridian Cloud (notice by 30 September, email to their account manager).',
        lastStatus: 'success',
        isActive: true,
        modelTier: 'standard',
        toolsEnabled: ['kb_search'],
        maxResultLength: 50000,
        runCount: 11,
        timezone: 'Europe/Amsterdam',
        createdAt: daysAgo(77),
        agentId: null,
        conversationId: null,
        daysOfWeek: [1],
        timeOfDay: '09:00',
    },
]);

const STEPS = () => ([
    {
        id: STEP_LIBRARY_ID,
        kind: 'block',
        title: 'Vendor lookup',
        description: 'Takes a vendor name and returns the contract owner, renewal date and monthly spend.',
        definition: {
            title: 'Vendor lookup',
            trigger: { id: 'trg', kind: 'manual' },
            steps: [
                { id: 'find', type: 'ai_step', label: 'Find the vendor record', modelTier: 'fast', prompt: 'Look up {{ input.vendor }} in the contracts knowledge base.' },
                { id: 'out', type: 'layer_output', label: 'Return the record', value: '{{ steps.find.text }}' },
            ],
            edges: [{ from: 'trg', to: 'find' }, { from: 'find', to: 'out' }],
        },
        isPublished: true,
        publishedVersion: 2,
        exposeAsTool: true,
        icon: 'Search',
        category: 'Finance',
        sharedGroups: [],
        version: 2,
        isActive: true,
        isDraft: false,
        createdAt: daysAgo(60),
        updatedAt: daysAgo(9),
    },
]);

const AGENTS = () => ([
    { id: 'agent_demo_analyst', name: 'Finance analyst', avatar: '📊', description: 'Answers questions about spend, contracts and renewals.' },
    { id: 'agent_demo_intake', name: 'Client intake', avatar: '📥', description: 'Reads incoming documents and files them.' },
]);

export function createState() {
    const automations = AUTOMATIONS();
    return {
        automations,
        tasks: TASKS(),
        steps: STEPS(),
        agents: AGENTS(),
        // The Runs tab, the Versions tab and Settings (handoff 5): each in
        // its own module, all reading this one state.
        runs: [...seedRuns(), ...seedNestedRuns(), ...seedMailFanoutRuns(), ...seedMailConditionRuns(), ...seedMailSplitRuns(), ...seedMailFlattenRuns()],
        versions: seedVersions(automations),
        aiAct: seedAiAct(),
        shares: seedShares(),
        folders: seedFolders(),
        trash: seedTrash(),
        webhooks: seedWebhooks(),
        orgTemplates: [],
    };
}


// ── Run engine ───────────────────────────────────────────────────────
//
// Pressing ▶ on a node calls POST /api/automation/:id/steps/:stepId/run and
// merges the returned step rows into the canvas. Without an answer the panel
// just says "No run output for this step yet", which shows the chrome and
// none of the behaviour — you cannot see what a workflow DOES.
//
// So each step has a canned result, and they are consistent with each other:
// the loop consumes what the search returned, the aggregate totals what the
// loop extracted, the condition tests that total. Executing steps in order
// also populates the INPUT panel of the next node, because that panel is
// built from upstream outputs.
//
// Row shape mirrors the server's: { stepId, stepType, status, input, output }.

const INVOICES = [
    { id: 'msg_a1', from: 'billing@anthropic.com', subject: 'Your Anthropic invoice', date: '2026-07-22', vendor: 'Anthropic', amount: 842.00 },
    { id: 'msg_a2', from: 'invoice@openai.com', subject: 'OpenAI receipt', date: '2026-07-23', vendor: 'OpenAI', amount: 611.40 },
    { id: 'msg_a3', from: 'billing@scaleway.com', subject: 'Facture Scaleway', date: '2026-07-24', vendor: 'Scaleway', amount: 388.05 },
    { id: 'msg_a4', from: 'receipts@github.com', subject: 'GitHub Team', date: '2026-07-25', vendor: 'GitHub', amount: 176.00 },
    { id: 'msg_a5', from: 'no-reply@figma.com', subject: 'Figma monthly', date: '2026-07-26', vendor: 'Figma', amount: 300.00 },
];

const LINE_ITEMS = INVOICES.map(i => ({
    vendor: i.vendor,
    description: `${i.vendor} — monthly subscription`,
    amount: i.amount,
    currency: 'EUR',
    period: '2026-07',
}));

const TOTAL = LINE_ITEMS.reduce((n, l) => n + l.amount, 0);   // 2317.45

const SUMMARY_TEXT = [
    'AI/SaaS spend, week of 22–26 July: 2.317,45 EUR across 5 vendors.',
    '',
    '- Anthropic      842,00',
    '- OpenAI         611,40',
    '- Scaleway       388,05',
    '- Figma          300,00',
    '- GitHub         176,00',
    '',
    'Above the 2.000 EUR threshold, so finance has been notified.',
].join('\n');

/** stepId → what a real run of that step would produce. */
const STEP_RESULTS = {
    trg: {
        stepType: 'trigger',
        input: null,
        output: { triggeredBy: 'demo@example.com', at: '2026-07-27T09:00:00.000Z', kind: 'manual' },
    },
    search_invoices: {
        stepType: 'integration_action',
        input: { query: 'from:(billing OR invoice OR receipt) newer_than:7d', maxResults: 100 },
        output: { messages: INVOICES.map(({ id, from, subject, date }) => ({ id, from, subject, date })), resultSizeEstimate: INVOICES.length },
    },
    read_message: {
        stepType: 'integration_action',
        input: { messageId: 'msg_a1' },
        output: { id: 'msg_a1', from: 'billing@anthropic.com', subject: 'Your Anthropic invoice', body: 'Invoice 2026-07-0042\nPlan: Team\nPeriod: July 2026\nTotal due: EUR 842.00' },
    },
    extract_lines: {
        stepType: 'ai_step',
        input: { modelTier: 'fast', prompt: 'Extract every billing line item…' },
        output: [LINE_ITEMS[0]],
    },
    read_each: {
        stepType: 'loop',
        input: { over: '{{ steps.search_invoices.messages }}', as: 'message' },
        output: { iterations: INVOICES.length, results: LINE_ITEMS },
    },
    total_per_vendor: {
        stepType: 'aggregate',
        input: { groupBy: 'vendor', operation: 'sum', field: 'amount' },
        output: {
            groups: LINE_ITEMS
                .map(l => ({ vendor: l.vendor, total: l.amount }))
                .sort((a, b) => b.total - a.total),
            total: Number(TOTAL.toFixed(2)),
            currency: 'EUR',
        },
    },
    over_budget: {
        stepType: 'condition',
        input: { expr: '{{ steps.total_per_vendor.total }} > 2000' },
        output: { result: true, evaluated: `${TOTAL.toFixed(2)} > 2000`, branch: 'true' },
    },
    write_summary: {
        stepType: 'summarize',
        input: { style: 'bullets', source: '{{ steps.total_per_vendor.groups }}' },
        output: { text: SUMMARY_TEXT },
    },
    notify_finance: {
        stepType: 'notification',
        input: { channel: 'email', to: 'finance@example.com' },
        // The one place the demo must not look like it did something real.
        output: { delivered: false, to: 'finance@example.com', subject: 'Weekly AI/SaaS spend — 27 Jul 2026', demo: 'No email was sent — the demo has no network access.' },
    },
    ...NESTED_STEP_RESULTS,
    ...MAIL_FANOUT_STEP_RESULTS,
    ...MAIL_CONDITION_STEP_RESULTS,
    ...MAIL_SPLIT_STEP_RESULTS,
    ...MAIL_FLATTEN_STEP_RESULTS, ...ORDERS_FLATTEN_STEP_RESULTS,
};

/** Execution order, so `mode: 'from'` can run the tail of the graph. */
const RUN_ORDER = ['trg', 'search_invoices', 'read_each', 'total_per_vendor', 'over_budget', 'write_summary', 'notify_finance'];

function stepRow(stepId) {
    const r = STEP_RESULTS[stepId];
    if (!r) return { stepId, stepType: 'unknown', status: 'success', input: null, output: { demo: 'No sample output for this step.' } };
    return { stepId, stepType: r.stepType, status: 'success', input: r.input, output: r.output, error: null };
}

function runEnvelope(automationId, stepIds) {
    return {
        run: {
            id: 'run_demo_live',
            automationId,
            status: 'success',
            startedAt: new Date(Date.now() - 1200).toISOString(),
            finishedAt: new Date().toISOString(),
            stepCount: stepIds.length,
            demo: true,
        },
        steps: stepIds.map(stepRow),
    };
}

const find = (list, id) => list.find(x => x.id === id) || null;
const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

export const ROUTES = {
    ...COMMON_ROUTES,

    // One segment after /api/automation, so they come BEFORE
    // `GET /api/automation/:id` (first match wins): declared after it, the
    // templates, folders and trash all answered "Not found".
    ...SETTINGS_LIBRARY_ROUTES,
    ...TEMPLATE_ROUTES,
    // Literal paths under /api/automation, so ahead of `/:id` like the rest.
    ...CODE_ROUTES,
    'GET /api/automation/catalog': ({ state }) => ({ tools: [], apps: [...NESTED_CATALOG_APPS, MAIL_FANOUT_CATALOG_APP], steps: state.steps, flags: { code: true, codeReason: null } }),

    // ── Scheduled agent work (Cowork items that run as an agent) ──
    'GET /api/cowork': ({ state }) => ({ schedules: state.tasks, maxSchedules: 25 }),
    'POST /api/cowork': ({ state, body }) => {
        const task = { ...TASKS()[0], ...body, id: `task_demo_${state.tasks.length + 1}`, runCount: 0, lastStatus: 'pending', lastResult: null };
        state.tasks.unshift(task);
        return task;
    },
    'PUT /api/cowork/:id': ({ state, params, body }) => {
        const task = find(state.tasks, params.id);
        if (!task) return notFound();
        Object.assign(task, body || {});
        return { success: true };
    },
    'POST /api/cowork/:id/toggle': ({ state, params }) => {
        const task = find(state.tasks, params.id);
        if (!task) return notFound();
        task.isActive = !task.isActive;
        return { success: true, isActive: task.isActive };
    },
    'POST /api/cowork/:id/run-now': ({ state, params }) => {
        const task = find(state.tasks, params.id);
        if (!task) return notFound();
        task.lastStatus = 'success';
        task.lastRunAt = new Date().toISOString();
        task.runCount += 1;
        task.lastResult = 'Demo run — this is sample output. In the product this is what the model actually returned.';
        return { success: true, message: 'Cowork started. The result arrives in your notifications.' };
    },
    'DELETE /api/cowork/:id': ({ state, params }) => {
        state.tasks = state.tasks.filter(t => t.id !== params.id);
        return { success: true };
    },

    // ── Automations ──
    'GET /api/automation': ({ state }) => ({ automations: state.automations }),
    'GET /api/automation/:id': ({ state, params }) => find(state.automations, params.id) || notFound(),
    'POST /api/automation': ({ state, body }) => {
        const created = automationRow({
            id: `auto_demo_${state.automations.length + 1}`,
            title: body?.title || 'Untitled automation',
            description: body?.description || '',
            definition: body?.definition || { trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] },
            version: 1, liveVersion: null, liveAt: null, neverLive: true, isDraft: true, isActive: false,
            lastRunAt: null, lastStatus: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        state.automations.unshift(created);
        return { success: true, automation: created };
    },
    // Autosave. Only a structural change is a new version (and, on a live
    // automation, one more change not live); moving a node is not.
    'PUT /api/automation/:id': ({ state, params, body }) => {
        const a = find(state.automations, params.id);
        if (!a) return notFound();
        const { version: _v, liveVersion: _l, pendingChanges: _p, ...changes } = body || {};
        const previous = a.definition;
        Object.assign(a, changes, { updatedAt: new Date().toISOString() });
        recordSave(state, a, previous);
        return { success: true, automation: a, warnings: [] };
    },
    // Never live: the working copy goes live and on. Live: just switched on.
    'POST /api/automation/:id/activate': ({ state, params }) => {
        const a = find(state.automations, params.id);
        if (!a) return notFound();
        if (a.liveVersion == null) Object.assign(a, { liveVersion: a.version, liveAt: new Date().toISOString(), neverLive: false, isDraft: false, pendingChanges: 0 });
        a.isActive = true;
        return { success: true, automation: a, warnings: [] };
    },
    'POST /api/automation/:id/deactivate': ({ state, params }) => {
        const a = find(state.automations, params.id);
        if (!a) return notFound();
        a.isActive = false;
        return { success: true, automation: a };
    },
    'POST /api/automation/:id/run': ({ state, params, body }) => {
        const a = find(state.automations, params.id);
        if (!a) return notFound();
        a.lastRunAt = new Date().toISOString();
        a.lastStatus = 'success';
        // Every node lights up with its sample output, so "Run flow" shows the
        // whole behaviour rather than a toast; the Runs tab lists the run.
        const env = runEnvelope(params.id, RUN_ORDER);
        env.run.id = recordRun(state, params.id, body?.test === true).id;
        return { success: true, ...env };
    },

    // Per-node ▶. `mode: 'only'` runs this step; `mode: 'from'` runs it and
    // everything downstream — the same two modes the real endpoint takes.
    'POST /api/automation/:id/steps/:stepId/run': ({ state, params, body }) => {
        const a = find(state.automations, params.id);
        if (!a) return notFound();
        const idx = RUN_ORDER.indexOf(params.stepId);
        const ids = body?.mode === 'from' && idx >= 0
            ? RUN_ORDER.slice(idx)
            : [params.stepId];
        const env = runEnvelope(params.id, ids);
        return { ...env, stepRecord: env.steps[0] };
    },

    // Dry run — same rows, flagged so the UI can label it.
    'POST /api/automation/:id/dry-run': ({ params }) => ({
        ...runEnvelope(params.id, RUN_ORDER),
        dryRun: true,
    }),

    // The Runs tab, the Versions tab and Settings (handoff 5). The builder
    // rehydrates the canvas from the newest run's step rows on mount
    // (hydrateLastRun), which is the failed test run: every step upstream
    // shows its output, "Post to finance" shows why it stopped.
    ...runRoutes(stepRow),
    ...VERSION_ROUTES,
    ...AI_ACT_ROUTES,
    ...SETTINGS_ROUTES,

    /**
     * "Which app buttons run this automation" — the capsule above the builder
     * (UsedByButtonsCapsule.jsx) asks on every mount, so an unfixtured route
     * is a silent failure on the FIRST screen of this demo.
     *
     * It reads three outcomes apart and the fixture has to pick one honestly:
     * a missing list means "could not check", `[]` with `complete:true`
     * means "no app button runs this", and `complete:false` means the index
     * has not seen every app yet. The demo ships no apps at all, so the true
     * answer is a fully-checked empty list — never a made-up button, and
     * never `null`, which would print "could not be checked" about a
     * question that was in fact answered.
     */
    'GET /api/automation/:id/usage': () => ({ usage: [], complete: true }),

    // ── Reusable Steps ──
    'GET /api/step': ({ state }) => ({ steps: state.steps }),
    'GET /api/step/:id': ({ state, params }) => find(state.steps, params.id) || notFound(),

    // ── Things the builder asks for that have no demo answer ──
    // Explicitly empty rather than missing, so the panels render their real
    // empty states instead of an error.
    'GET /api/automation/_runs/stream': () => ({ runs: [] }),
    // Polled every few seconds for the "● now executing" dot.
    'GET /api/automation/_runs/active': () => ({ runs: [] }),
    // The AI builder's chat session for this automation. No prior
    // conversation in the demo, and the composer renders its empty state.
    'GET /api/automation/builder/session/:id': () => ({ snapshot: null }),
    // "Find repeating work": its sources, the last scan, a replayed scan and
    // the feedback (automationsRepeating.ts).
    ...REPEATING_ROUTES,
    // The ribbon's "Frequently used" grid: what this demo org adds most.
    'GET /api/automation/_usage/steps': () => ([
        { key: 'step:ai_step', count: 42 }, { key: 'step:condition', count: 18 },
        { key: 'step:approval', count: 9 }, { key: 'step:wait', count: 6 },
    ]),
    'GET /api/integrations/connections': () => ({
        connections: [{ id: 'conn_demo_gmail', app: 'gmail', label: 'demo@example.com', status: 'connected' }],
    }),
};
