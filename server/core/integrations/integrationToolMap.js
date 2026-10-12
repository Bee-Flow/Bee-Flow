/**
 * Integration Tool Map — Maps tool names to their integration metadata.
 *
 * This centralized mapping identifies which tools are "external integrations"
 * and records the server/endpoint they connect to, the data direction,
 * and what categories of data they typically handle.
 *
 * Used by the tool dispatcher in chatStream.js / directChat.js to decide
 * whether a tool call should be logged in the integration_activity_log.
 *
 * ── Auto-Detection ──────────────────────────────────────────────────
 * Any tool whose name prefix matches an INTEGRATION_PREFIX entry is
 * automatically treated as an integration tool — no manual registration
 * needed. The static INTEGRATION_TOOL_MAP provides optional overrides
 * for server endpoints, data categories, and direction.
 * New integrations and MCP servers are detected automatically.
 */

// ── Prefix → Integration metadata (auto-detection) ──────────────────
// When a tool's prefix matches one of these, it's automatically logged
// as an integration tool. New integrations just need a prefix entry here.
const INTEGRATION_PREFIXES = {
    // Google Workspace
    gmail_:         { integration: 'gmail',           label: 'Gmail',               server: 'gmail.googleapis.com' },
    calendar_:      { integration: 'google_calendar', label: 'Google Calendar',     server: 'www.googleapis.com/calendar' },
    drive_:         { integration: 'google_drive',    label: 'Google Drive',        server: 'www.googleapis.com/drive' },
    docs_:          { integration: 'google_docs',     label: 'Google Docs',         server: 'docs.googleapis.com' },
    // sheets_ en slides_ ontbraken hier, en dat had twee gevolgen die allebei
    // de verkeerde kant op wezen: `providerForTool` gaf `null`, waarna de
    // Tools-kaart "Als: Bee Flow — deze app gebruikt geen persoonlijke
    // verbinding" tekende op twee apps die uitsluitend op het Google-token van
    // de draaiende gebruiker werken; en het egress-grootboek sloeg die calls
    // over ("internal tool — nothing left the platform") terwijl er wel degelijk
    // verkeer naar sheets/slides.googleapis.com gaat.
    sheets_:        { integration: 'google_sheets',   label: 'Google Sheets',       server: 'sheets.googleapis.com' },
    slides_:        { integration: 'google_slides',   label: 'Google Slides',       server: 'slides.googleapis.com' },
    contacts_:      { integration: 'google_contacts', label: 'Google Contacts',     server: 'people.googleapis.com' },
    keep_:          { integration: 'google_keep',     label: 'Google Keep',         server: 'keep.googleapis.com' },
    groups_:        { integration: 'google_groups',   label: 'Google Groups',       server: 'www.googleapis.com/groups' },

    // Microsoft 365
    outlook_:       { integration: 'outlook',         label: 'Outlook',             server: 'graph.microsoft.com' },
    ms_calendar_:   { integration: 'ms_calendar',     label: 'Microsoft Calendar',  server: 'graph.microsoft.com' },
    ms_contacts_:   { integration: 'ms_contacts',     label: 'Microsoft Contacts',  server: 'graph.microsoft.com' },
    onedrive_:      { integration: 'onedrive',        label: 'OneDrive',            server: 'graph.microsoft.com' },

    // n8n Workflow Management — server is dynamic (configured per-org)
    n8n_workflow_:  { integration: 'n8n',             label: 'n8n Workflow Management', serverFn: (_args, ctx) => ctx?.n8nUrl || null },

    // Dutch legal open data — anonymous public APIs

    // Third-party SaaS
    fireflies_:     { integration: 'fireflies',       label: 'Fireflies',           server: 'api.fireflies.ai' },
    // YouTrack URL is per-org (Connections settings). Static fallback used to
    // be 'youtrack.cloud' which lied to the dashboard for self-hosted
    // instances; null lets the probe-captured tls_servername be the truth.
    youtrack_:      { integration: 'youtrack',        label: 'YouTrack',            serverFn: (_a, ctx) => ctx?.youtrackUrl || null },
    signrequest_:   { integration: 'signrequest',     label: 'SignRequest',         server: 'api.signrequest.com' },
    gamma_:         { integration: 'gamma',           label: 'Gamma',               server: 'gamma.app' },
    // AFAS host is per-customer ({nr}.rest.afas.online); null lets the
    // probe-captured tls_servername be the truth (same rationale as YouTrack).
    afas_:          { integration: 'afas_profit',     label: 'AFAS Profit',         serverFn: () => null },
    // NMBRS host depends on the API mode (api.nmbrs.nl SOAP / api.nmbrsapp.com
    // REST); null lets the probe-captured tls_servername be the truth.
    nmbrs_:         { integration: 'nmbrs',           label: 'NMBRS',               serverFn: () => null },
    vplan_:         { integration: 'vplan',           label: 'vPlan',               server: 'api.vplan.com' },
    scaleway_:      { integration: 'scaleway-billing', label: 'Scaleway Billing',   server: 'api.scaleway.com' },
    linkedin_:      { integration: 'linkedin',        label: 'LinkedIn',            server: 'api.linkedin.com' },
    withings_:      { integration: 'withings',        label: 'Withings',            server: 'wbsapi.withings.net' },
    github_:        { integration: 'github',          label: 'GitHub',              server: 'api.github.com' },

    // Bundled MCP servers (server/mcpServers/**). Prefix matching runs ahead of
    // the generic mcp_* fallback below, so these log under their own name
    // instead of "MCP: <server>". Tuya's host is the data center the user
    // picked (openapi.tuya{eu,us,cn,in}.com), which the manager does not put in
    // ctx — null lets the probe-captured tls_servername be the truth.
    mcp_tuya_:      { integration: 'tuya',            label: 'Tuya Smart Home',     serverFn: () => null },

    // Media generation — per-tool entries in INTEGRATION_TOOL_MAP carry the real
    // endpoint (api.openai.com/images, api.elevenlabs.io, etc.). The catch-all
    // here only fires for tools missing from the static map; null server keeps
    // the dashboard honest instead of showing a fake hostname.
    generate_:      { integration: 'media_gen',       label: 'Media Generation',    server: null },

    // Search & Maps
    maps_:          { integration: 'maps',            label: 'Google Maps',         server: 'maps.googleapis.com' },
    keyword_planner_: { integration: 'keyword_planner', label: 'Keyword Planner',   server: 'googleads.googleapis.com' },

    // Transcription — Whisper is local unless an explicit URL is configured
    transcribe_:    { integration: 'transcription',   label: 'Transcription',       serverFn: () => process.env.WHISPER_URL || null, isLocal: !process.env.WHISPER_URL },

    // Nextcloud — destination is the user's configured Nextcloud host. Resolved
    // at call time via ctx.nextcloudUrl. is_local left false so the probe can
    // capture the real peer IP (could be on-prem or hosted).
    nextcloud_calendar_:      { integration: 'nextcloud_calendar',      label: 'Nextcloud Calendar',      serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_contacts_:      { integration: 'nextcloud_contacts',      label: 'Nextcloud Contacts',      serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_deck_:          { integration: 'nextcloud_deck',          label: 'Nextcloud Deck',          serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_notifications_: { integration: 'nextcloud_notifications', label: 'Nextcloud Notifications', serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_talk_:          { integration: 'nextcloud_talk',          label: 'Nextcloud Talk',          serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_tasks_:         { integration: 'nextcloud_tasks',         label: 'Nextcloud Tasks',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_notes_:         { integration: 'nextcloud_notes',         label: 'Nextcloud Notes',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_mail_:          { integration: 'nextcloud_mail',          label: 'Nextcloud Mail',          serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_activity_:      { integration: 'nextcloud_activity',      label: 'Nextcloud Activity',      serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_teams_:         { integration: 'nextcloud_teams',         label: 'Nextcloud Teams',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_tables_:        { integration: 'nextcloud_tables',        label: 'Nextcloud Tables',        serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_forms_:         { integration: 'nextcloud_forms',         label: 'Nextcloud Forms',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_status_:        { integration: 'nextcloud_status',        label: 'Nextcloud User Status',   serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
    nextcloud_:               { integration: 'nextcloud',               label: 'Nextcloud Files',         serverFn: (_a, ctx) => ctx?.nextcloudUrl || null },
};

/**
 * A document builder (create_presentation, create_word_document) asked to
 * save into Nextcloud. Same test the dispatcher uses: a non-empty string.
 */
function writesToNextcloud(args) {
    return typeof args?.nextcloudPath === 'string' && args.nextcloudPath.trim() !== '';
}

// ── Static overrides for specific tools ──────────────────────────────
// These provide precise metadata for tools that need custom server endpoints,
// direction, or data categories. Entries here override the prefix-based defaults.
const INTEGRATION_TOOL_MAP = {
    // ── Exact-match tools (no prefix pattern) ────────────────
    agent_search: {
        integration: 'web_search',
        label: 'Web Search',
        serverFn: () => 'api.serper.dev (Google Search)',
        direction: 'sent',
        dataCategories: 'search_query',
    },
    kb_search: {
        integration: 'kb_search',
        label: 'Knowledge Base',
        serverFn: () => null,
        isLocal: true,
        direction: 'received',
        dataCategories: 'search_query, document_content',
    },
    // A .pptx built in-process and kept in Bee Flow's own storage: nothing
    // leaves the building. With `nextcloudPath` the dispatcher writes it into
    // Nextcloud instead, and then it is classed exactly like the nextcloud_
    // family (external, server = the Nextcloud URL): the egress ledger, the
    // org's "Outside tools" PII rules and an automation's external privacy scope
    // all apply to the content that goes there.
    create_presentation: {
        integration: 'presentation_builder',
        label: 'Presentation builder',
        serverFn: (a, ctx) => (writesToNextcloud(a) ? ctx?.nextcloudUrl || null : null),
        isLocal: (a) => !writesToNextcloud(a),
        direction: (a) => (writesToNextcloud(a) ? 'sent' : 'received'),
        dataCategories: 'document_content',
    },
    // Same for a .docx: local when kept in Bee Flow's storage, external (like
    // nextcloud_create_document) when `nextcloudPath` sends it to Nextcloud.
    create_word_document: {
        integration: 'word_document_builder',
        label: 'Word document builder',
        serverFn: (a, ctx) => (writesToNextcloud(a) ? ctx?.nextcloudUrl || null : null),
        isLocal: (a) => !writesToNextcloud(a),
        direction: (a) => (writesToNextcloud(a) ? 'sent' : 'received'),
        dataCategories: 'document_content',
    },
    web_search: {
        integration: 'web_search',
        label: 'Web Search (Tavily)',
        serverFn: () => 'api.tavily.com',
        direction: 'sent',
        dataCategories: 'search_query',
    },

    // ── AFAS Profit (read-only GetConnectors) ────────────────
    // ERP environments hold HR/payroll/finance records — tag the categories
    // explicitly so the egress dashboard and PII scan reflect the sensitivity.
    afas_list_connectors: {
        integration: 'afas_profit',
        label: 'AFAS Profit',
        serverFn: () => null,
        direction: 'received',
        dataCategories: 'erp_business_data',
    },
    afas_describe_connector: {
        integration: 'afas_profit',
        label: 'AFAS Profit',
        serverFn: () => null,
        direction: 'received',
        dataCategories: 'erp_business_data',
    },
    afas_query: {
        integration: 'afas_profit',
        label: 'AFAS Profit',
        serverFn: () => null,
        direction: 'received',
        dataCategories: 'erp_business_data, hr, finance',
    },

    // ── NMBRS (read-only payroll/HR) ─────────────────────────
    // Payroll/HR records are highly sensitive (names, salaries, contracts) —
    // tag the categories so the egress dashboard and PII scan reflect that.
    nmbrs_list_debtors: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr',
    },
    nmbrs_list_companies: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr',
    },
    nmbrs_list_employees: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, pii',
    },
    nmbrs_get_employee: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, pii',
    },
    nmbrs_list_employee_contracts: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, pii',
    },
    nmbrs_list_employee_salaries: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, payroll, pii',
    },
    nmbrs_list_employee_wage_components: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, payroll, pii',
    },
    nmbrs_list_payslips: {
        integration: 'nmbrs', label: 'NMBRS', serverFn: () => null,
        direction: 'received', dataCategories: 'hr, payroll, pii',
    },

    // ── Withings (read-only health) ──────────────────────────
    // Everything Withings returns is health data about an identified person —
    // GDPR Article 9 special category. Tagged explicitly so the egress
    // dashboard shows it as such instead of inheriting the prefix default,
    // which would report it as ordinary third-party SaaS traffic.
    withings_get_measures: {
        integration: 'withings', label: 'Withings', serverFn: () => 'wbsapi.withings.net',
        direction: 'received', dataCategories: 'health, biometric, special_category_pii',
    },
    withings_get_sleep_summary: {
        integration: 'withings', label: 'Withings', serverFn: () => 'wbsapi.withings.net',
        direction: 'received', dataCategories: 'health, biometric, special_category_pii',
    },
    withings_get_activity: {
        integration: 'withings', label: 'Withings', serverFn: () => 'wbsapi.withings.net',
        direction: 'received', dataCategories: 'health, biometric, special_category_pii',
    },

    // ── vPlan (read-only planning) ───────────────────────────
    // Planning data is business data, but a few endpoints carry people: the
    // resource/user lists are named employees, and time tracking ties named
    // people to hours. Tag those separately from the plain planning reads.
    vplan_whoami: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'account_metadata',
    },
    vplan_list_resources: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr, pii',
    },
    vplan_get_resource_availability: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr, absence',
    },
    vplan_list_time_tracking: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr, pii',
    },
    vplan_time_tracking_summary: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, hr',
    },
    vplan_list_master_data: {
        integration: 'vplan', label: 'vPlan', serverFn: () => 'api.vplan.com',
        direction: 'received', dataCategories: 'planning_data, crm, pii',
    },

    // ── Scaleway Billing (read-only invoices) ────────────────
    // Invoices are the organisation's own financial records.
    scaleway_list_invoices: {
        integration: 'scaleway-billing', label: 'Scaleway Billing', serverFn: () => 'api.scaleway.com',
        direction: 'received', dataCategories: 'finance',
    },
    scaleway_download_invoice: {
        integration: 'scaleway-billing', label: 'Scaleway Billing', serverFn: () => 'api.scaleway.com',
        direction: 'received', dataCategories: 'finance, document_content',
    },

    // ── Legacy email tools (generic provider) ────────────────
    send_email: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'sent',
        dataCategories: 'email_content, recipients, subject',
    },
    read_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'received',
        dataCategories: 'email_content, senders, subject',
    },
    search_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'both',
        dataCategories: 'email_content, search_query',
    },

    // ── Legacy calendar/map tools ────────────────────────────
    read_calendar: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'calendar_events, attendees',
    },
    create_calendar_event: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees, location',
    },
    search_maps: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'location_query, coordinates',
    },
    get_directions: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'addresses, coordinates',
    },

    // ── Media gen (precise endpoints) ────────────────────────
    generate_image: {
        integration: 'image_gen',
        label: 'Image Generation',
        serverFn: () => 'api.openai.com/images',
        direction: 'both',
        dataCategories: 'prompt, generated_image',
    },
    generate_video: {
        integration: 'video_gen',
        label: 'Video Generation',
        serverFn: () => 'api.bananadev.com',
        direction: 'both',
        dataCategories: 'prompt, generated_video',
    },
    generate_music: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, generated_audio',
    },
    generate_song: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, lyrics, generated_audio',
    },
    generate_tts: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'text_content, generated_audio',
    },
    generate_sfx: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, generated_audio',
    },

    // ── n8n (dynamic URL) ────────────────────────────────────
    n8n_execute: {
        integration: 'n8n',
        label: 'n8n Workflow',
        serverFn: (args, ctx) => ctx?.n8nUrl || 'n8n-server (configured)',
        direction: 'both',
        dataCategories: 'workflow_payload',
    },
};

