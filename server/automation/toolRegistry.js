/**
 * Tool Registry — maps each app to its TOOLS array module so the catalog
 * endpoint can introspect existing integration tool definitions.
 *
 * `enabledKey` mirrors the keys used by integrationTools.js's isAppOn() check,
 * so the catalog only surfaces apps the user has actually connected/enabled.
 *
 * `availableTo` declares which execution contexts the app's tools may be
 * surfaced in. Phase 1 metadata only — consumers continue to use ad-hoc
 * imports today; later phases switch them to query this metadata via
 * `availableForContext()`. Valid contexts:
 *   - 'agent'           — agent runtime (chat tool-use loop)
 *   - 'routine_step'    — automation step (integration_action)
 *   - 'routine_trigger' — surface as a routine trigger (currently only used
 *                          by the trigger bus; here for future symmetry)
 *
 * The default is `['agent', 'routine_step']` — both contexts. Apps that
 * are currently agent-only (kb-search, agent-search) keep their narrow
 * scope until §16 flips them.
 *
 * `grantsVia` names the app that OWNS this entry's tool names when two entries
 * ship the same ones. `outlook` and `outlook-readonly` load the same module:
 * the same names, on the same credentials, of which the second offers a strict
 * subset. They are two apps to the ORG gate (which flavour is offered) and one
 * subject to the agent grants, because a grant is keyed on a tool name and
 * there is only one `outlook_search`.
 *
 * Without the declaration the attribution index in
 * `core/agentRuntime/toolPolicy.js` handed a shared name to whichever entry
 * came FIRST, so the other owned nothing — and a grant stored on it decided
 * nothing at all, silently, while the picker happily offered it. Declaring it
 * does two things: ownership follows the declaration instead of the order of
 * this list (so swapping two rows can never move where `actAs` is read), and
 * every app that claims a shared name has to allow it before the call runs.
 *
 * ADDING AN ENTRY THAT SHARES TOOL NAMES: point `grantsVia` at the owner. The
 * owner is the entry that offers the full set and declares nothing itself;
 * chains are not allowed and the sharer's names must be a subset of the
 * owner's. `toolRegistry.test.js` fails the moment a shared name has no such
 * declaration — that is the whole point of it being there.
 */
const log = require('../telemetry/log');

const DEFAULT_AVAILABILITY = ['agent', 'routine_step'];

