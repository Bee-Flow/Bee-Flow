/**
 * App Studio — starter templates.
 *
 * Static gallery mirroring server/automation/templates.js. Each entry is
 * { id, title, description, category, icon, tags, definition } and MAY also
 * carry the OPTIONAL data-side of a template:
 *
 *   dataModel — a dataModel.js model (tables/fields/roles/access). Installed by
 *               templateInstall.js via the saveDataModel CAS seam (which runs
 *               migrationPlan → SQLite DDL). Field/table stable ids are
 *               authored here so the definition's record/records bindings
 *               resolve to them.
 *   seed      — { [tableId]: Row[] } demo rows (≤50/table). A Row is a
 *               { fieldKey: value } map; a `$id` key is a LOCAL alias (never a
 *               column) and a relation value of { $ref: '<alias>' } points at a
 *               previously-seeded row in the referenced table. templateInstall
 *               seeds PARENT tables first and rewrites $ref → the parent's real
 *               rec_ id. Every row is written through actionExecutor.writeRecord
 *               (RLS + quotas asserted; created_by = the owner).
 *   datasets  — BI descriptors created via studioAppDataStore.createDataset.
 *
 * SEEDING & VISIBILITY (review G2): demo tables use `access.default:'app'` so
 * owner-seeded rows are visible to EVERY viewer — under an `own` access mode a
 * viewer only sees rows they created, which would leave a shared demo empty.
 * The ONE deliberate exception is the ticket tracker's "My tickets" screen: the
 * tickets table is still `app`-scoped, but that screen's records binding filters
 * `created_by = currentUser.id`, demonstrating per-user scoping (and proving the
 * Wave 1a run-view fix — `currentUser` resolves in production).
 *
 * The DEFINITION is installed by studioApps.js's create-from-template clone
 * path; templateInstall.js owns ONLY the data side (model + seed + datasets).
 *
 * run_automation actions ship with automationId: null on purpose — users wire
 * their own routine after install. validate.js reports that as the friendly
 * 'action.automation_unset' warning, which the editor renders as a
 * "connect a routine" setup checklist, so templates install cleanly without
 * any routine dependencies.
 *
 * templates.test.js asserts every definition passes canonicalize + validate
 * with zero errors (passing each template's own dataModel + dataset ids so the
 * data-reference cross-checks resolve), every dataModel passes validateDataModel,
 * and every seed row conforms to its table.
 */

'use strict';

const THEME_DEFAULTS = {
    radius: 'md',
    density: 'comfortable',
    fontScale: 'md',
    appearance: 'auto',
};