// Excluded tools — internal tools that should NOT be logged as integrations
// even if they match a prefix pattern (e.g. regex_* is internal)
const INTERNAL_TOOL_PREFIXES = new Set([
    'regex_',       // Regex generator (internal utility)
    'notebook_',    // Notebook tools (internal workspace)
    'workspace_',   // Workspace tools (internal)
    'set_',         // set_reminder, set_ai_task (internal)
]);

// PII category descriptions for data sovereignty reports
const PII_CATEGORIES = [
    'Person Name', 'Email Address', 'Phone Number', 'Physical Address',
    'Credit Card', 'Bank Account', 'IBAN', 'SSN', 'Passport Number',
    'IP Address', 'URL', "Driver's License", 'EU National ID / BSN',
];

/**
 * Infer data direction from tool name action part.
 * e.g. "gmail_compose" → "sent", "drive_list_files" → "received"
 */
function inferDirection(toolName) {
    const fullAction = toolName.split('_').slice(1).join('_'); // everything after prefix

    // Sending / writing
    if (['compose', 'send', 'create', 'update', 'delete', 'cancel', 'reply', 'append', 'move', 'replace'].some(a => fullAction.includes(a))) {
        return 'sent';
    }
    // Reading / receiving
    if (['read', 'get', 'list', 'search', 'check', 'view'].some(a => fullAction.includes(a))) {
        return 'received';
    }
    return 'both';
}