const TOOL_REGISTRY = [
    { app: 'gmail',                   label: 'Gmail',                  module: '../integrations/gmailTools',                arrayName: 'GMAIL_TOOLS',                enabledKey: 'gmail' },
    { app: 'google-calendar',         label: 'Google Calendar',        module: '../integrations/calendarTools',             arrayName: 'CALENDAR_TOOLS',             enabledKey: 'google-calendar' },
    { app: 'google-drive',            label: 'Google Drive',           module: '../integrations/driveTools',                arrayName: 'DRIVE_TOOLS',                enabledKey: 'google-drive' },
    { app: 'google-docs',             label: 'Google Docs',            module: '../integrations/docsTools',                 arrayName: 'DOCS_TOOLS',                 enabledKey: 'google-docs' },
    { app: 'google-sheets',           label: 'Google Sheets',          module: '../integrations/sheetsTools',               arrayName: 'SHEETS_TOOLS',               enabledKey: 'google-sheets' },
    { app: 'google-slides',           label: 'Google Slides',          module: '../integrations/slidesTools',               arrayName: 'SLIDES_TOOLS',               enabledKey: 'google-slides' },
    { app: 'google-contacts',         label: 'Google Contacts',        module: '../integrations/contactsTools',             arrayName: 'CONTACTS_TOOLS',             enabledKey: 'google-contacts' },
    { app: 'google-keep',             label: 'Google Keep',            module: '../integrations/keepTools',                 arrayName: 'KEEP_TOOLS',                 enabledKey: 'google-keep' },
    { app: 'google-groups',           label: 'Google Groups',          module: '../integrations/googleGroupsTools',         arrayName: 'GOOGLE_GROUPS_TOOLS',        enabledKey: 'google-groups' },
    { app: 'fireflies',               label: 'Fireflies',              module: '../integrations/firefliesTools',            arrayName: 'FIREFLIES_TOOLS',            enabledKey: 'fireflies' },
    { app: 'youtrack',                label: 'YouTrack',               module: '../integrations/youtrackTools',             arrayName: 'YOUTRACK_TOOLS',             enabledKey: 'youtrack' },
    { app: 'signrequest',             label: 'SignRequest',            module: '../integrations/signrequestTools',          arrayName: 'SIGNREQUEST_TOOLS',          enabledKey: 'signrequest' },
    { app: 'gamma',                   label: 'Gamma',                  module: '../integrations/gammaTools',                arrayName: 'GAMMA_TOOLS',                enabledKey: 'gamma' },
    { app: 'afas-profit',             label: 'AFAS Profit',            module: '../integrations/afasTools',                 arrayName: 'AFAS_TOOLS',                 enabledKey: 'afas-profit' },
    { app: 'nmbrs',                   label: 'NMBRS',                  module: '../integrations/nmbrsTools',                arrayName: 'NMBRS_TOOLS',                enabledKey: 'nmbrs' },
    { app: 'vplan',                   label: 'vPlan',                  module: '../integrations/vplanTools',                arrayName: 'VPLAN_TOOLS',                enabledKey: 'vplan' },
    { app: 'agent-search',            label: 'Web Search',             module: '../integrations/agentSearchTools',          arrayName: 'AGENT_SEARCH_TOOLS',         enabledKey: 'agent-search',         availableTo: ['agent', 'routine_step'] },
    { app: 'maps',                    label: 'Google Maps',            module: '../integrations/mapsTools',                 arrayName: 'MAPS_TOOLS',                 enabledKey: 'google-maps' },
    { app: 'linkedin',                label: 'LinkedIn',               module: '../integrations/linkedinTools',             arrayName: 'LINKEDIN_TOOLS',             enabledKey: 'linkedin' },
    { app: 'withings',                label: 'Withings',               module: '../integrations/withingsTools',             arrayName: 'WITHINGS_TOOLS',             enabledKey: 'withings' },
    { app: 'github',                  label: 'GitHub',                 module: '../integrations/githubTools',               arrayName: 'GITHUB_TOOLS',               enabledKey: 'github' },
    { app: 'outlook',                 label: 'Outlook',                module: '../integrations/outlookTools',              arrayName: 'OUTLOOK_TOOLS',              enabledKey: 'outlook' },
    { app: 'ms-calendar',             label: 'Microsoft Calendar',     module: '../integrations/msCalendarTools',           arrayName: 'MS_CALENDAR_TOOLS',          enabledKey: 'ms-calendar' },
    { app: 'onedrive',                label: 'OneDrive',               module: '../integrations/oneDriveTools',             arrayName: 'ONEDRIVE_TOOLS',             enabledKey: 'onedrive' },
    { app: 'ms-contacts',             label: 'Microsoft Contacts',     module: '../integrations/msContactsTools',           arrayName: 'MS_CONTACTS_TOOLS',          enabledKey: 'ms-contacts' },
    { app: 'kb-search',               label: 'Knowledge Base',         module: '../integrations/kbSearchTools',             enabledKey: 'kb-search',          arrayName: 'KB_SEARCH_TOOLS',            availableTo: ['agent', 'routine_step'] },
    // Personal memory (first-party, no credentials, org-exempt): a routine
    // reads what its owner told the chat assistant, and writes what it learned
    // back so chat knows it too. See integrations/memoryTools.js.
    { app: 'memory',                  label: 'Memory',                 module: '../integrations/memoryTools',               enabledKey: 'memory',             arrayName: 'MEMORY_TOOLS',               availableTo: ['agent', 'routine_step'] },
    // Routine evolution (routine-only, self-scoped): a routine reads its own run
    // history and proposes/applies changes to its own definition after human
    // approval. See integrations/routineEvolutionTools.js + automation/evolution.js.
    { app: 'routine-evolution',       label: 'Routine evolution',      module: '../integrations/routineEvolutionTools',     arrayName: 'ROUTINE_EVOLUTION_TOOLS',    enabledKey: 'routine-evolution',  availableTo: ['routine_step'] },
    { app: 'kb-ingest',               label: 'Knowledge Base Ingest',  module: '../integrations/kbIngestTools',             enabledKey: 'kb-ingest',          arrayName: 'KB_INGEST_TOOLS',            availableTo: ['routine_step'] },
    { app: 'nextcloud',               label: 'Nextcloud',              module: '../integrations/nextcloudTools',            arrayName: 'NEXTCLOUD_TOOLS',            enabledKey: 'nextcloud' },
    { app: 'nextcloud-calendar',      label: 'Nextcloud Calendar',     module: '../integrations/nextcloudCalendarTools',    arrayName: 'NEXTCLOUD_CALENDAR_TOOLS',   enabledKey: 'nextcloud-calendar' },
    { app: 'nextcloud-contacts',      label: 'Nextcloud Contacts',     module: '../integrations/nextcloudContactsTools',    arrayName: 'NEXTCLOUD_CONTACTS_TOOLS',   enabledKey: 'nextcloud-contacts' },
    { app: 'nextcloud-deck',          label: 'Nextcloud Deck',         module: '../integrations/nextcloudDeckTools',        arrayName: 'NEXTCLOUD_DECK_TOOLS',       enabledKey: 'nextcloud-deck' },
    { app: 'nextcloud-talk',          label: 'Nextcloud Talk',         module: '../integrations/nextcloudTalkTools',        arrayName: 'NEXTCLOUD_TALK_TOOLS',       enabledKey: 'nextcloud-talk' },
    { app: 'nextcloud-tasks',         label: 'Nextcloud Tasks',        module: '../integrations/nextcloudTasksTools',       arrayName: 'NEXTCLOUD_TASKS_TOOLS',      enabledKey: 'nextcloud-tasks' },
    { app: 'nextcloud-notes',         label: 'Nextcloud Notes',        module: '../integrations/nextcloudNotesTools',       arrayName: 'NEXTCLOUD_NOTES_TOOLS',      enabledKey: 'nextcloud-notes' },
    { app: 'nextcloud-mail',          label: 'Nextcloud Mail',         module: '../integrations/nextcloudMailTools',        arrayName: 'NEXTCLOUD_MAIL_TOOLS',       enabledKey: 'nextcloud-mail' },
    { app: 'nextcloud-activity',      label: 'Nextcloud Activity',     module: '../integrations/nextcloudActivityTools',    arrayName: 'NEXTCLOUD_ACTIVITY_TOOLS',   enabledKey: 'nextcloud-activity' },
    { app: 'nextcloud-notifications', label: 'Nextcloud Notifications',module: '../integrations/nextcloudNotificationsTools', arrayName: 'NEXTCLOUD_NOTIFICATIONS_TOOLS', enabledKey: 'nextcloud-notifications' },
    { app: 'nextcloud-tables',        label: 'Nextcloud Tables',       module: '../integrations/nextcloudTablesTools',      arrayName: 'NEXTCLOUD_TABLES_TOOLS',     enabledKey: 'nextcloud-tables' },
    { app: 'nextcloud-forms',         label: 'Nextcloud Forms',        module: '../integrations/nextcloudFormsTools',       arrayName: 'NEXTCLOUD_FORMS_TOOLS',      enabledKey: 'nextcloud-forms' },
    { app: 'nextcloud-teams',         label: 'Nextcloud Teams',        module: '../integrations/nextcloudTeamsTools',       arrayName: 'NEXTCLOUD_TEAMS_TOOLS',      enabledKey: 'nextcloud-teams' },
    { app: 'nextcloud-status',        label: 'Nextcloud Status',       module: '../integrations/nextcloudStatusTools',      arrayName: 'NEXTCLOUD_STATUS_TOOLS',     enabledKey: 'nextcloud-status' },
    { app: 'n8n',                     label: 'n8n',                    module: '../integrations/n8nWorkflowTools',          arrayName: 'N8N_WORKFLOW_TOOLS',         enabledKey: 'n8n' },
    { app: 'webpages',                label: 'Webpages',               module: '../integrations/webpageAutomationTools',    arrayName: 'WEBPAGE_AUTOMATION_TOOLS',   enabledKey: 'webpages' },
    // ── AI-only integrations promoted to first-class automation actions ──
    // Tool dispatchers for these already exist in core/toolDispatcher.js
    // (chat path uses them too); registry entries surface them in the
    // automation catalog so the palette can drag them onto the canvas.
    { app: 'image-gen',               label: 'Image Generation',       module: '../core/tools/imageGenTool',                 arrayName: 'IMAGE_GEN_TOOLS',            enabledKey: 'image-gen' },
    { app: 'video-gen',               label: 'Video Generation',       module: '../core/tools/videoGenTool',                 arrayName: 'VIDEO_GEN_TOOLS',            enabledKey: 'video-gen' },
    { app: 'elevenlabs',              label: 'ElevenLabs',             module: '../core/tools/elevenLabsTools',              arrayName: 'ELEVENLABS_TOOLS',           enabledKey: 'elevenlabs' },
    { app: 'transcription',           label: 'Transcription',          module: '../integrations/transcriptionTools',        arrayName: 'TRANSCRIPTION_TOOLS',        enabledKey: 'transcription' },
    // Dezelfde module, dezelfde credentials, een strikte subset van dezelfde
    // toolnamen als `outlook`. Twee apps voor de org-gate, één grant-subject:
    // zie `grantsVia` in de kop.
    { app: 'outlook-readonly',        label: 'Outlook (read-only)',    module: '../integrations/outlookTools',              arrayName: 'OUTLOOK_READONLY_TOOLS',     enabledKey: 'outlook-readonly',   grantsVia: 'outlook' },
];

