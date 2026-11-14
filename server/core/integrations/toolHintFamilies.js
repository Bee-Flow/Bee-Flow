// @typecheck strict
'use strict';

/**
 * The integration lines of the tool hint (toolHint.js builds the hint): one
 * entry per family, in the order the hint lists them. An entry matches a
 * tool name prefix (`prefix`, or any of `prefixes`), an exact name (`name`),
 * or a test over the whole list (`test`); its `line` is the text, or a
 * function of the list for the families whose text depends on what is there.
 */

/** @typedef {{ function: { name: string, description?: string } }} HintTool */
/**
 * @typedef {{ prefix?: string, prefixes?: string[], name?: string, test?: (tools: HintTool[]) => boolean,
 *   line: string | ((tools: HintTool[]) => string) }} FamilyLine
 */

/** The n8n tools that change workflows: with one of them the management line carries the rules. */
const N8N_WRITE_TOOLS = ['n8n_workflow_create', 'n8n_workflow_update', 'n8n_workflow_patch', 'n8n_workflow_delete', 'n8n_workflow_execute', 'n8n_workflow_activate', 'n8n_workflow_deactivate'];

/** The Nextcloud families with their own line; any other nextcloud_ tool is Nextcloud Files. */
const NEXTCLOUD_SUB_PREFIXES = ['nextcloud_calendar_', 'nextcloud_contacts_', 'nextcloud_deck_', 'nextcloud_notifications_', 'nextcloud_talk_', 'nextcloud_tasks_', 'nextcloud_notes_', 'nextcloud_activity_', 'nextcloud_status_'];