/**
 * Resolve tool metadata for integration activity logging.
 *
 * Resolution order:
 *   1. Static INTEGRATION_TOOL_MAP (exact tool name match — highest priority)
 *   2. INTEGRATION_PREFIXES (prefix match — auto-detects new tools)
 *   3. MCP tool pattern (mcp__<server>__<tool> or mcp_<server>)
 *   4. n8n dynamic tools (n8n_* prefix)
 *   5. null (not an integration tool — internal tools like set_reminder, notebook_*)
 *
 * @param {string} toolName - The tool_name from the function call
 * @param {object} toolArgs - The arguments passed to the tool
 * @param {object} ctx - Runtime context (n8n URL, MCP config, etc.)
 * @returns {object|null} { integration, label, server, direction, dataCategories } or null
 */
function resolveIntegration(toolName, toolArgs = {}, ctx = {}) {
    if (!toolName) return null;

    // Skip internal tools
    for (const prefix of INTERNAL_TOOL_PREFIXES) {
        if (toolName.startsWith(prefix)) return null;
    }

    // Custom integrations (cint_<slug>_<tool>, the AI Integration Builder).
    // Their host is in the org's stored definition, so only a caller that
    // looked it up — the egress ledger, via ctx.customIntegration — gets an
    // answer. Other callers (connection lending, step contracts) keep the
    // null they always had. The tool-PII class does not read this: it treats
    // every cint_ tool as external itself (orgShield.classifyToolClass).
    if (toolName.startsWith('cint_') && ctx && Object.prototype.hasOwnProperty.call(ctx, 'customIntegration')) {
        const slug = toolName.slice('cint_'.length).split('_')[0] || 'unknown';
        const custom = ctx.customIntegration || null;
        let server = null;
        try { server = custom && custom.baseUrl ? new URL(custom.baseUrl).origin : null; } catch (_) { server = null; }
        return {
            integration: 'custom_integration',
            label: custom && custom.name ? custom.name : `Custom integration (${slug})`,
            server,
            direction: inferDirection(toolName.slice('cint_'.length)),
            dataCategories: 'custom_api_payload',
            isLocal: false,
        };
    }

    // 1. Exact match in static map (highest priority — custom metadata)
    const mapped = INTEGRATION_TOOL_MAP[toolName];
    if (mapped) {
        return {
            integration: mapped.integration,
            label: mapped.label,
            server: typeof mapped.serverFn === 'function' ? mapped.serverFn(toolArgs, ctx) : mapped.serverFn,
            direction: (typeof mapped.direction === 'function' ? mapped.direction(toolArgs || {}, ctx) : mapped.direction) || inferDirection(toolName),
            dataCategories: mapped.dataCategories || 'unknown',
            isLocal: typeof mapped.isLocal === 'function' ? !!mapped.isLocal(toolArgs || {}, ctx) : !!mapped.isLocal,
        };
    }

    // 2. Prefix match (auto-detection for known integration families)
    //    Sort by longest prefix first to match ms_calendar_ before ms_
    const sortedPrefixes = Object.keys(INTEGRATION_PREFIXES).sort((a, b) => b.length - a.length);
    for (const prefix of sortedPrefixes) {
        if (toolName.startsWith(prefix)) {
            const meta = INTEGRATION_PREFIXES[prefix];
            return {
                integration: meta.integration,
                label: meta.label,
                server: typeof meta.serverFn === 'function' ? meta.serverFn(toolArgs, ctx) : (meta.server || null),
                direction: inferDirection(toolName),
                dataCategories: 'auto_detected',
                isLocal: !!meta.isLocal,
            };
        }
    }

    // 3. MCP tool pattern: mcp__<server>__<tool> or mcp_<anything>
    if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) {
        const parts = toolName.split('__');
        const mcpServer = parts[1] || toolName.replace(/^mcp_/, '').split('_')[0] || 'unknown';
        return {
            integration: 'mcp',
            label: `MCP: ${mcpServer}`,
            server: ctx?.mcpEndpoint || `mcp-server://${mcpServer}`,
            direction: 'both',
            dataCategories: 'mcp_payload',
        };
    }

    // 4. n8n dynamic tools (catch-all for any n8n_ prefix not in static map)
    if (toolName.startsWith('n8n_')) {
        return {
            integration: 'n8n',
            label: 'n8n Workflow',
            server: ctx?.n8nUrl || 'n8n-server',
            direction: 'both',
            dataCategories: 'workflow_payload',
        };
    }

    // 5. Not an integration tool
    return null;
}