/**
 * ── Apps whose tools are injected INLINE, outside TOOL_REGISTRY ──────
 *
 * `core/integrations/integrationTools.js` pushes these onto the stack behind a
 * gate of their own — a docker probe for `browse_web`, the admin flag for the
 * regex rules, a feature flag + entitlement + RBAC for the notebooks — instead
 * of the `isAppOn(app) → addTools(APP_TOOLS)` shape the registry describes.
 *
 * They were therefore in NO list the agent tool picker reads, and in no list
 * `core/agentRuntime/toolPolicy.js` builds its appId↔tool index from. One
 * omission, two halves: the picker could not SHOW `browse_web`, and the
 * runtime waved it through as "no app claims this name" — the hole that exists
 * for `set_reminder` and for MCP/custom tools that carry their own id. An
 * agent curated down to `gmail_search` kept a full browser, silently.
 *
 * They are listed HERE and not in TOOL_REGISTRY because that list answers a
 * different question and three other consumers cut their answer on it:
 * `getUserPermittedApps` ("what may a palette offer"), `appStudio/browseStep.js`
 * and `automation/builderCatalog.js`. Moving a row in would change their
 * meaning; `ALL_TOOL_APPS` below adds one without touching any of it.
 *
 * WHAT BELONGS HERE: an app with a STATIC, named tools array and a stable app
 * id. What does NOT: tools whose names are built per user or per record
 * (`automation_<id>`, a reusable Step, `n8n_run_<slug>`), MCP and custom
 * integrations (they carry their own id on the definition — see
 * `appIdForToolDef`), and `datatable_query` (gated by the reserved
 * `datatables` section, which is its own picker).
 *
 * Two fields exist only for this list:
 *
 *   `grantsRequireEntry`  a curated agent must NAME this app to get its tools.
 *       The registry-wide rule is the opposite ("a missing entry means every
 *       action", so no agent needs a migration), and that rule is sound for an
 *       app the picker has always been able to show: the owner saw it and left
 *       it alone. Nobody was ever shown these, so silence about them is not a
 *       choice to respect. Read by `toolPolicy.isToolAllowed`, mirrored by the
 *       picker via the catalog's `requiresGrant`.
 *   `availability`        why this app can be missing, so the picker can say
 *       something true instead of "not connected for you":
 *         'installation' — the server does not have the backend (no browser
 *                          container, feature switched off);
 *         'permission'   — the caller is not allowed to use it;
 *         'connection'   — the caller has not connected it (the default, and
 *                          what every TOOL_REGISTRY app means).
 *       Het is een LIJST zodra er meer dan één oorzaak is, en dat is hier de
 *       regel in plaats van de uitzondering: `browse_web` zit achter de
 *       docker-probe ÉN achter `isAppOn('browser-fetch')` (org-entitlement),
 *       de notebooks achter een feature-vlag, een entitlement én de
 *       RBAC-permissie `use_notebooks`. Eén oorzaak noemen terwijl er drie
 *       kunnen zijn, is een bewering die niet uit de meting volgt — de kaart
 *       zei "deze installatie heeft hem niet" tegen een collega die alleen
 *       `use_notebooks` mist. Bij meer dan één noemt de kiezer ze allebei.
 */