/** @type {ReadonlyArray<FamilyLine>} */
const FAMILY_LINES = [
    { prefix: 'gmail_', line: 'Gmail (search, read, compose, send, and reply to emails — the user approves before anything is sent)' },
    { prefix: 'calendar_', line: 'Google Calendar (list, search, create, update, delete events)' },
    { prefix: 'drive_', line: 'Google Drive (search, list, manage files and folders)' },
    { prefix: 'docs_', line: 'Google Docs (create, read, append, replace text in documents)' },
    { prefix: 'contacts_', line: 'Google Contacts (search, list, create, update contacts — create/update require user approval)' },
    { prefix: 'keep_', line: 'Google Keep (list, get, create, delete notes — create/delete require user approval, enterprise Workspace only)' },
    { prefix: 'groups_', line: 'Google Groups (list conversations in a group, read full conversation threads, reply to group conversations — replies require user approval before sending)' },
    { prefix: 'youtrack_', line: 'YouTrack (search, create, update & link issues, read comments, find users, change assignee, log work, manage tags — always search for an existing issue before creating one)' },
    { prefix: 'afas_', line: 'AFAS Profit (discover GetConnectors with afas_list_connectors, inspect fields with afas_describe_connector, then read data with afas_query; read-only)' },
    { prefix: 'nmbrs_', line: 'NMBRS payroll/HR (read-only: list debtors → companies → employees with nmbrs_list_*, then read an employee\'s contracts, salaries and wage components per year and period; nmbrs_list_company_* read a whole company in one call; payslips come per payroll run with nmbrs_get_company_run_payslips; long lists are paged with offset/limit and nextOffset)' },
    { prefix: 'vplan_', line: 'vPlan (read-only planning: start with vplan_list_boards for board/stage/status/label IDs, then vplan_list_cards, vplan_list_collections, vplan_get_capacity, vplan_get_resource_availability and vplan_time_tracking_summary)' },
    { prefix: 'firebird_', line: 'Firebird database (read-only SQL: start with firebird_list_tables, then firebird_describe_table, then firebird_query with SELECT only)' },
    { prefix: 'frappe_crm_', line: 'Frappe CRM (leads, deals, contacts, organisations, tasks and notes: list and get records, create and update leads and deals, change their status with names from frappe_crm_list_statuses, add notes, create tasks; no deletes; search with frappe_crm_list_leads before creating a lead)' },
    { prefix: 'scaleway_', line: 'Scaleway Billing (read-only invoices: scaleway_list_invoices lists them per billing period; inside an automation, scaleway_download_invoice fetches the PDF and returns a sourceHandle to pass to nextcloud_upload_file or drive_upload_file)' },
    { prefix: 'signrequest_', line: 'SignRequest (send documents for e-signature, check signing status, list documents, cancel requests)' },
    { prefix: 'fireflies_', line: 'Fireflies (meeting transcripts)' },
    { prefix: 'gamma_', line: 'Gamma (create presentations/documents/webpages/social posts, generate from templates using gammaId or a pasted gamma.app/docs URL, poll generation status, list themes/folders; create tools start asynchronous jobs and return generationId first, then use gamma_get_generation_status to retrieve gammaUrl/exportUrl; existing Gammas cannot be read by URL or edited in place via the public API. If the user asks to create/remix a new Gamma from a URL, call gamma_create_from_template instead of saying the URL cannot be used)' },
    {
        prefix: 'n8n_run_',
        line: (tools) => `n8n Workflows (${tools.filter(t => t.function.name.startsWith('n8n_run_')).map(t => t.function.description || t.function.name).join(', ')})`,
    },
    {
        prefixes: ['n8n_workflow_', 'n8n_execution_'],
        line: (tools) => (tools.some(t => N8N_WRITE_TOOLS.includes(t.function.name))
            ? (
                'n8n Workflow Management (list, get, nodes_find, create, patch, activate, execute, debug executions). RULES: '
                + '(1) ALWAYS call n8n_workflow_list first to discover IDs — never guess a workflow_id. '
                + '(2) For targeted edits use n8n_workflow_patch with node_operations {action,node_name,node_data} — NOT wholesale update. '
                + '(3) For searching nodes use n8n_workflow_nodes_find instead of pulling the full workflow. '
                + '(4) nodes/connections/parameters are real JSON arrays/objects, never stringified. '
                + '(5) Do NOT send `settings` in a patch unless explicitly changing one — the server preserves/sanitises existing settings automatically. '
                + '(6) To add documentation to the canvas, use sticky notes: type "n8n-nodes-base.stickyNote" with parameters.content — no connections needed. '
                + '(7) Always confirm with the user before n8n_workflow_delete or n8n_workflow_activate. '
                + '(8) On failure, debug via n8n_execution_list → n8n_execution_get_detail for per-node errors.'
            )
            : 'n8n Workflow Inspection (list, get, nodes_find, execution_list, execution_get_detail — read-only). To modify workflows you need the "Modify n8n Workflows" permission.'),
    },
    { name: 'generate_image', line: 'Image generation' },
    { name: 'create_presentation', line: 'Presentations (create_presentation builds a real .pptx deck and returns a download link you must put in your reply; nextcloud_create_presentation saves it into Nextcloud so it opens in Nextcloud Office; with oneDrivePath it is also saved into OneDrive)' },
    { name: 'create_word_document', line: 'Word documents (create_word_document builds a real, editable .docx in the organisation\'s Word house style and returns a download link you must put in your reply; with oneDrivePath or nextcloudPath it is saved there instead)' },
    { name: 'create_spreadsheet', line: 'Spreadsheets (create_spreadsheet builds a real .xlsx workbook with one or more sheets and returns a download link you must put in your reply; also use it to hand back an uploaded spreadsheet with the requested changes; with oneDrivePath or nextcloudPath it is saved there instead)' },
    { name: 'generate_music', line: 'Music generation (instrumental AI music via Lyria)' },
    { name: 'generate_video', line: 'Video generation (short AI video clips via Veo 3.1 — takes 1-3 minutes)' },
    { name: 'agent_search', line: 'Agent Search (AI-powered web search with reranking)' },
    { name: 'browse_web', line: 'Browse Web (open and read/interact with live web pages in a real headless browser — navigate, click, type, follow links across pages. Use it for interactive or JS-rendered pages, logins and PDFs. For a plain page the user gave a URL for, read_url is lighter — do NOT use agent_search for a known URL; agent_search is only for discovering pages when you have no URL)' },
    { name: 'read_url', line: 'Read URL (read_url fetches the full text of a web page by URL; use its `find` parameter to pull the passages around a specific article, paragraph number or phrase from a long page. Use it whenever the user\'s message contains a URL, before answering — never answer from search snippets instead)' },
    { prefixes: ['workspace_', 'notebook_'], line: 'Notebook (read and write a persistent rich-text document alongside the conversation)' },
    { name: 'kb_search', line: 'Knowledge Base Search (look up internal documentation when the user asks a specific question — do NOT search for greetings or small-talk)' },
    { name: 'kb_get_original', line: 'Knowledge Base original files (kb_get_original gives the user the uploaded file of a document you found with kb_search, as a download card; not every document has one)' },
    { prefix: 'maps_', line: 'Google Maps (get directions between locations with route maps, search for places/businesses — IMPORTANT: after getting results, always output the map as a ```map-embed code block containing JSON with embedUrl, title, and mapsLink fields so it renders as an interactive map in the chat)' },
    { prefix: 'linkedin_', line: 'LinkedIn (create posts — user approves before publishing)' },
    { prefix: 'github_', line: 'GitHub (list repos, view code, create repos, manage branches)' },
    {
        // Without outlook_compose the mailbox is read-only.
        prefix: 'outlook_',
        line: (tools) => (tools.some(t => t.function.name === 'outlook_compose')
            ? 'Outlook Mail (search, list recent, read, compose, send, and reply to emails — the user approves before anything is sent)'
            : 'Outlook Mail (search, list recent, and read emails only — read-only access, no sending capability)'),
    },
    { prefix: 'ms_calendar_', line: 'Microsoft Calendar (list, search, create, update, delete events — create/update/delete require user approval)' },
    { prefix: 'onedrive_', line: 'OneDrive (search, list, manage files and folders)' },
    { prefix: 'ms_contacts_', line: 'Microsoft Contacts (search, list, create, update contacts — create/update require user approval)' },
    { name: 'transcribe_audio', line: 'Meeting Transcription (transcribe uploaded audio files with speaker diarization using Voxtral AI — supports up to 3 hours of audio, Dutch and other languages)' },
    { prefix: 'nextcloud_calendar_', line: 'Nextcloud Calendar (list calendars, list/search/get events, create/update/delete events via CalDAV — create/update/delete require user approval)' },
    { prefix: 'nextcloud_contacts_', line: 'Nextcloud Contacts (list address books, list/search/get contacts, create/update/delete contacts via CardDAV — create/update/delete require user approval)' },
    { prefix: 'nextcloud_deck_', line: 'Nextcloud Deck (list boards/stacks/cards, search cards, create/update/move/archive/delete cards, manage labels, add comments — create/update/move require user approval, delete always requires confirmation)' },
    { prefix: 'nextcloud_notifications_', line: 'Nextcloud Notifications (list pending notifications, dismiss one or all — dismiss-all always requires user confirmation)' },
    { prefix: 'nextcloud_talk_', line: 'Nextcloud Talk (list conversations, list/search messages, post messages with optional reply, react with emoji, mark rooms read, create rooms — sending messages always requires user approval, deletion always requires confirmation)' },
    { prefix: 'nextcloud_tasks_', line: 'Nextcloud Tasks (VTODO via CalDAV — list lists, list/search/get tasks, create, update, mark complete/incomplete, delete — create/update require user approval, delete always requires confirmation)' },
    { prefix: 'nextcloud_notes_', line: 'Nextcloud Notes (list/search/get notes, create/update/delete notes, list categories — create/update require user approval, delete always requires confirmation)' },
    { prefix: 'nextcloud_activity_', line: 'Nextcloud Activity (read-only feed of recent file changes, shares, comments, mentions, calendar invites — useful for "what happened recently?" questions)' },
    { prefix: 'nextcloud_status_', line: 'Nextcloud User Status (get / set / clear the user\'s availability and custom message — setting status requires user approval, except when auto-deriving from a calendar event the user explicitly asked about)' },
    {
        // Nextcloud Files: a nextcloud_ tool that belongs to none of the families above.
        test: (tools) => tools.some(t => t.function.name.startsWith('nextcloud_') && !NEXTCLOUD_SUB_PREFIXES.some(p => t.function.name.startsWith(p))),
        line: 'Nextcloud Files (list/search/read/upload/delete files, create folders, share with public links / users / groups / email, manage shares, file comments, system tags, trash bin recovery, file version history via WebDAV — destructive ops require user approval, permanent deletes always require confirmation)',
    },
];

/**
 * Does the tool list hold this family?
 * @param {FamilyLine} entry
 * @param {HintTool[]} tools
 */
function familyPresent(entry, tools) {
    if (entry.test) return entry.test(tools);
    if (entry.name !== undefined) return tools.some(t => t.function.name === entry.name);
    const prefixes = entry.prefixes || [/** @type {string} */ (entry.prefix)];
    return tools.some(t => prefixes.some(p => t.function.name.startsWith(p)));
}

/**
 * The line of every family the tool list holds, in table order.
 * @param {HintTool[]} tools
 */
function familyLines(tools) {
    /** @type {string[]} */
    const lines = [];
    for (const entry of FAMILY_LINES) {
        if (!familyPresent(entry, tools)) continue;
        lines.push(typeof entry.line === 'function' ? entry.line(tools) : entry.line);
    }
    return lines;
}

module.exports = { familyLines, FAMILY_LINES };
