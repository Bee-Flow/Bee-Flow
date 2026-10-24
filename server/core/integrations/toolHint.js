'use strict';

/**
 * buildToolHint: the human-readable integration line appended to the system
 * prompt for the tools a turn received. Split out of integrationTools.js;
 * moved verbatim.
 *
 * Everything this module needs from the server's large import cycle (stores,
 * entitlements, MCP) is handed in by integrationTools.js through the factory
 * below, so this file adds no member to that cycle (lint:scc-ratchet). Lazy
 * dependencies arrive as getters (`lazy.x()`) and are still loaded on first
 * use; module objects are passed whole, so a test that patches one of their
 * methods reaches this code exactly as before.
 */

const log = require('../../telemetry/log');

function createBuildToolHint({ lazy }) {
    /**
     * Build human-readable integration hints for the system prompt.
     * @param {Array} tools - Tool definitions array
     * @returns {string} Integration hint string to append to system prompt
     */
    async function buildToolHint(tools, _userId = null) {
        if (tools.length === 0) return '';

        const integrations = [];
        if (tools.some(t => t.function.name.startsWith('gmail_'))) integrations.push('Gmail (search, read, compose, send, and reply to emails — the user approves before anything is sent)');
        if (tools.some(t => t.function.name.startsWith('calendar_'))) integrations.push('Google Calendar (list, search, create, update, delete events)');
        if (tools.some(t => t.function.name.startsWith('drive_'))) integrations.push('Google Drive (search, list, manage files and folders)');
        if (tools.some(t => t.function.name.startsWith('docs_'))) integrations.push('Google Docs (create, read, append, replace text in documents)');
        if (tools.some(t => t.function.name.startsWith('contacts_'))) integrations.push('Google Contacts (search, list, create, update contacts — create/update require user approval)');
        if (tools.some(t => t.function.name.startsWith('keep_'))) integrations.push('Google Keep (list, get, create, delete notes — create/delete require user approval, enterprise Workspace only)');
        if (tools.some(t => t.function.name.startsWith('groups_'))) integrations.push('Google Groups (list conversations in a group, read full conversation threads, reply to group conversations — replies require user approval before sending)');
        if (tools.some(t => t.function.name.startsWith('youtrack_'))) integrations.push('YouTrack (search, create, update & link issues, read comments, find users, change assignee, log work, manage tags — always search for an existing issue before creating one)');
        if (tools.some(t => t.function.name.startsWith('afas_'))) integrations.push('AFAS Profit (discover GetConnectors with afas_list_connectors, inspect fields with afas_describe_connector, then read data with afas_query; read-only)');
        if (tools.some(t => t.function.name.startsWith('nmbrs_'))) integrations.push('NMBRS payroll/HR (read-only: list debtors → companies → employees with nmbrs_list_*, then read an employee\'s contracts, salaries, wage components and payslips)');
        if (tools.some(t => t.function.name.startsWith('vplan_'))) integrations.push('vPlan (read-only planning: start with vplan_list_boards for board/stage/status/label IDs, then vplan_list_cards, vplan_list_collections, vplan_get_capacity, vplan_get_resource_availability and vplan_time_tracking_summary)');
        if (tools.some(t => t.function.name.startsWith('scaleway_'))) integrations.push('Scaleway Billing (read-only invoices: scaleway_list_invoices lists them per billing period; inside an automation, scaleway_download_invoice fetches the PDF and returns a sourceHandle to pass to nextcloud_upload_file or drive_upload_file)');
        if (tools.some(t => t.function.name.startsWith('signrequest_'))) integrations.push('SignRequest (send documents for e-signature, check signing status, list documents, cancel requests)');
        if (tools.some(t => t.function.name.startsWith('fireflies_'))) integrations.push('Fireflies (meeting transcripts)');
        if (tools.some(t => t.function.name.startsWith('gamma_'))) integrations.push('Gamma (create presentations/documents/webpages/social posts, generate from templates using gammaId or a pasted gamma.app/docs URL, poll generation status, list themes/folders; create tools start asynchronous jobs and return generationId first, then use gamma_get_generation_status to retrieve gammaUrl/exportUrl; existing Gammas cannot be read by URL or edited in place via the public API. If the user asks to create/remix a new Gamma from a URL, call gamma_create_from_template instead of saying the URL cannot be used)');
        if (tools.some(t => t.function.name.startsWith('n8n_run_'))) {
            const n8nNames = tools.filter(t => t.function.name.startsWith('n8n_run_')).map(t => t.function.description || t.function.name);
            integrations.push(`n8n Workflows (${n8nNames.join(', ')})`);
        }
        if (tools.some(t => t.function.name.startsWith('n8n_workflow_') || t.function.name.startsWith('n8n_execution_'))) {
            const hasWrite = tools.some(t => ['n8n_workflow_create','n8n_workflow_update','n8n_workflow_patch','n8n_workflow_delete','n8n_workflow_execute','n8n_workflow_activate','n8n_workflow_deactivate'].includes(t.function.name));
            if (hasWrite) {
                integrations.push(
                    'n8n Workflow Management (list, get, nodes_find, create, patch, activate, execute, debug executions). RULES: '
                    + '(1) ALWAYS call n8n_workflow_list first to discover IDs — never guess a workflow_id. '
                    + '(2) For targeted edits use n8n_workflow_patch with node_operations {action,node_name,node_data} — NOT wholesale update. '
                    + '(3) For searching nodes use n8n_workflow_nodes_find instead of pulling the full workflow. '
                    + '(4) nodes/connections/parameters are real JSON arrays/objects, never stringified. '
                    + '(5) Do NOT send `settings` in a patch unless explicitly changing one — the server preserves/sanitises existing settings automatically. '
                    + '(6) To add documentation to the canvas, use sticky notes: type "n8n-nodes-base.stickyNote" with parameters.content — no connections needed. '
                    + '(7) Always confirm with the user before n8n_workflow_delete or n8n_workflow_activate. '
                    + '(8) On failure, debug via n8n_execution_list → n8n_execution_get_detail for per-node errors.'
                );
            } else {
                integrations.push('n8n Workflow Inspection (list, get, nodes_find, execution_list, execution_get_detail — read-only). To modify workflows you need the "Modify n8n Workflows" permission.');
            }
        }
        if (tools.some(t => t.function.name === 'generate_image')) integrations.push('Image generation');
        if (tools.some(t => t.function.name === 'create_presentation')) integrations.push('Presentations (create_presentation builds a real .pptx deck and returns a download link you must put in your reply; nextcloud_create_presentation saves it into Nextcloud so it opens in Nextcloud Office; with oneDrivePath it is also saved into OneDrive)');
        if (tools.some(t => t.function.name === 'create_word_document')) integrations.push('Word documents (create_word_document builds a real, editable .docx in the organisation\'s Word house style and returns a download link you must put in your reply; with oneDrivePath or nextcloudPath it is saved there instead)');
        if (tools.some(t => t.function.name === 'create_spreadsheet')) integrations.push('Spreadsheets (create_spreadsheet builds a real .xlsx workbook with one or more sheets and returns a download link you must put in your reply; also use it to hand back an uploaded spreadsheet with the requested changes; with oneDrivePath or nextcloudPath it is saved there instead)');
        if (tools.some(t => t.function.name === 'generate_music')) integrations.push('Music generation (instrumental AI music via Lyria)');
        if (tools.some(t => t.function.name === 'generate_video')) integrations.push('Video generation (short AI video clips via Veo 3.1 — takes 1-3 minutes)');
        if (tools.some(t => t.function.name === 'agent_search')) integrations.push('Agent Search (AI-powered web search with reranking)');
        if (tools.some(t => t.function.name === 'browse_web')) integrations.push('Browse Web (open and read/interact with live web pages in a real headless browser — navigate, click, type, follow links across pages. Use it for interactive or JS-rendered pages, logins and PDFs. For a plain page the user gave a URL for, read_url is lighter — do NOT use agent_search for a known URL; agent_search is only for discovering pages when you have no URL)');
        if (tools.some(t => t.function.name === 'read_url')) integrations.push('Read URL (read_url fetches the full text of a web page by URL; use its `find` parameter to pull the passages around a specific article, paragraph number or phrase from a long page. Use it whenever the user\'s message contains a URL, before answering — never answer from search snippets instead)');
        if (tools.some(t => t.function.name.startsWith('workspace_') || t.function.name.startsWith('notebook_'))) integrations.push('Notebook (read and write a persistent rich-text document alongside the conversation)');
        if (tools.some(t => t.function.name === 'kb_search')) integrations.push('Knowledge Base Search (look up internal documentation when the user asks a specific question — do NOT search for greetings or small-talk)');
        if (tools.some(t => t.function.name.startsWith('maps_'))) integrations.push('Google Maps (get directions between locations with route maps, search for places/businesses — IMPORTANT: after getting results, always output the map as a ```map-embed code block containing JSON with embedUrl, title, and mapsLink fields so it renders as an interactive map in the chat)');
        if (tools.some(t => t.function.name.startsWith('linkedin_'))) integrations.push('LinkedIn (create posts — user approves before publishing)');
        if (tools.some(t => t.function.name.startsWith('github_'))) integrations.push('GitHub (list repos, view code, create repos, manage branches)');
        if (tools.some(t => t.function.name.startsWith('outlook_'))) {
            // Check if compose tool is present — if not, it's read-only mode
            const hasCompose = tools.some(t => t.function.name === 'outlook_compose');
            if (hasCompose) {
                integrations.push('Outlook Mail (search, list recent, read, compose, send, and reply to emails — the user approves before anything is sent)');
            } else {
                integrations.push('Outlook Mail (search, list recent, and read emails only — read-only access, no sending capability)');
            }
        }
        if (tools.some(t => t.function.name.startsWith('ms_calendar_'))) integrations.push('Microsoft Calendar (list, search, create, update, delete events — create/update/delete require user approval)');
        if (tools.some(t => t.function.name.startsWith('onedrive_'))) integrations.push('OneDrive (search, list, manage files and folders)');
        if (tools.some(t => t.function.name.startsWith('ms_contacts_'))) integrations.push('Microsoft Contacts (search, list, create, update contacts — create/update require user approval)');
        if (tools.some(t => t.function.name === 'transcribe_audio')) integrations.push('Meeting Transcription (transcribe uploaded audio files with speaker diarization using Voxtral AI — supports up to 3 hours of audio, Dutch and other languages)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_calendar_'))) integrations.push('Nextcloud Calendar (list calendars, list/search/get events, create/update/delete events via CalDAV — create/update/delete require user approval)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_contacts_'))) integrations.push('Nextcloud Contacts (list address books, list/search/get contacts, create/update/delete contacts via CardDAV — create/update/delete require user approval)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_deck_'))) integrations.push('Nextcloud Deck (list boards/stacks/cards, search cards, create/update/move/archive/delete cards, manage labels, add comments — create/update/move require user approval, delete always requires confirmation)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_notifications_'))) integrations.push('Nextcloud Notifications (list pending notifications, dismiss one or all — dismiss-all always requires user confirmation)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_talk_'))) integrations.push('Nextcloud Talk (list conversations, list/search messages, post messages with optional reply, react with emoji, mark rooms read, create rooms — sending messages always requires user approval, deletion always requires confirmation)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_tasks_'))) integrations.push('Nextcloud Tasks (VTODO via CalDAV — list lists, list/search/get tasks, create, update, mark complete/incomplete, delete — create/update require user approval, delete always requires confirmation)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_notes_'))) integrations.push('Nextcloud Notes (list/search/get notes, create/update/delete notes, list categories — create/update require user approval, delete always requires confirmation)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_activity_'))) integrations.push('Nextcloud Activity (read-only feed of recent file changes, shares, comments, mentions, calendar invites — useful for "what happened recently?" questions)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud User Status (get / set / clear the user\'s availability and custom message — setting status requires user approval, except when auto-deriving from a calendar event the user explicitly asked about)');
        if (tools.some(t => t.function.name.startsWith('nextcloud_') && !t.function.name.startsWith('nextcloud_calendar_') && !t.function.name.startsWith('nextcloud_contacts_') && !t.function.name.startsWith('nextcloud_deck_') && !t.function.name.startsWith('nextcloud_notifications_') && !t.function.name.startsWith('nextcloud_talk_') && !t.function.name.startsWith('nextcloud_tasks_') && !t.function.name.startsWith('nextcloud_notes_') && !t.function.name.startsWith('nextcloud_activity_') && !t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud Files (list/search/read/upload/delete files, create folders, share with public links / users / groups / email, manage shares, file comments, system tags, trash bin recovery, file version history via WebDAV — destructive ops require user approval, permanent deletes always require confirmation)');

        // MCP (Model Context Protocol) tools — dynamically discovered from connected external servers
        const mcpTools = tools.filter(t => t.function?.name?.startsWith('mcp_'));
        log.info(`[MCP-DEBUG] buildToolHint: ${tools.length} total tools received, ${mcpTools.length} are MCP tools`);
        if (mcpTools.length > 0) {
            // Group by server: mcp_{serverId}_{toolName}
            const serverMap = {};
            for (const t of mcpTools) {
                const parts = t.function.name.split('_');
                // mcp_{serverId}_{rest...} — server ID is the second segment
                const serverId = parts[1] || 'unknown';
                if (!serverMap[serverId]) serverMap[serverId] = [];
                serverMap[serverId].push(t.function.description || t.function.name);
            }
            log.info(`[MCP-DEBUG] buildToolHint: MCP servers found: ${Object.keys(serverMap).join(', ')}`);
            for (const [serverId, toolDescs] of Object.entries(serverMap)) {
                const label = serverId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                integrations.push(`${label} via MCP (${toolDescs.length} tools: ${toolDescs.slice(0, 5).join(', ')}${toolDescs.length > 5 ? `, ... and ${toolDescs.length - 5} more` : ''})`);
            }
        }

        // Custom org integrations (AI Integration Builder) — cint_<slug>_<tool>.
        // Cheap by construction: skipped entirely when no cint_ tools made it into
        // the list, one getBySlug lookup per distinct integration otherwise.
        // Fail-soft: a store hiccup only costs the hint line, never the tools.
        const cintTools = tools.filter(t => t.function?.name?.startsWith('cint_'));
        if (cintTools.length > 0) {
            try {
                const { parsePrefixedName } = lazy.customIntegrationRunner();
                const orgCustomIntegrationStore = lazy.orgCustomIntegrationStore();
                const bySlug = new Map();
                for (const t of cintTools) {
                    const parsed = parsePrefixedName(t.function.name);
                    if (!parsed) continue;
                    if (!bySlug.has(parsed.slug)) bySlug.set(parsed.slug, []);
                    bySlug.get(parsed.slug).push(t.function.name);
                }
                for (const [slug, toolNames] of bySlug) {
                    const row = await orgCustomIntegrationStore.getBySlug(slug);
                    if (!row || !row.name) continue;
                    integrations.push(`${row.name} (custom org integration: ${toolNames.join(', ')})`);
                }
            } catch (err) { log.debug('fail soft — hint only, the tools themselves still work', err); }
        }

        let hint = ' You have access to tools — use them when they would help answer the user\'s question. You can call multiple tools in parallel when appropriate.';
        if (integrations.length > 0) {
            hint += ` Your available integrations: ${integrations.join(', ')}.`;
        }
        log.info(`[MCP-DEBUG] buildToolHint final integrations: [${integrations.join(', ')}]`);

        return hint;
    }

    return buildToolHint;
}

module.exports = { createBuildToolHint };
