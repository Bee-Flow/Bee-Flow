/**
 * storeModules.js — the ordered list of store modules that own schema, and
 * the only place that list lives.
 *
 * Two callers read it and must not drift apart: `migrateDb.js` (the standalone
 * `npm run db:migrate`, which AWAITS every init and exits non-zero on failure)
 * and `boot/storeSchemas.js` (the server, which starts them and keeps serving).
 * migrateDb.registration.test.js holds it complete: a store under stores/ with
 * a CREATE TABLE that is not registered here is a red test.
 *
 * ORDER MATTERS and is documented per entry below — user schema first because
 * half the rest joins or FK-references it, datatableStore after automationStore
 * because the schema-rename migration lives in the latter.
 */

'use strict';

// All store modules that contain database migrations
const STORE_MODULES = [
    // userStore is een facade; het schema (users, groups, orgs, …) woont in
    // user/schema.js en initialiseerde onder de oude runner dus nooit
    // aantoonbaar. Eerst, want half de rest hangt er met FK's of joins aan.
    { name: 'userSchema', file: './stores/user/schema' },
    { name: 'userStore', file: './stores/userStore' },
    { name: 'watcherStateStore', file: './stores/watcherStateStore' },
    { name: 'workflowStore', file: './stores/workflowStore' },
    { name: 'configStore', file: './stores/configStore' },
    // agents / conversations / direct_conversations: agentStore is een facade
    // en initSchema wordt pas bij het eerste datagebruik aangeroepen — onder
    // de oude runner ontbraken deze tabellen dus na een "geslaagde" migratie.
    { name: 'agentSchema', file: './stores/agent/initSchema' },
    { name: 'agentStore', file: './stores/agentStore' },
    { name: 'appStore', file: './stores/appStore' },
    { name: 'memoryStore', file: './stores/memoryStore' },
    { name: 'usageStore', file: './stores/usageStore' },
    { name: 'knowledgeStore', file: './stores/knowledgeStore' },
    { name: 'notificationStore', file: './stores/notificationStore' },
    { name: 'projectStore', file: './stores/projectStore' },
    { name: 'projectPinStore', file: './stores/projectPinStore' },
    { name: 'projectBoardStore', file: './stores/projectBoardStore' },
    // Blueprints captured from a Solution. Owns its own DDL, so a standalone
    // db:migrate must create the table too — otherwise it only appears the
    // first time somebody packages a project.
    { name: 'blueprintStore', file: './stores/blueprintStore' },
    // Per-conversation turn lock (shared threads: one AI run at a time). Owns
    // its own DDL, so a standalone db:migrate must create it too — otherwise the
    // table only appears on first app-side use.
    { name: 'conversationLockStore', file: './stores/conversationLockStore' },
    // Team chats inside a project (project_chats, project_chat_messages,
    // project_chat_reads). FK to projects, so it comes after projectStore; its
    // init also awaits projectStore's, because boot starts every init at once.
    { name: 'projectChatStore', file: './stores/projectChatStore' },
    // Comment threads on project notebooks and documents (project_comment_threads,
    // project_comments). FK to projects, so it comes after projectStore; its init
    // also awaits projectStore's.
    { name: 'projectCommentStore', file: './stores/projectCommentStore' },
    // Real-time co-editing of project notebooks and pages (collab_docs,
    // collab_doc_updates, collab_doc_clients). FK to projects, so it comes
    // after projectStore; its init also awaits projectStore's.
    { name: 'collabDocStore', file: './stores/collabDocStore' },
    // The AI that joins team chats and comment threads by itself: its watch
    // queue, decision log and feedback (project_ai_watch, project_ai_decisions,
    // project_ai_feedback). FK to projects, so after projectStore; its init also
    // awaits projectStore's.
    { name: 'projectAiParticipationStore', file: './stores/projectAiParticipationStore' },
    // Tasks in a project (project_tasks) and each member's colour in it
    // (project_member_colors). FK to projects, so after projectStore; their
    // inits also await projectStore's.
    { name: 'projectTaskStore', file: './stores/projectTaskStore' },
    { name: 'projectMemberColorStore', file: './stores/projectMemberColorStore' },
    { name: 'reminderStore', file: './stores/reminderStore' },
    { name: 'templateStore', file: './stores/templateStore' },
    { name: 'transcriptionStore', file: './stores/transcriptionStore' },
    { name: 'voiceprintStore', file: './stores/voiceprintStore' },
    { name: 'mcpStore', file: './stores/mcpStore' },
    { name: 'iconStore', file: './stores/iconStore' },
    // Studio Documents (studio_documents + studio_document_versions). Owns its
    // own DDL, so a standalone `npm run db:migrate` must create the tables too —
    // otherwise they appear only once the app boots and something requires the
    // store, which is exactly how the first version of this feature shipped.
    { name: 'documentStore', file: './stores/documentStore' },
    { name: 'notebookStore', file: './stores/notebookStore' },
    { name: 'notebookConversationStore', file: './stores/notebookConversationStore' },
    { name: 'aiTaskStore', file: './stores/aiTaskStore' },
    // Owns cowork-2026-08 (cowork_schedules + cowork_runs). Without it here a
    // standalone `npm run db:migrate` never created those tables — they only
    // appeared once the app booted and something required the store.
    { name: 'coworkStore', file: './stores/coworkStore' },
    { name: 'routineCredentialStore', file: './stores/routineCredentialStore' },
    // Bezit integration_activity_log — en integrationCacheStore's
    // scopes-migratie leest die tabel. Zonder deze registratie faalde die
    // migratie hier bij ELKE run, stil (waargenomen in de upgrade-analyse).
    { name: 'integrationActivityStore', file: './stores/integrationActivityStore' },
    // The durable "ask this app only once" cache. Owns its own DDL (via
    // migrations/integration-response-cache-2026-09) and self-inits on load,
    // so a standalone db:migrate brings the table current instead of leaving
    // the first cached answer to create it.
    { name: 'integrationCacheStore', file: './stores/integrationCacheStore' },
    { name: 'integrationConnectionStore', file: './stores/integrationConnectionStore' },
    { name: 'orgCustomIntegrationStore', file: './stores/orgCustomIntegrationStore' },
    { name: 'houseStyleStore', file: './stores/houseStyleStore' },
    { name: 'suggestionScanCache', file: './stores/suggestionScanCache' },
    { name: 'suggestionFeedbackStore', file: './stores/suggestionFeedbackStore' },
    // §WS3.5 — automation-feature stores that own DDL (self-init on load). Without
    // these, a standalone `npm run db:migrate` (CI / pre-deploy) did NOT bring the
    // automation schema current — it only worked because the app self-inits on boot.
    { name: 'automationStore', file: './stores/automationStore' },
    // Org-scoped datatables: the metadata, sharing grants and dependents
    // index. Owns its own DDL, so a standalone db:migrate must create the
    // tables too — otherwise they only appear on first datatable use.
    //
    // MUST stay AFTER automationStore: that store owns the migration ladder,
    // and datatable-schema-rename-2026-09 (which renames every per-tenant
    // Postgres schema) lives in it. Ordered the other way this file would touch
    // datatable rows under the pre-rename names first.
    { name: 'datatableStore', file: './stores/datatableStore' },
    // Platform-module state (core infra, NOT a module store): any built-in
    // module stores declared in the module catalog are appended below. The
    // catalog currently ships none (Security Scan is a downloadable .bfmod that
    // owns its own schema), so today only this core state table is registered.
    { name: 'platformModuleStore', file: './stores/platformModuleStore' },
    // Downloaded remote-module package ledger (per module_id+version staging
    // outcome). Core infra like platformModuleStore — the boot re-verify loop
    // reads it; a standalone db:migrate must create its table too.
    { name: 'platformModulePackageStore', file: './stores/platformModulePackageStore' },
    { name: 'feedbackStore', file: './stores/feedbackStore' },
    { name: 'versionStore', file: './stores/versionStore' },
    // Support studio stores own DDL (threads/messages/audit-log + connected
    // mailboxes incl. the new shared_groups ACL column). Without these a
    // standalone `npm run db:migrate` would not bring the support schema current.
    { name: 'supportStore', file: './stores/supportStore' },
    { name: 'supportInboxStore', file: './stores/supportInboxStore' },
    // App Studio — studio_apps / studio_app_versions (self-init on load).
    { name: 'studioAppStore', file: './stores/studioAppStore' },
    // App Studio v2 DATA ENGINE metadata — studio_app_data_meta / datasets /
    // dataset_cache / members / attachments. FK-depends on studio_apps, so it
    // MUST come after studioAppStore (its initDB awaits studioAppStore.ready).
    { name: 'studioAppDataStore', file: './stores/studioAppDataStore' },
    // Studio Playbooks — phased AI builds (table → routine → fill → app → approvals).
    { name: 'playbookStore', file: './stores/playbookStore' },
    // App Studio LARGE DATASET manifests (multi-GB genome files) — multipart
    // upload state + ingest claims + artifact keys. Own DDL, no FK.
    { name: 'datasetFileStore', file: './stores/datasetFileStore' },

    // ── Door de registratie-sweep gevonden DDL-eigenaren (U1) ────────────
    // Vóór deze sectie bestond geen van deze tabellen na een "geslaagde"
    // `npm run db:migrate`: de no-op-runner verhulde dat 30+ stores nooit
    // geregistreerd waren. migrateDb.registration.test.js houdt de lijst
    // voortaan compleet — een nieuwe store met CREATE TABLE die hier (of in
    // de exempt-lijst dáár) niet staat, is een rode test.
    { name: 'knowledgeBases', file: './stores/knowledgeBases' },      // RAG: knowledge_bases + documents + chunks
    { name: 'kbSources', file: './stores/kbSources' },                // kb_sources (wacht zelf op knowledgeBases)
    { name: 'conversationMessages', file: './stores/agent/conversationMessages' },
    { name: 'skillStore', file: './stores/skillStore' },
    { name: 'skillActivations', file: './stores/skillActivations' },
    { name: 'webpageSchema', file: './stores/webpage/schema' },
    { name: 'webpagePublicShareStore', file: './stores/webpagePublicShareStore' },
    { name: 'terminationStore', file: './stores/terminationStore' },
    { name: 'guardrailEventStore', file: './stores/guardrailEventStore' },
    { name: 'invitationStore', file: './stores/invitationStore' },
    { name: 'orgHealthStore', file: './stores/orgHealthStore' },
    { name: 'piiVaultStore', file: './stores/piiVaultStore' },
    { name: 'piiScanLedgerStore', file: './stores/piiScanLedgerStore' },
    { name: 'ipGeoCacheStore', file: './stores/ipGeoCacheStore' },
    { name: 'githubSyncStore', file: './stores/githubSyncStore' },
    { name: 'gmeetImportStore', file: './stores/gmeetImportStore' },
    // meeting_prefs (M5): de per-vergadering opnamekeuze. Draagt naast zijn
    // DDL ook de eenmalige backfill uit de oude uitsluitlijsten, dus hij hoort
    // NA configStore te staan — die leest hij daarvoor.
    { name: 'meetingPrefsStore', file: './stores/meetingPrefsStore' },
    { name: 'summaryTemplateStore', file: './stores/summaryTemplateStore' },
    { name: 'releaseNotesStore', file: './stores/releaseNotesStore' },
    { name: 'studioAppTemplateStore', file: './stores/studioAppTemplateStore' },
    { name: 'platformModuleInstallStore', file: './stores/platformModuleInstallStore' },
    { name: 'azureServiceUsageStore', file: './stores/azureServiceUsageStore' },
    { name: 'automationUsageStore', file: './stores/automationUsageStore' },
    // Compliance-hub-familie — allemaal al modern (memo + export), alleen nooit geregistreerd.
    { name: 'complianceStore', file: './stores/complianceStore' },
    { name: 'dpiaStore', file: './stores/dpiaStore' },
    { name: 'dsrStore', file: './stores/dsrStore' },
    { name: 'incidentStore', file: './stores/incidentStore' },
    { name: 'riskStore', file: './stores/riskStore' },
    { name: 'soaStore', file: './stores/soaStore' },
    { name: 'ismsDocStore', file: './stores/ismsDocStore' },
    { name: 'isoAuditStore', file: './stores/isoAuditStore' },
    { name: 'isoEvidenceStore', file: './stores/isoEvidenceStore' },
    { name: 'isoObligationStore', file: './stores/isoObligationStore' },
    // Compliance-redesign (sep 2026): AI-Act-beoordelingen, eigen kaders +
    // hun attestaties, en het release-logboek achter PLD-Art9.
    { name: 'aiActAssessmentStore', file: './stores/aiActAssessmentStore' },
    { name: 'customFrameworkStore', file: './stores/customFrameworkStore' },
    // Per-item personal-data signals of project content (content_pii_signals),
    // written by the background scan after a version checkpoint and read by
    // the project compliance checks. No text, no offsets — categories + counts.
    { name: 'contentPiiSignalStore', file: './stores/contentPiiSignalStore' },
    { name: 'platformReleaseStore', file: './stores/platformReleaseStore' },
];

// Platform-module stores (server/modules/catalog.js) — in v1 the tables of
// every AVAILABLE module migrate, imported or not: import/remove toggles
// runtime exposure, never schema, so a later import can't hit a missing-table
// race and a remove keeps its data intact for re-import. Modules flipped to
// available:false (future light builds exclude their code, so their store
// files may not exist) stop migrating; their existing tables/data are simply
// left untouched. Deduped by name against the core list.
function collectStoreModules(log = console) {
    const list = [...STORE_MODULES];
    try {
        const moduleStores = require('./modules/catalog').listModules()
            .filter(m => m.available !== false)
            .flatMap(m => m.storeModules || []);
        const registered = new Set(list.map(s => s.name));
        for (const s of moduleStores) {
            if (registered.has(s.name)) continue;
            registered.add(s.name);
            list.push(s);
        }
    } catch (err) {
        log.error('[migrate] ❌ module catalog load failed:', err.message);
    }
    return list;
}

module.exports = { STORE_MODULES, collectStoreModules };