/**
 * Lightweight regex-based PII scanner for tool output.
 * Runs entirely in-process — no external API calls.
 * Returns a comma-separated string of detected PII categories (CANONICAL ids
 * from core/piiCategories.js), or empty string.
 *
 * Match-then-VERIFY: the old patterns were pure shape checks, and two of them
 * over-reported badly — any 9-digit number was a "BSN" (order numbers, epoch
 * seconds, invoice ids) and almost any digit run was a "Phone Number". Every
 * numeric category now validates its candidates (elfproef / Luhn / octet
 * range / digit-count) before the category is reported. Automation rows fed the
 * same sovereignty dashboards as the GLiNER-scanned chat rows, so the
 * over-reporting skewed the org-wide "PII leaving the building" numbers.
 */

/** Dutch BSN 11-test: (9a+8b+7c+6d+5e+4f+3g+2h−1i) mod 11 === 0, not all zeros. */
function isElfproefValid(digits) {
    if (!/^\d{9}$/.test(digits) || digits === '000000000') return false;
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += Number(digits[i]) * (9 - i);
    sum -= Number(digits[8]);
    return sum % 11 === 0;
}

/** Luhn checksum over a digit string (credit cards are 13–19 digits). */
function isLuhnValid(digits) {
    if (!/^\d{13,19}$/.test(digits)) return false;
    let sum = 0, dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = Number(digits[i]);
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        dbl = !dbl;
    }
    return sum % 10 === 0;
}