const INLINE_TOOL_APPS = [
    // Injected at core/integrations/integrationTools.js — behind dockerAvailable().
    { app: 'browser-fetch',   label: 'Browse Web',   module: '../integrations/browserFetchTools',  arrayName: 'BROWSE_WEB_TOOLS',       enabledKey: 'browser-fetch', availableTo: ['agent'], availability: ['installation', 'permission'], grantsRequireEntry: true },
    // Injected behind the notebooks feature flag + entitlement + use_notebooks.
    { app: 'workspace',       label: 'Notebooks',    module: '../integrations/workspaceTools',     arrayName: 'WORKSPACE_TOOLS',        enabledKey: 'workspace',     availableTo: ['agent'], availability: ['installation', 'permission'], grantsRequireEntry: true },
    // Injected for admins only — no enabledKey, so `isAppOn` never sees it.
    { app: 'regex-generator', label: 'Regex Rules',  module: '../integrations/regexGeneratorTools', arrayName: 'REGEX_GENERATOR_TOOLS', enabledKey: null,            availableTo: ['agent'], availability: 'permission',   grantsRequireEntry: true },
    // Injected for every non-simple-mode user — a first-party artefact tool
    // (like create_document), so no enabledKey and no org toggle.
    { app: 'presentations',   label: 'Presentations', module: '../integrations/presentationTools',  arrayName: 'PRESENTATION_TOOLS',     enabledKey: null,            availableTo: ['agent', 'routine_step'], availability: 'installation', grantsRequireEntry: true },
    // The .docx sibling of create_presentation, injected next to it.
    { app: 'word-documents',  label: 'Word documents', module: '../integrations/wordDocumentTools', arrayName: 'WORD_DOCUMENT_TOOLS',    enabledKey: null,            availableTo: ['agent', 'routine_step'], availability: 'installation', grantsRequireEntry: true },
];