const TEMPLATES = [
    // ------------------------------------------------------------------
    // 1. Request form — the canonical v1 demo: form → routine → thanks.
    // ------------------------------------------------------------------
    {
        id: 'app-request-form',
        version: 1,
        title: 'Request form',
        description: 'Collect requests with a simple form that hands each submission to one of your Routines, then shows a thank-you screen.',
        category: 'Forms',
        icon: 'ClipboardList',
        tags: ['form', 'intake', 'requests'],
        definition: {
            schemaVersion: 1,
            meta: { name: 'Request form', description: 'Submit a request to the team.', icon: 'ClipboardList' },
            theme: { primary: '#0F766E', ...THEME_DEFAULTS },
            homeScreenId: 'scr_reqhome',
            screens: [
                {
                    id: 'scr_reqhome',
                    name: 'New request',
                    icon: 'ClipboardList',
                    showInNav: true,
                    maxWidth: 'narrow',
                    sections: [
                        {
                            id: 'sec_reqintro',
                            style: { padding: 4, gap: 2, background: 'none' },
                            children: [
                                { id: 'cmp_reqtitle', type: 'heading', props: { text: 'Submit a request', level: 1 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_reqlead', type: 'text', props: { text: 'Fill in the details below and the team will pick it up.', muted: true }, style: { span: 12 }, visible: true },
                            ],
                        },
                        {
                            id: 'sec_reqform',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                {
                                    id: 'cmp_reqfrm',
                                    type: 'form',
                                    props: { name: 'request', submitLabel: 'Send request', showReset: false },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_reqsubmit',
                                    children: [
                                        { id: 'cmp_reqname', type: 'input_text', props: { name: 'name', label: 'Your name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_reqmail', type: 'input_text', props: { name: 'email', label: 'Email', required: true, inputType: 'email' }, style: { span: 6 }, visible: true },
                                        {
                                            id: 'cmp_reqkind',
                                            type: 'input_select',
                                            props: {
                                                name: 'category',
                                                label: 'Category',
                                                required: true,
                                                options: [
                                                    { value: 'question', label: 'Question' },
                                                    { value: 'change', label: 'Change request' },
                                                    { value: 'issue', label: 'Report an issue' },
                                                ],
                                            },
                                            style: { span: 6 },
                                            visible: true,
                                        },
                                        { id: 'cmp_reqwhen', type: 'input_date', props: { name: 'needed_by', label: 'Needed by', required: false, defaultValue: null }, style: { span: 6 }, visible: true },
                                        { id: 'cmp_reqmsg', type: 'input_textarea', props: { name: 'details', label: 'Details', required: true, rows: 5 }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_reqdone',
                    name: 'Thanks',
                    icon: 'CheckCircle2',
                    showInNav: false,
                    maxWidth: 'narrow',
                    sections: [
                        {
                            id: 'sec_reqdone',
                            style: { padding: 6, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_reqok', type: 'callout', props: { title: 'Request received', text: 'Thanks — the team has your request and will follow up by email.', tone: 'success' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_reqagain', type: 'button', props: { label: 'Submit another', variant: 'secondary', role: 'button' }, style: { span: 4 }, visible: true, onClick: 'act_reqagain' },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_reqsubmit: {
                    kind: 'run_automation',
                    automationId: null,
                    inputMapping: {},
                    onSuccess: { toast: { message: 'Request sent.', tone: 'success' }, navigateTo: 'scr_reqdone' },
                    onError: { toast: { message: 'Could not send your request — please try again.', tone: 'danger' } },
                },
                act_reqagain: { kind: 'navigate', screenId: 'scr_reqhome' },
            },
        },
    },

    // ------------------------------------------------------------------
    // 2. Lookup console — search form → routine result in a table + stat.
    // ------------------------------------------------------------------
    {
        id: 'app-lookup-console',
        version: 1,
        title: 'Lookup console',
        description: 'A search box wired to a Routine, with the results in a table and a match counter. Point it at any routine that returns rows.',
        category: 'Data',
        icon: 'Search',
        tags: ['search', 'lookup', 'table'],
        definition: {
            schemaVersion: 1,
            meta: { name: 'Lookup console', description: 'Search records via a routine.', icon: 'Search' },
            theme: { primary: '#0369A1', ...THEME_DEFAULTS },
            homeScreenId: 'scr_lookup',
            screens: [
                {
                    id: 'scr_lookup',
                    name: 'Search',
                    icon: 'Search',
                    showInNav: true,
                    maxWidth: 'medium',
                    sections: [
                        {
                            id: 'sec_lookhdr',
                            style: { padding: 4, gap: 2, background: 'none' },
                            children: [
                                { id: 'cmp_looktitle', type: 'heading', props: { text: 'Lookup', level: 1 }, style: { span: 12 }, visible: true },
                                {
                                    id: 'cmp_lookfrm',
                                    type: 'form',
                                    props: { name: 'search', submitLabel: 'Search', showReset: false },
                                    style: { span: 12, gap: 2, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_looksearch',
                                    children: [
                                        { id: 'cmp_lookq', type: 'input_text', props: { name: 'query', label: 'Name or email', placeholder: 'e.g. jane@acme.com', required: true, inputType: 'text' }, style: { span: 8 }, visible: true },
                                    ],
                                },
                            ],
                        },
                        {
                            id: 'sec_lookres',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                {
                                    id: 'cmp_lookcount',
                                    type: 'stat',
                                    props: { label: 'Matches', value: { kind: 'actionResult', actionId: 'act_looksearch', path: 'count' }, icon: 'Hash' },
                                    style: { span: 3 },
                                    visible: true,
                                },
                                {
                                    id: 'cmp_looktable',
                                    type: 'table',
                                    props: {
                                        source: { kind: 'actionResult', actionId: 'act_looksearch', path: 'rows' },
                                        columns: [
                                            { key: 'name', label: 'Name', format: 'text' },
                                            { key: 'email', label: 'Email', format: 'text' },
                                            { key: 'status', label: 'Status', format: 'badge' },
                                        ],
                                        emptyText: 'Run a search to see results.',
                                        rowLimit: 25,
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_looksearch: {
                    kind: 'run_automation',
                    automationId: null,
                    inputMapping: { query: { kind: 'field', name: 'query' } },
                    onError: { toast: { message: 'Search failed — try again.', tone: 'danger' } },
                },
            },
        },
    },

    // ------------------------------------------------------------------
    // 3. Ops dashboard — KPI tiles + table fed by one refresh routine.
    // ------------------------------------------------------------------
    {
        id: 'app-ops-dashboard',
        version: 1,
        title: 'Ops dashboard',
        description: 'Four KPI tiles and a work-queue table, all fed by a single "refresh" Routine, plus a maintenance screen with a run button.',
        category: 'Dashboards',
        icon: 'Gauge',
        tags: ['dashboard', 'kpi', 'operations'],
        definition: {
            schemaVersion: 1,
            meta: { name: 'Ops dashboard', description: 'Team operations at a glance.', icon: 'Gauge' },
            theme: { primary: '#047857', ...THEME_DEFAULTS },
            homeScreenId: 'scr_opshome',
            screens: [
                {
                    id: 'scr_opshome',
                    name: 'Overview',
                    icon: 'Gauge',
                    showInNav: true,
                    maxWidth: 'wide',
                    sections: [
                        {
                            id: 'sec_opshdr',
                            style: { padding: 4, gap: 2, background: 'none' },
                            children: [
                                { id: 'cmp_opstitle', type: 'heading', props: { text: 'Operations', level: 1 }, style: { span: 9 }, visible: true },
                                { id: 'cmp_opsrefresh', type: 'button', props: { label: 'Refresh', variant: 'ghost', iconLeft: 'RefreshCw', role: 'button' }, style: { span: 3, align: 'end' }, visible: true, onClick: 'act_opsrefresh' },
                            ],
                        },
                        {
                            id: 'sec_opskpis',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_opsk1', type: 'stat', props: { label: 'Open items', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'open' }, icon: 'Inbox' }, style: { span: 3 }, visible: true },
                                { id: 'cmp_opsk2', type: 'stat', props: { label: 'In progress', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'inProgress' }, icon: 'Loader' }, style: { span: 3 }, visible: true },
                                { id: 'cmp_opsk3', type: 'stat', props: { label: 'Done today', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'doneToday' }, icon: 'CheckCircle2', caption: 'since midnight' }, style: { span: 3 }, visible: true },
                                { id: 'cmp_opsk4', type: 'stat', props: { label: 'Overdue', value: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'overdue' }, icon: 'AlertTriangle' }, style: { span: 3, color: 'danger' }, visible: true },
                            ],
                        },
                        {
                            id: 'sec_opsqueue',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                {
                                    id: 'cmp_opstable',
                                    type: 'table',
                                    props: {
                                        source: { kind: 'actionResult', actionId: 'act_opsrefresh', path: 'queue' },
                                        columns: [
                                            { key: 'title', label: 'Item', format: 'text' },
                                            { key: 'assignee', label: 'Assignee', format: 'text' },
                                            { key: 'due', label: 'Due', format: 'date' },
                                            { key: 'status', label: 'Status', format: 'badge' },
                                        ],
                                        emptyText: 'Hit Refresh to load the queue.',
                                        rowLimit: 50,
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_opsmaint',
                    name: 'Maintenance',
                    icon: 'Wrench',
                    showInNav: true,
                    maxWidth: 'narrow',
                    sections: [
                        {
                            id: 'sec_opsmaint',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_opsmhead', type: 'heading', props: { text: 'Maintenance', level: 2 }, style: { span: 12 }, visible: true },
                                { id: 'cmp_opsmwarn', type: 'callout', props: { title: 'Careful', text: 'This triggers the maintenance routine for the whole team. Run it only when needed.', tone: 'warning' }, style: { span: 12 }, visible: true },
                                { id: 'cmp_opsmrun', type: 'button', props: { label: 'Run maintenance', variant: 'danger', iconLeft: 'Wrench', role: 'button' }, style: { span: 5 }, visible: true, onClick: 'act_opsmaint' },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_opsrefresh: {
                    kind: 'run_automation',
                    automationId: null,
                    inputMapping: {},
                    onError: { toast: { message: 'Could not load dashboard data.', tone: 'danger' } },
                },
                act_opsmaint: {
                    kind: 'run_automation',
                    automationId: null,
                    inputMapping: {},
                    onSuccess: { toast: { message: 'Maintenance routine started.', tone: 'success' } },
                    onError: { toast: { message: 'Maintenance failed to start.', tone: 'danger' } },
                },
            },
        },
    },

    // ------------------------------------------------------------------
    // 4. Team hub — pure content + contact form; zero routine deps, so it
    //    works instantly on install and shows off theming/multi-screen nav.
    // ------------------------------------------------------------------
    {
        id: 'app-team-hub',
        version: 1,
        title: 'Team hub',
        description: 'A small internal site: welcome page, useful links, and a contact form. Works out of the box — no routine required.',
        category: 'Content',
        icon: 'Users',
        tags: ['intranet', 'content', 'links'],
        definition: {
            schemaVersion: 1,
            meta: { name: 'Team hub', description: 'Everything the team needs in one place.', icon: 'Users' },
            theme: { primary: '#B45309', ...THEME_DEFAULTS, radius: 'sm' },
            // Identity: the "paper" editorial look — warm amber, Cabinet
            // Grotesk, hairline surfaces — an intranet that reads like a
            // well-set document instead of an admin console.
            design: { preset: 'paper', font: 'cabinet', surface: 'hairline', motion: 'subtle', chartPalette: 'classic', logoUrl: null },
            homeScreenId: 'scr_hubhome',
            screens: [
                {
                    id: 'scr_hubhome',
                    name: 'Welcome',
                    icon: 'Home',
                    showInNav: true,
                    maxWidth: 'medium',
                    sections: [
                        {
                            id: 'sec_hubhero',
                            style: { padding: 5, gap: 2, background: 'gradient' },
                            children: [
                                { id: 'cmp_hubtitle', type: 'heading', props: { text: 'Welcome to the team hub', level: 1 }, style: { span: 12, align: 'center' }, visible: true },
                                { id: 'cmp_hublead', type: 'text', props: { text: 'Quick links, announcements and a direct line to the team.', muted: true }, style: { span: 12, align: 'center' }, visible: true },
                            ],
                        },
                        {
                            id: 'sec_hubcards',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                {
                                    id: 'cmp_hubcard1',
                                    type: 'card',
                                    props: { title: 'Getting started', description: 'New here? Start with these.' },
                                    style: { span: 6, padding: 3, gap: 2, background: 'surface' },
                                    visible: true,
                                    children: [
                                        { id: 'cmp_hubc1txt', type: 'text', props: { text: 'Read the onboarding guide, join the team channel, and book your intro call.', muted: false }, style: { span: 12 }, visible: true },
                                        { id: 'cmp_hubc1btn', type: 'button', props: { label: 'Open the guide', variant: 'secondary', iconLeft: 'BookOpen', role: 'button' }, style: { span: 6 }, visible: true, onClick: 'act_hubguide' },
                                    ],
                                },
                                {
                                    id: 'cmp_hubcard2',
                                    type: 'card',
                                    props: { title: 'This week', description: 'What is happening.' },
                                    style: { span: 6, padding: 3, gap: 2, background: 'surface' },
                                    visible: true,
                                    children: [
                                        { id: 'cmp_hubc2note', type: 'callout', props: { title: null, text: 'Sprint review Friday 15:00 — demo your work!', tone: 'info' }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_hubcontact',
                    name: 'Contact',
                    icon: 'Mail',
                    showInNav: true,
                    maxWidth: 'narrow',
                    sections: [
                        {
                            id: 'sec_hubform',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_hubchead', type: 'heading', props: { text: 'Contact the team', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                                {
                                    id: 'cmp_hubcfrm',
                                    type: 'form',
                                    props: { name: 'contact', submitLabel: 'Send message', showReset: false },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_hubcontact',
                                    children: [
                                        { id: 'cmp_hubcname', type: 'input_text', props: { name: 'name', label: 'Your name', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                        { id: 'cmp_hubcmsg', type: 'input_textarea', props: { name: 'message', label: 'Message', required: true, rows: 4 }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_hubguide: { kind: 'open_url', url: 'https://example.com/onboarding', newTab: true },
                act_hubcontact: {
                    kind: 'run_automation',
                    automationId: null,
                    inputMapping: {},
                    onSuccess: { toast: { message: 'Message sent — thanks!', tone: 'success' } },
                    onError: { toast: { message: 'Could not send your message.', tone: 'danger' } },
                },
            },
        },
    },

    // ------------------------------------------------------------------
    // 5. Approval inbox (lite) — pending list + decision form. Honest v1
    //    shape of approvals without table row-actions (first v1.1 item).
    // ------------------------------------------------------------------
    {
        id: 'app-approval-inbox',
        version: 1,
        title: 'Approval inbox',
        description: 'A pending-items list fed by one Routine and a decision form that submits approve/reject to another.',
        category: 'Data',
        icon: 'CheckSquare',
        tags: ['approvals', 'workflow', 'review'],
        definition: {
            schemaVersion: 1,
            meta: { name: 'Approval inbox', description: 'Review and decide on pending items.', icon: 'CheckSquare' },
            theme: { primary: '#1D4ED8', ...THEME_DEFAULTS },
            homeScreenId: 'scr_apprhome',
            screens: [
                {
                    id: 'scr_apprhome',
                    name: 'Inbox',
                    icon: 'Inbox',
                    showInNav: true,
                    maxWidth: 'medium',
                    sections: [
                        {
                            id: 'sec_apprlist',
                            style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_apprtitle', type: 'heading', props: { text: 'Pending approvals', level: 1 }, style: { span: 9 }, visible: true },
                                { id: 'cmp_apprload', type: 'button', props: { label: 'Load pending', variant: 'ghost', iconLeft: 'RefreshCw', role: 'button' }, style: { span: 3, align: 'end' }, visible: true, onClick: 'act_apprload' },
                                {
                                    id: 'cmp_apprlist',
                                    type: 'list',
                                    props: {
                                        source: { kind: 'actionResult', actionId: 'act_apprload', path: 'items' },
                                        titleKey: 'title',
                                        subtitleKey: 'requester',
                                        icon: 'FileText',
                                        emptyText: 'Nothing waiting for you. Load pending to check again.',
                                    },
                                    style: { span: 12 },
                                    visible: true,
                                },
                            ],
                        },
                        {
                            id: 'sec_apprdecide',
                            style: { padding: 4, gap: 3, background: 'surface' },
                            children: [
                                { id: 'cmp_apprdhead', type: 'heading', props: { text: 'Make a decision', level: 3 }, style: { span: 12 }, visible: true },
                                {
                                    id: 'cmp_apprfrm',
                                    type: 'form',
                                    props: { name: 'decision', submitLabel: 'Submit decision', showReset: true },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    visible: true,
                                    onSubmit: 'act_apprdecide',
                                    children: [
                                        { id: 'cmp_apprid', type: 'input_text', props: { name: 'item_id', label: 'Item ID', placeholder: 'Copy it from the list above', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                        {
                                            id: 'cmp_apprverdict',
                                            type: 'input_select',
                                            props: {
                                                name: 'decision',
                                                label: 'Decision',
                                                required: true,
                                                options: [
                                                    { value: 'approve', label: 'Approve' },
                                                    { value: 'reject', label: 'Reject' },
                                                ],
                                            },
                                            style: { span: 6 },
                                            visible: true,
                                        },
                                        { id: 'cmp_apprnote', type: 'input_textarea', props: { name: 'note', label: 'Note (optional)', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_apprload: {
                    kind: 'run_automation',
                    automationId: null,
                    inputMapping: {},
                    onError: { toast: { message: 'Could not load pending items.', tone: 'danger' } },
                },
                act_apprdecide: {
                    kind: 'run_automation',
                    automationId: null,
                    inputMapping: {},
                    onSuccess: { toast: { message: 'Decision recorded.', tone: 'success' } },
                    onError: { toast: { message: 'Could not record the decision.', tone: 'danger' } },
                },
            },
        },
    },
    // ==================================================================
    // DATA-BACKED TEMPLATES (v2 — own SQLite tables + seed rows).
    // ==================================================================

    // ------------------------------------------------------------------
    // 6. CRM pipeline — companies/contacts/deals; kanban by stage + a
    //    record-detail screen reached via navigate params.
    // ------------------------------------------------------------------
    {
        id: 'app-crm-pipeline',
        version: 1,
        title: 'CRM pipeline',
        description: 'A sales pipeline over your own data: drag deals across stages on a kanban, filter by name, and drill into a deal. Ships with companies, contacts and deals.',
        category: 'Data',
        icon: 'Kanban',
        tags: ['crm', 'sales', 'pipeline', 'kanban'],
        dataModel: {
            modelVersion: 1,
            tables: [
                {
                    id: 'tbl_crmco', key: 'companies', name: 'Companies', icon: 'Building2',
                    fields: [
                        { id: 'fld_crmconame', key: 'name', name: 'Name', type: 'text', required: true },
                        { id: 'fld_crmcoind', key: 'industry', name: 'Industry', type: 'text' },
                        { id: 'fld_crmcoweb', key: 'website', name: 'Website', type: 'text' },
                    ],
                    access: { default: 'app' },
                },
                {
                    id: 'tbl_crmct', key: 'contacts', name: 'Contacts', icon: 'User',
                    fields: [
                        { id: 'fld_crmctname', key: 'name', name: 'Name', type: 'text', required: true },
                        { id: 'fld_crmctmail', key: 'email', name: 'Email', type: 'text' },
                        { id: 'fld_crmctco', key: 'company', name: 'Company', type: 'relation', relation: { table: 'tbl_crmco' } },
                    ],
                    access: { default: 'app' },
                },
                {
                    id: 'tbl_crmdl', key: 'deals', name: 'Deals', icon: 'Handshake',
                    fields: [
                        { id: 'fld_crmdltitle', key: 'title', name: 'Title', type: 'text', required: true },
                        {
                            id: 'fld_crmdlstage', key: 'stage', name: 'Stage', type: 'select',
                            options: [
                                { value: 'lead', label: 'Lead' },
                                { value: 'qualified', label: 'Qualified' },
                                { value: 'proposal', label: 'Proposal' },
                                { value: 'won', label: 'Won' },
                                { value: 'lost', label: 'Lost' },
                            ],
                        },
                        { id: 'fld_crmdlamt', key: 'amount', name: 'Amount', type: 'number', subtype: 'integer' },
                        { id: 'fld_crmdlco', key: 'company', name: 'Company', type: 'relation', relation: { table: 'tbl_crmco' } },
                    ],
                    access: { default: 'app' },
                },
            ],
            roles: [],
            roleMapping: { default: 'app', byGroup: {} },
        },
        seed: {
            tbl_crmco: [
                { $id: 'acme', name: 'Acme Corp', industry: 'Manufacturing', website: 'https://acme.example' },
                { $id: 'globex', name: 'Globex', industry: 'Energy', website: 'https://globex.example' },
                { $id: 'initech', name: 'Initech', industry: 'Software', website: 'https://initech.example' },
            ],
            tbl_crmct: [
                { name: 'Jane Doe', email: 'jane@acme.example', company: { $ref: 'acme' } },
                { name: 'John Roe', email: 'john@globex.example', company: { $ref: 'globex' } },
                { name: 'Mia Ng', email: 'mia@initech.example', company: { $ref: 'initech' } },
            ],
            tbl_crmdl: [
                { title: 'Acme renewal', stage: 'qualified', amount: 12000, company: { $ref: 'acme' } },
                { title: 'Globex rollout', stage: 'proposal', amount: 45000, company: { $ref: 'globex' } },
                { title: 'Initech pilot', stage: 'lead', amount: 8000, company: { $ref: 'initech' } },
                { title: 'Acme upsell', stage: 'won', amount: 22000, company: { $ref: 'acme' } },
                { title: 'Globex expansion', stage: 'lost', amount: 15000, company: { $ref: 'globex' } },
            ],
        },
        datasets: [
            {
                id: 'ds_crmstage', name: 'Deals by stage', tableId: 'tbl_crmdl',
                source: { kind: 'table', tableId: 'tbl_crmdl' },
                descriptor: { groupBy: [{ field: 'stage' }], aggregates: [{ fn: 'count' }] },
            },
        ],
        definition: {
            schemaVersion: 2,
            meta: { name: 'CRM pipeline', description: 'Track companies, contacts and deals.', icon: 'Kanban' },
            theme: { primary: '#1D4ED8', ...THEME_DEFAULTS, radius: 'lg' },
            // Identity: the "cloud" B2B-SaaS look — blue, Inter, soft raised
            // cards, full motion — so the sales tool feels like a sales tool.
            design: { preset: 'cloud', font: 'inter', surface: 'soft', motion: 'full', chartPalette: 'brand', logoUrl: null },
            homeScreenId: 'scr_crmpipe',
            roles: [],
            screens: [
                {
                    id: 'scr_crmpipe', name: 'Pipeline', icon: 'Kanban', showInNav: true, maxWidth: 'wide',
                    sections: [
                        {
                            id: 'sec_crmhead', style: { padding: 4, gap: 2, background: 'none' },
                            children: [
                                { id: 'cmp_crmh1', type: 'heading', props: { text: 'Sales pipeline', level: 1, accent: 'bar' }, style: { span: 12 } },
                                {
                                    id: 'cmp_crmfil', type: 'filter_bar',
                                    props: { fields: [{ name: 'q', label: 'Search deals', type: 'search' }] },
                                    style: { span: 12 },
                                },
                            ],
                        },
                        {
                            id: 'sec_crmboard', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                {
                                    id: 'cmp_crmkan', type: 'kanban',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_crmdl', filter: [{ field: 'title', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' } }] },
                                        groupByField: 'stage',
                                        columns: [
                                            { value: 'lead', label: 'Lead', color: 'neutral' },
                                            { value: 'qualified', label: 'Qualified', color: 'info' },
                                            { value: 'proposal', label: 'Proposal', color: 'primary' },
                                            { value: 'won', label: 'Won', color: 'success' },
                                            { value: 'lost', label: 'Lost', color: 'danger' },
                                        ],
                                        titleKey: 'title',
                                        subtitleKey: 'stage',
                                        cardLook: 'raised',
                                    },
                                    style: { span: 12 },
                                    onRowClick: 'act_crmopen',
                                    onCardMove: 'act_crmmove',
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_crmdeal', name: 'Deal', icon: 'Handshake', showInNav: false, maxWidth: 'medium',
                    sections: [
                        {
                            id: 'sec_crmdetail', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_crmback', type: 'button', props: { label: 'Back to pipeline', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 4 }, onClick: 'act_crmback' },
                                {
                                    id: 'cmp_crmrd', type: 'record_detail',
                                    props: {
                                        source: { kind: 'record', tableId: 'tbl_crmdl', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'screen.params.id' } }] },
                                        fields: [
                                            { key: 'title', label: 'Title', format: 'text' },
                                            { key: 'stage', label: 'Stage', format: 'badge' },
                                            { key: 'amount', label: 'Amount', format: 'number' },
                                        ],
                                        columns: 2,
                                    },
                                    style: { span: 12 },
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_crmopen: { kind: 'navigate', screenId: 'scr_crmdeal', params: { id: { kind: 'formula', expr: 'item.id' } } },
                act_crmback: { kind: 'navigate', screenId: 'scr_crmpipe' },
                act_crmmove: {
                    kind: 'sequence',
                    steps: [
                        { kind: 'update_record', tableId: 'tbl_crmdl', recordId: { kind: 'formula', expr: 'item.id' }, values: { stage: { kind: 'formula', expr: 'value' } } },
                        { kind: 'toast', message: 'Deal moved.', tone: 'success' },
                    ],
                },
            },
        },
    },

    // ------------------------------------------------------------------
    // 7. Ticket tracker — intake form (create_record sequence) + status
    //    kanban + a "My tickets" screen scoped to currentUser (Wave 1a).
    // ------------------------------------------------------------------
    {
        id: 'app-ticket-tracker',
        version: 1,
        title: 'Ticket tracker',
        description: 'Log tickets through an intake form, triage them on a status board, and see just your own on a "My tickets" screen. All backed by your own data table.',
        category: 'Data',
        icon: 'Ticket',
        tags: ['tickets', 'support', 'intake', 'kanban'],
        dataModel: {
            modelVersion: 1,
            tables: [
                {
                    // access.default:'app' so the board shows every ticket; the
                    // "My tickets" screen narrows to created_by = currentUser.id
                    // in its records binding (deliberate own-scoping demo).
                    id: 'tbl_tktik', key: 'tickets', name: 'Tickets', icon: 'Ticket',
                    fields: [
                        { id: 'fld_tksubj', key: 'subject', name: 'Subject', type: 'text', required: true },
                        {
                            id: 'fld_tkstat', key: 'status', name: 'Status', type: 'select',
                            options: [
                                { value: 'open', label: 'Open' },
                                { value: 'in_progress', label: 'In progress' },
                                { value: 'done', label: 'Done' },
                            ],
                        },
                        {
                            id: 'fld_tkprio', key: 'priority', name: 'Priority', type: 'select',
                            options: [
                                { value: 'low', label: 'Low' },
                                { value: 'medium', label: 'Medium' },
                                { value: 'high', label: 'High' },
                            ],
                        },
                        { id: 'fld_tkdet', key: 'details', name: 'Details', type: 'text' },
                    ],
                    access: { default: 'app' },
                },
            ],
            roles: [],
            roleMapping: { default: 'app', byGroup: {} },
        },
        seed: {
            tbl_tktik: [
                { subject: 'Laptop will not boot', status: 'open', priority: 'high', details: 'Black screen after update.' },
                { subject: 'VPN keeps dropping', status: 'in_progress', priority: 'medium', details: 'Disconnects every few minutes.' },
                { subject: 'New monitor request', status: 'open', priority: 'low', details: 'Second monitor for the home desk.' },
                { subject: 'Password reset', status: 'done', priority: 'medium', details: 'Reset and confirmed working.' },
                { subject: 'Email quota full', status: 'open', priority: 'high', details: 'Cannot send or receive.' },
            ],
        },
        definition: {
            schemaVersion: 2,
            meta: { name: 'Ticket tracker', description: 'Collect and triage tickets.', icon: 'Ticket' },
            theme: { primary: '#1D4ED8', ...THEME_DEFAULTS },
            homeScreenId: 'scr_tknew',
            roles: [],
            screens: [
                {
                    id: 'scr_tknew', name: 'New ticket', icon: 'Plus', showInNav: true, maxWidth: 'narrow',
                    sections: [
                        {
                            id: 'sec_tknewf', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_tkh1', type: 'heading', props: { text: 'Log a ticket', level: 1 }, style: { span: 12 } },
                                {
                                    id: 'cmp_tkform', type: 'form',
                                    props: { name: 'ticket', submitLabel: 'Create ticket', showReset: false },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    onSubmit: 'act_tksubmit',
                                    children: [
                                        { id: 'cmp_tksubj', type: 'input_text', props: { name: 'subject', label: 'Subject', required: true }, style: { span: 12 } },
                                        {
                                            id: 'cmp_tkprio', type: 'input_select',
                                            props: {
                                                name: 'priority', label: 'Priority',
                                                options: [
                                                    { value: 'low', label: 'Low' },
                                                    { value: 'medium', label: 'Medium' },
                                                    { value: 'high', label: 'High' },
                                                ],
                                            },
                                            style: { span: 6 },
                                        },
                                        { id: 'cmp_tkdet', type: 'input_textarea', props: { name: 'details', label: 'Details', rows: 4 }, style: { span: 12 } },
                                    ],
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_tkboard', name: 'Board', icon: 'Columns3', showInNav: true, maxWidth: 'wide',
                    sections: [
                        {
                            id: 'sec_tkboard', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_tkh2', type: 'heading', props: { text: 'All tickets', level: 1 }, style: { span: 12 } },
                                {
                                    id: 'cmp_tkkan', type: 'kanban',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_tktik' },
                                        groupByField: 'status',
                                        columns: [
                                            { value: 'open', label: 'Open', color: 'info' },
                                            { value: 'in_progress', label: 'In progress', color: 'warning' },
                                            { value: 'done', label: 'Done', color: 'success' },
                                        ],
                                        titleKey: 'subject',
                                        subtitleKey: 'priority',
                                        allowDrag: false,
                                    },
                                    style: { span: 12 },
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_tkmine', name: 'My tickets', icon: 'UserCheck', showInNav: true, maxWidth: 'medium',
                    sections: [
                        {
                            id: 'sec_tkmine', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_tkh3', type: 'heading', props: { text: 'Tickets I raised', level: 1 }, style: { span: 12 } },
                                {
                                    id: 'cmp_tkgrid', type: 'data_grid',
                                    props: {
                                        // Own-scoping demo: only the current viewer's rows.
                                        source: { kind: 'records', tableId: 'tbl_tktik', filter: [{ field: 'created_by', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }], sort: [{ field: 'created_at', dir: 'desc' }] },
                                        columns: [
                                            { key: 'subject', label: 'Subject', format: 'text' },
                                            { key: 'status', label: 'Status', format: 'badge' },
                                            { key: 'priority', label: 'Priority', format: 'badge' },
                                        ],
                                        emptyText: 'You have not raised any tickets yet.',
                                    },
                                    style: { span: 12 },
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_tksubmit: {
                    kind: 'sequence',
                    steps: [
                        {
                            kind: 'create_record', tableId: 'tbl_tktik',
                            values: {
                                subject: { kind: 'formula', expr: 'form.subject' },
                                priority: { kind: 'formula', expr: 'form.priority' },
                                details: { kind: 'formula', expr: 'form.details' },
                                status: { kind: 'static', value: 'open' },
                            },
                        },
                        { kind: 'toast', message: 'Ticket created.', tone: 'success' },
                        { kind: 'navigate', screenId: 'scr_tkboard' },
                    ],
                },
            },
        },
    },

    // ------------------------------------------------------------------
    // 8. Asset inventory — data_grid + record_detail (via navigate params)
    //    + a badge_list coloured by status.
    // ------------------------------------------------------------------
    {
        id: 'app-asset-inventory',
        version: 1,
        title: 'Asset inventory',
        description: 'Keep track of equipment and licenses: browse a searchable grid, see everything at a glance as coloured badges, and open any asset for its full details.',
        category: 'Data',
        icon: 'Boxes',
        tags: ['inventory', 'assets', 'it'],
        dataModel: {
            modelVersion: 1,
            tables: [
                {
                    id: 'tbl_asast', key: 'assets', name: 'Assets', icon: 'Box',
                    fields: [
                        { id: 'fld_asname', key: 'name', name: 'Name', type: 'text', required: true },
                        {
                            id: 'fld_ascat', key: 'category', name: 'Category', type: 'select',
                            options: [
                                { value: 'hardware', label: 'Hardware' },
                                { value: 'software', label: 'Software' },
                                { value: 'furniture', label: 'Furniture' },
                            ],
                        },
                        {
                            id: 'fld_asstat', key: 'status', name: 'Status', type: 'select',
                            options: [
                                { value: 'in_use', label: 'In use' },
                                { value: 'available', label: 'Available' },
                                { value: 'retired', label: 'Retired' },
                            ],
                        },
                        {
                            id: 'fld_astags', key: 'tags', name: 'Tags', type: 'multiselect',
                            options: [
                                { value: 'laptop', label: 'Laptop' },
                                { value: 'monitor', label: 'Monitor' },
                                { value: 'phone', label: 'Phone' },
                                { value: 'desk', label: 'Desk' },
                                { value: 'license', label: 'License' },
                            ],
                        },
                        { id: 'fld_asassign', key: 'assigned_to', name: 'Assigned to', type: 'text' },
                    ],
                    access: { default: 'app' },
                },
            ],
            roles: [],
            roleMapping: { default: 'app', byGroup: {} },
        },
        seed: {
            tbl_asast: [
                { name: 'MacBook Pro 14', category: 'hardware', status: 'in_use', tags: ['laptop'], assigned_to: 'Jane Doe' },
                { name: 'Dell 27" Monitor', category: 'hardware', status: 'available', tags: ['monitor'], assigned_to: '' },
                { name: 'Figma license', category: 'software', status: 'in_use', tags: ['license'], assigned_to: 'Mia Ng' },
                { name: 'Standing desk', category: 'furniture', status: 'available', tags: ['desk'], assigned_to: '' },
                { name: 'iPhone 14', category: 'hardware', status: 'retired', tags: ['phone'], assigned_to: 'John Roe' },
            ],
        },
        definition: {
            schemaVersion: 2,
            meta: { name: 'Asset inventory', description: 'Track equipment and licenses.', icon: 'Boxes' },
            theme: { primary: '#047857', ...THEME_DEFAULTS },
            homeScreenId: 'scr_asinv',
            roles: [],
            screens: [
                {
                    id: 'scr_asinv', name: 'Inventory', icon: 'Boxes', showInNav: true, maxWidth: 'wide',
                    sections: [
                        {
                            id: 'sec_asinv', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_ash1', type: 'heading', props: { text: 'Asset inventory', level: 1 }, style: { span: 12 } },
                                {
                                    id: 'cmp_asgrid', type: 'data_grid',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_asast', sort: [{ field: 'name', dir: 'asc' }] },
                                        columns: [
                                            { key: 'name', label: 'Name', format: 'text' },
                                            { key: 'category', label: 'Category', format: 'badge' },
                                            { key: 'status', label: 'Status', format: 'badge' },
                                            { key: 'assigned_to', label: 'Assigned to', format: 'text' },
                                        ],
                                        searchable: true,
                                    },
                                    style: { span: 12 },
                                    onRowClick: 'act_asopen',
                                },
                                {
                                    id: 'cmp_asbadge', type: 'badge_list',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_asast' },
                                        labelKey: 'name',
                                        colorKey: 'status',
                                        colorMap: [
                                            { value: 'in_use', color: 'info' },
                                            { value: 'available', color: 'success' },
                                            { value: 'retired', color: 'neutral' },
                                        ],
                                    },
                                    style: { span: 12 },
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_asdet', name: 'Asset', icon: 'Box', showInNav: false, maxWidth: 'medium',
                    sections: [
                        {
                            id: 'sec_asdet', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_asback', type: 'button', props: { label: 'Back to inventory', variant: 'ghost', iconLeft: 'ArrowLeft' }, style: { span: 4 }, onClick: 'act_asback' },
                                {
                                    id: 'cmp_asrd', type: 'record_detail',
                                    props: {
                                        source: { kind: 'record', tableId: 'tbl_asast', filter: [{ field: 'id', op: 'eq', value: { kind: 'formula', expr: 'screen.params.id' } }] },
                                        fields: [
                                            { key: 'name', label: 'Name', format: 'text' },
                                            { key: 'category', label: 'Category', format: 'badge' },
                                            { key: 'status', label: 'Status', format: 'badge' },
                                            { key: 'assigned_to', label: 'Assigned to', format: 'text' },
                                        ],
                                        columns: 2,
                                    },
                                    style: { span: 12 },
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_asopen: { kind: 'navigate', screenId: 'scr_asdet', params: { id: { kind: 'formula', expr: 'item.id' } } },
                act_asback: { kind: 'navigate', screenId: 'scr_asinv' },
            },
        },
    },

    // ------------------------------------------------------------------
    // 9. Event planner — a calendar over your own events + an add-event
    //    form (create_record sequence).
    // ------------------------------------------------------------------
    {
        id: 'app-event-planner',
        version: 1,
        title: 'Event planner',
        description: 'Plan team events on a month calendar and add new ones with a simple form. Events live in your own data table, coloured by category.',
        category: 'Data',
        icon: 'CalendarDays',
        tags: ['events', 'calendar', 'planning'],
        dataModel: {
            modelVersion: 1,
            tables: [
                {
                    id: 'tbl_evevt', key: 'events', name: 'Events', icon: 'Calendar',
                    fields: [
                        { id: 'fld_evtitle', key: 'title', name: 'Title', type: 'text', required: true },
                        { id: 'fld_evdate', key: 'date', name: 'Date', type: 'date', required: true },
                        { id: 'fld_evend', key: 'end_date', name: 'End date', type: 'date' },
                        { id: 'fld_evloc', key: 'location', name: 'Location', type: 'text' },
                        {
                            id: 'fld_evcat', key: 'category', name: 'Category', type: 'select',
                            options: [
                                { value: 'meeting', label: 'Meeting' },
                                { value: 'deadline', label: 'Deadline' },
                                { value: 'social', label: 'Social' },
                            ],
                        },
                    ],
                    access: { default: 'app' },
                },
            ],
            roles: [],
            roleMapping: { default: 'app', byGroup: {} },
        },
        seed: {
            tbl_evevt: [
                { title: 'Team standup', date: '2026-07-20', location: 'Room A', category: 'meeting' },
                { title: 'Project deadline', date: '2026-07-25', location: '', category: 'deadline' },
                { title: 'Summer social', date: '2026-07-31', end_date: '2026-07-31', location: 'Rooftop', category: 'social' },
                { title: 'Board review', date: '2026-08-03', location: 'HQ', category: 'meeting' },
            ],
        },
        definition: {
            schemaVersion: 2,
            meta: { name: 'Event planner', description: 'Plan and schedule team events.', icon: 'CalendarDays' },
            theme: { primary: '#B45309', ...THEME_DEFAULTS },
            homeScreenId: 'scr_evcal',
            roles: [],
            screens: [
                {
                    id: 'scr_evcal', name: 'Calendar', icon: 'CalendarDays', showInNav: true, maxWidth: 'wide',
                    sections: [
                        {
                            id: 'sec_evcal', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_evh1', type: 'heading', props: { text: 'Event calendar', level: 1 }, style: { span: 12 } },
                                {
                                    id: 'cmp_evcal', type: 'calendar',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_evevt' },
                                        dateKey: 'date',
                                        endDateKey: 'end_date',
                                        titleKey: 'title',
                                        colorKey: 'category',
                                        view: 'month',
                                    },
                                    style: { span: 12 },
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'scr_evnew', name: 'Add event', icon: 'Plus', showInNav: true, maxWidth: 'narrow',
                    sections: [
                        {
                            id: 'sec_evnew', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                { id: 'cmp_evh2', type: 'heading', props: { text: 'Add an event', level: 1 }, style: { span: 12 } },
                                {
                                    id: 'cmp_evform', type: 'form',
                                    props: { name: 'event', submitLabel: 'Add event', showReset: false },
                                    style: { span: 12, gap: 3, padding: 0 },
                                    onSubmit: 'act_evsubmit',
                                    children: [
                                        { id: 'cmp_evtitle', type: 'input_text', props: { name: 'title', label: 'Title', required: true }, style: { span: 12 } },
                                        { id: 'cmp_evdate', type: 'input_date', props: { name: 'date', label: 'Date', required: true }, style: { span: 6 } },
                                        { id: 'cmp_evloc', type: 'input_text', props: { name: 'location', label: 'Location' }, style: { span: 6 } },
                                        {
                                            id: 'cmp_evcat', type: 'input_select',
                                            props: {
                                                name: 'category', label: 'Category',
                                                options: [
                                                    { value: 'meeting', label: 'Meeting' },
                                                    { value: 'deadline', label: 'Deadline' },
                                                    { value: 'social', label: 'Social' },
                                                ],
                                            },
                                            style: { span: 6 },
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {
                act_evsubmit: {
                    kind: 'sequence',
                    steps: [
                        {
                            kind: 'create_record', tableId: 'tbl_evevt',
                            values: {
                                title: { kind: 'formula', expr: 'form.title' },
                                date: { kind: 'formula', expr: 'form.date' },
                                location: { kind: 'formula', expr: 'form.location' },
                                category: { kind: 'formula', expr: 'form.category' },
                            },
                        },
                        { kind: 'toast', message: 'Event added.', tone: 'success' },
                        { kind: 'navigate', screenId: 'scr_evcal' },
                    ],
                },
            },
        },
    },

    // ------------------------------------------------------------------
    // 10. Team directory — searchable list + filter bar + a record-detail
    //     panel, all over one people table.
    // ------------------------------------------------------------------
    {
        id: 'app-team-directory',
        version: 1,
        title: 'Team directory',
        description: 'A searchable directory of people with a filter bar and a detail panel. Backed by your own people table — no spreadsheet to keep in sync.',
        category: 'Data',
        icon: 'Contact',
        tags: ['directory', 'people', 'hr'],
        dataModel: {
            modelVersion: 1,
            tables: [
                {
                    id: 'tbl_tmppl', key: 'people', name: 'People', icon: 'Users',
                    fields: [
                        { id: 'fld_tmname', key: 'name', name: 'Name', type: 'text', required: true },
                        { id: 'fld_tmrole', key: 'role', name: 'Role', type: 'text' },
                        { id: 'fld_tmmail', key: 'email', name: 'Email', type: 'text' },
                        {
                            id: 'fld_tmdept', key: 'department', name: 'Department', type: 'select',
                            options: [
                                { value: 'engineering', label: 'Engineering' },
                                { value: 'sales', label: 'Sales' },
                                { value: 'design', label: 'Design' },
                                { value: 'ops', label: 'Ops' },
                            ],
                        },
                        { id: 'fld_tmloc', key: 'location', name: 'Location', type: 'text' },
                    ],
                    access: { default: 'app' },
                },
            ],
            roles: [],
            roleMapping: { default: 'app', byGroup: {} },
        },
        seed: {
            tbl_tmppl: [
                { name: 'Jane Doe', role: 'Engineer', email: 'jane@example.com', department: 'engineering', location: 'Amsterdam' },
                { name: 'John Roe', role: 'Account Executive', email: 'john@example.com', department: 'sales', location: 'Berlin' },
                { name: 'Mia Ng', role: 'Product Designer', email: 'mia@example.com', department: 'design', location: 'Lisbon' },
                { name: 'Sam Poe', role: 'Ops Lead', email: 'sam@example.com', department: 'ops', location: 'Dublin' },
                { name: 'Lee Fox', role: 'Engineer', email: 'lee@example.com', department: 'engineering', location: 'Porto' },
            ],
        },
        definition: {
            schemaVersion: 2,
            meta: { name: 'Team directory', description: 'Find people across the team.', icon: 'Contact' },
            theme: { primary: '#0891B2', ...THEME_DEFAULTS },
            homeScreenId: 'scr_tmdir',
            roles: [],
            screens: [
                {
                    id: 'scr_tmdir', name: 'Directory', icon: 'Contact', showInNav: true, maxWidth: 'wide',
                    sections: [
                        {
                            id: 'sec_tmhead', style: { padding: 4, gap: 2, background: 'none' },
                            children: [
                                { id: 'cmp_tmh1', type: 'heading', props: { text: 'Team directory', level: 1 }, style: { span: 12 } },
                                {
                                    id: 'cmp_tmfil', type: 'filter_bar',
                                    props: {
                                        fields: [
                                            { name: 'q', label: 'Search by name', type: 'search' },
                                            {
                                                name: 'dept', label: 'Department', type: 'select',
                                                options: [
                                                    { value: 'engineering', label: 'Engineering' },
                                                    { value: 'sales', label: 'Sales' },
                                                    { value: 'design', label: 'Design' },
                                                    { value: 'ops', label: 'Ops' },
                                                ],
                                            },
                                        ],
                                    },
                                    style: { span: 12 },
                                },
                            ],
                        },
                        {
                            id: 'sec_tmbody', style: { padding: 4, gap: 3, background: 'none' },
                            children: [
                                {
                                    id: 'cmp_tmlist', type: 'list',
                                    props: {
                                        source: { kind: 'records', tableId: 'tbl_tmppl', filter: [{ field: 'name', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.q' } }], sort: [{ field: 'name', dir: 'asc' }] },
                                        titleKey: 'name',
                                        subtitleKey: 'role',
                                        icon: 'User',
                                        emptyText: 'No people match your search.',
                                    },
                                    style: { span: 7 },
                                },
                                {
                                    id: 'cmp_tmrd', type: 'record_detail',
                                    props: {
                                        // A read-only spotlight on the first person (by name).
                                        source: { kind: 'record', tableId: 'tbl_tmppl', sort: [{ field: 'name', dir: 'asc' }] },
                                        fields: [
                                            { key: 'name', label: 'Name', format: 'text' },
                                            { key: 'role', label: 'Role', format: 'text' },
                                            { key: 'email', label: 'Email', format: 'link' },
                                            { key: 'department', label: 'Department', format: 'badge' },
                                            { key: 'location', label: 'Location', format: 'text' },
                                        ],
                                        columns: 1,
                                    },
                                    style: { span: 5 },
                                },
                            ],
                        },
                    ],
                },
            ],
            actions: {},
        },
    },

    // ------------------------------------------------------------------
    // 11. Support desk — the mailbox wave's acceptance test. Lives in its own
    // file: it is the largest template by some way, and keeping it here would
    // push this module past readability.
    // ------------------------------------------------------------------
    require('./templates/appSupportDesk'),

    // ------------------------------------------------------------------
    // 12. Offerte-intake — the support desk's spine (mailbox → grains →
    // reply) pointed at a sales workflow: AI classification, an editable
    // projectlines grid and an in-app portal CSV. Also in its own file.
    // ------------------------------------------------------------------
    require('./templates/appQuoteIntake'),

    // ------------------------------------------------------------------
    // 13. Sprint planning — an ADO/Jira-shaped delivery workspace. The
    // acceptance test for the board wave: a work-item hierarchy in ONE
    // self-referencing table, a rank-ordered backlog, sprints with capacity,
    // and boards whose columns are ROWS IN A TABLE rather than authored props
    // — so a team lead adds a column without opening the builder. Scrum and
    // Kanban are the same components with a different scope, which is what
    // "supports multiple board types" has to mean if it is not to be two
    // copies of one app. Also in its own file.
    // ------------------------------------------------------------------
    require('./templates/appSprintBoard'),

    // ------------------------------------------------------------------
    // 14-20. The COMPLIANCE set.
    //
    // Every template before this one is a business app: forms, tickets, a CRM,
    // a board. All of them are perfectly good, and all of them are things you
    // could also build in a US SaaS. None of them says why this product exists.
    //
    // These six do. Each is a register an EU organisation is either legally
    // obliged to keep or badly needs, and each holds exactly the kind of
    // material nobody should paste into a hosted assistant: the record of what
    // you process and on what basis, the breach you have 72 hours to report,
    // the identity documents behind a subject request, what went into the
    // knowledge base your assistants answer from, and the recording of the
    // meeting where it was all decided. A self-hosted, zero-knowledge workspace
    // is not a nice-to-have for these — it is the only defensible place to put
    // them.
    //
    // They are also the templates that argue for themselves: five of the six
    // need no AI at all, which is the point rather than an omission.
    // ------------------------------------------------------------------
    require('./templates/appAiActRegister'),
    require('./templates/appProcessingRegister'),
    require('./templates/appBreachRegister'),
    require('./templates/appDataSubjectRequests'),
    require('./templates/appKnowledgeGovernance'),
    require('./templates/appMeetingDossier'),
    require('./templates/appBiReports'),

    // ------------------------------------------------------------------
    // 21. Invoice approvals — the approvals wave's acceptance test.
    //
    // Every template above either has no approval in it or fakes one with a
    // form. This one is the real thing: PDF invoices read by ai_extract, and
    // then a `request_approval` step with a `stages` chain — an ordered ladder
    // of named rungs, each with its own approvers and its own rule.
    //
    // It is also the file to read when you want to know WHICH kind of routing
    // to reach for, because it demonstrates both and says why: a `condition`
    // and a `switch` in the action pick between whole ladders (by supplier and
    // by amount band), while `when` conditions on individual stages switch
    // single rungs on and off inside one ladder. The seats are deliberate
    // `replace-me-` placeholders — see the module header.
    // ------------------------------------------------------------------
    require('./templates/appInvoiceApprovals'),
];

/**
 * A template's version — an integer authors bump when they ship a changed
 * definition/data side. Missing or invalid counts as 1 EVERYWHERE (older
 * template modules simply don't carry the field), so version maths never
 * sees undefined. The template-upgrade feature (templateUpgrade.js) compares
 * this against the version stamped on an app row at create-from-template time.
 */
function templateVersion(t) {
    const v = t && t.version;
    return (Number.isInteger(v) && v > 0) ? v : 1;
}

function listTemplates() {
    // Gallery view — everything except the heavy fields (definition, dataModel,
    // seed rows and dataset descriptors). The gallery only needs the metadata.
    return TEMPLATES.map(({ definition, dataModel, seed, datasets, ...meta }) => ({ ...meta, version: templateVersion(meta) }));
}

function getTemplate(id) {
    const t = TEMPLATES.find((x) => x.id === id) || null;
    // Shallow copy so the normalized version never mutates the shared
    // constant; the heavy fields (definition/dataModel/seed) are shared by
    // reference — every consumer already deep-clones before writing.
    return t ? { ...t, version: templateVersion(t) } : null;
}

module.exports = { TEMPLATES, listTemplates, getTemplate, templateVersion };