const PII_PATTERNS = [
    { category: 'Email', pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
    {
        // Phones must LOOK dialed: an international +CC or a national 0/(0
        // prefix, then 9–15 digits total. Bare digit runs no longer qualify.
        category: 'PhoneNumber',
        pattern: /(?:\+\d{1,3}|\(0\d{0,3}\)|\b0\d)[\d\s\-().]{6,20}\d/g,
        validate: (m) => { const n = (m.match(/\d/g) || []).length; return n >= 9 && n <= 15; },
    },
    { category: 'InternationalBankingAccountNumber', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{8,30}\b/g },
    {
        category: 'CreditCardNumber',
        pattern: /\b(?:\d{4}[\s\-]?){3}\d{1,4}\b/g,
        validate: (m) => isLuhnValid(m.replace(/\D/g, '')),
    },
    {
        category: 'IPAddress',
        pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
        validate: (m) => m.split('.').every(o => Number(o) <= 255),
    },
    {
        category: 'NationalIdentificationNumber',
        pattern: /\b\d{9}\b/g,
        validate: (m) => isElfproefValid(m),
    },
];

function scanOutputForPii(text) {
    if (!text || typeof text !== 'string' || text.length < 5) return '';
    const found = new Set();
    for (const { category, pattern, validate } of PII_PATTERNS) {
        pattern.lastIndex = 0;
        if (!validate) {
            if (pattern.test(text)) found.add(category);
            continue;
        }
        let m;
        while ((m = pattern.exec(text)) !== null) {
            if (validate(m[0])) { found.add(category); break; }
        }
    }
    return [...found].join(',');
}

module.exports = {
    INTEGRATION_TOOL_MAP,
    INTEGRATION_PREFIXES,
    PII_CATEGORIES,
    resolveIntegration,
    scanOutputForPii,
};