/**
 * Every app that owns tool names — the ONE list the agent tool picker
 * (`routes/agents/toolCatalog.js`) and the runtime's attribution index
 * (`core/agentRuntime/toolPolicy.js`) both read.
 *
 * They read the SAME list on purpose: two hand-kept lists is how `browse_web`
 * fell out of both of them, and the one that drifts is the one nobody looks at.
 * Anything that needs the narrower "is this a TOOLS-array module" answer keeps
 * reading TOOL_REGISTRY.
 */
const ALL_TOOL_APPS = TOOL_REGISTRY.concat(INLINE_TOOL_APPS);

/** The entry for an app id, from the combined list. `null` when nothing owns it. */
function appEntryFor(appId) {
    if (typeof appId !== 'string' || !appId) return null;
    return ALL_TOOL_APPS.find(e => e && e.app === appId) || null;
}

/**
 * Load the TOOLS array for an app entry, AND say whether that succeeded.
 *
 * ── WAAROM DIT NAAST `loadTools` STAAT ──────────────────────────────
 * `loadTools` geeft `[]` terug op elke storing en vangt de fout zelf. Dat is
 * goed voor de catalogus-achtige lezers (één app minder in een palet), en het
 * is een STIL FAIL-OPEN voor de rechtenlaag: `core/agentRuntime/toolPolicy.js`
 * bouwt hierop zijn appId↔toolnaam-index en gebruikte "loadTools gooide" als
 * signaal voor een degraded attributie — een signaal dat deze functie nooit
 * afgeeft. Een module die niet laadt leverde dus `byApp.set(app, [])`, de index
 * bleef "gezond", en élke naam van die app werd ONGEATTRIBUEERD: de lezing die
 * voor `set_reminder` bedoeld is, en die elke per-app-grant passeert. Een agent
 * die tot `gmail_search` was versmald kreeg heel Gmail terug op grond van één
 * warn-regel in het log.
 *
 * Daarom geeft dit de storing terug als WAARDE. "Leeg" en "onleesbaar" zijn
 * verschillende antwoorden:
 *   ok: true   de module laadde en `arrayName` was een array (ook een lege);
 *   ok: false  de require gooide, óf `arrayName` bestaat niet / is geen array
 *              (hernoemde export, circulaire require tijdens boot).
 *
 * @returns {{tools: Array, ok: boolean, reason: string|null}}
 */
function loadToolsResult(entry) {
    if (!entry || typeof entry.module !== 'string' || !entry.module) {
        return { tools: [], ok: false, reason: 'no_module' };
    }
    let mod;
    try {
        mod = require(entry.module);
    } catch (e) {
        log.warn(`[toolRegistry] Failed to load ${entry.app} (${entry.module}):`, e.message);
        return { tools: [], ok: false, reason: 'require_failed' };
    }
    const arr = mod ? mod[entry.arrayName] : undefined;
    if (!Array.isArray(arr)) {
        log.warn(`[toolRegistry] ${entry.app} (${entry.module}) has no array export "${entry.arrayName}"`);
        return { tools: [], ok: false, reason: 'no_array' };
    }
    return { tools: arr, ok: true, reason: null };
}

/**
 * Load the TOOLS array for an app entry. Returns [] on failure.
 *
 * Bewust ONVERANDERD in gedrag: de bestaande lezers (`toolNamesForApps`,
 * `findOwnerOfTool`, de catalogus) willen één app minder, niet een exception.
 * Wie het VERSCHIL tussen leeg en onleesbaar nodig heeft, neemt
 * `loadToolsResult` hierboven.
 */
function loadTools(entry) {
    return loadToolsResult(entry).tools;
}

/**
 * Return the set of tool NAMES provided by the given app ids. Used to
 * intersect a broad tool list (e.g. getIntegrationTools output) down to an
 * explicit allow-list of integrations by exact tool name — robust against the
 * underscored-vs-hyphenated integration-id mismatch elsewhere (integrationToolMap
 * uses 'google_calendar'; the catalog + isAppOn use 'google-calendar').
 *
 * @param {string[]} appIds - catalog/enabledKey ids (e.g. ['gmail','google-calendar'])
 * @returns {Set<string>} tool names
 */
function toolNamesForApps(appIds) {
    const wanted = new Set(Array.isArray(appIds) ? appIds : []);
    const names = new Set();
    if (!wanted.size) return names;
    for (const entry of TOOL_REGISTRY) {
        if (!wanted.has(entry.app)) continue;
        for (const t of loadTools(entry)) {
            const n = t?.function?.name;
            if (n) names.add(n);
        }
    }
    return names;
}

/**
 * Find the registry entry that owns a specific tool name.
 * Returns null if no app claims the tool.
 */
function findOwnerOfTool(toolName) {
    for (const entry of TOOL_REGISTRY) {
        const tools = loadTools(entry);
        if (tools.some(t => t?.function?.name === toolName)) return entry;
    }
    return null;
}

/**
 * Return the declared availability for an app — entry-level override
 * if present, otherwise the registry-wide default. Centralised so any
 * future consumer reads one source of truth.
 */
function availabilityFor(entry) {
    if (entry && Array.isArray(entry.availableTo)) return entry.availableTo;
    return DEFAULT_AVAILABILITY;
}

/**
 * Filter the registry to apps that are available in a given execution
 * context. Phase 1 wiring is metadata-only: consumers (agent runtime,
 * automation builder) still import their tools directly today; later
 * phases switch them to this helper so a single edit on the registry
 * row controls whether the tool surfaces in chats vs canvases.
 */
function availableForContext(context) {
    if (!context) return TOOL_REGISTRY.slice();
    return TOOL_REGISTRY.filter(entry => availabilityFor(entry).includes(context));
}

module.exports = {
    TOOL_REGISTRY,
    INLINE_TOOL_APPS,
    ALL_TOOL_APPS,
    appEntryFor,
    DEFAULT_AVAILABILITY,
    loadTools,
    loadToolsResult,
    toolNamesForApps,
    findOwnerOfTool,
    availabilityFor,
    availableForContext,
};
