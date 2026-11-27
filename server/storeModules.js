// @typecheck
/**
 * storeModules.js — the ordered list of store modules that own schema.
 *
 * The CORE's stores are listed here (STORE_MODULES); a first-party module's stores are
 * rows of its composition (firstParty/<id>.stores.js, see modules/firstParty/loader.js).
 * collectStoreModules() merges both, sorted by the core's order index
 * (modules/firstParty/order.json "stores"), and is the only list the two callers read:
 * `migrateDb.js` (the standalone `npm run db:migrate`, which AWAITS every init and exits
 * non-zero on failure) and `boot/storeSchemas.js` (the server, which starts them and keeps
 * serving). migrateDb.registration.test.js holds it complete: a store under stores/ with
 * a CREATE TABLE that is not registered is a red test.
 *
 * ORDER MATTERS and is documented per entry below and in the part files — user schema
 * first because half the rest joins or FK-references it, datatableStore after
 * automationStore because the schema-rename migration lives in the latter. The order
 * index holds every name, core and module, at today's position.
 *
 * Tables are never removed: a module that is absent (hidden in core mode, not installed,
 * unavailable in this edition) simply does not run its DDL, and its tables stay as they
 * are; the statement ledger (stores/lib/ddlLedger.js) copes with a store that appears later.
 */

'use strict';

const ORDER = require('./modules/firstParty/order.json');
const { mergeByOrder } = require('./modules/firstParty/compositionMerge');

// All store modules that contain database migrations
const STORE_MODULES = [
    // userStore is a facade; the schema (users, groups, orgs, …) lives in
    // user/schema.js and under the old runner was therefore never
    // demonstrably initialised. First, because half the rest hangs on it with FKs or joins.
    { name: 'userSchema', file: './stores/user/schema' },
    { name: 'userStore', file: './stores/userStore' },
    { name: 'watcherStateStore', file: './stores/watcherStateStore' },
    { name: 'workflowStore', file: './stores/workflowStore' },
    { name: 'configStore', file: './stores/configStore' },
    // agents / conversations / direct_conversations: agentStore is a facade
    // and initSchema is only called at the first data use — under
    // the old runner these tables were therefore missing after a "successful" migration.
    { name: 'agentSchema', file: './stores/agent/initSchema' },
    { name: 'agentStore', file: './stores/agentStore' },
    { name: 'memoryStore', file: './stores/memoryStore' },
    { name: 'usageStore', file: './stores/usageStore' },
    // Time-dated price cards (model_price_catalog) that core/llm/modelCosts rates a call
    // with; its init also loads the in-memory index modelCosts reads.
    { name: 'modelPriceCatalogStore', file: './stores/modelPriceCatalogStore' },
    { name: 'knowledgeStore', file: './stores/knowledgeStore' },
    { name: 'notificationStore', file: './stores/notificationStore' },
    { name: 'projectStore', file: './stores/projectStore' },
    { name: 'projectPinStore', file: './stores/projectPinStore' },
    { name: 'projectBoardStore', file: './stores/projectBoardStore' },
    // Blueprints captured from a Solution. Owns its own DDL, so a standalone
    // db:migrate must create the table too — otherwise it only appears the
    // first time somebody packages a project.
    { name: 'blueprintStore', file: './stores/blueprintStore' },
    // Solution stages (UAT / PRD): solution_stages, solution_deployments and
    // their journal, bindings, variables and part options. Soft references
    // only; after projectStore, whose `projects.stage` / `stage_of` columns
    // its stage rows pair with.
    { name: 'solutionStageStore', file: './stores/solutionStageStore' },
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
    // Sprints in a project (project_sprints); its DDL also adds
    // project_tasks.sprint_id, so it comes after projectTaskStore.
    { name: 'projectSprintStore', file: './stores/projectSprintStore' },
    { name: 'projectMemberColorStore', file: './stores/projectMemberColorStore' },
    { name: 'reminderStore', file: './stores/reminderStore' },
    { name: 'voiceprintStore', file: './stores/voiceprintStore' },
    { name: 'mcpStore', file: './stores/mcpStore' },
    { name: 'iconStore', file: './stores/iconStore' },
    // Studio Documents (studio_documents + studio_document_versions). Owns its
    // own DDL, so a standalone `npm run db:migrate` must create the tables too —
    // otherwise they appear only once the app boots and something requires the
    // store, which is exactly how the first version of this feature shipped.
    { name: 'documentStore', file: './stores/documentStore' },
    // AI / user suggestions on a document, sealed with the document's key
    // (document_suggestions). No FK: the target is a document id, so no order
    // constraint beyond being a store with its own DDL.
    { name: 'documentSuggestionStore', file: './stores/documentSuggestionStore' },
    { name: 'notebookStore', file: './stores/notebookStore' },
    { name: 'notebookConversationStore', file: './stores/notebookConversationStore' },
    { name: 'automationCredentialStore', file: './stores/automationCredentialStore' },
    // Owns integration_activity_log — and integrationCacheStore's
    // scopes migration reads that table. Without this registration that
    // migration failed here on EVERY run, silently (observed in the upgrade analysis).
    { name: 'integrationActivityStore', file: './stores/integrationActivityStore' },
    // The durable "ask this app only once" cache. Owns its own DDL (via
    // migrations/integration-response-cache-2026-09) and self-inits on load,
    // so a standalone db:migrate brings the table current instead of leaving
    // the first cached answer to create it.
    { name: 'integrationCacheStore', file: './stores/integrationCacheStore' },
    { name: 'integrationConnectionStore', file: './stores/integrationConnectionStore' },
    { name: 'houseStyleStore', file: './stores/houseStyleStore' },
    { name: 'suggestionScanCache', file: './stores/suggestionScanCache' },
    { name: 'suggestionFeedbackStore', file: './stores/suggestionFeedbackStore' },
    // Platform-module state (core infra, NOT a module store). A first-party
    // module's stores are rows of its composition (firstParty/<id>.stores.js);
    // Security Scan is a downloadable .bfmod that owns its own schema.
    { name: 'platformModuleStore', file: './stores/platformModuleStore' },
    // Downloaded remote-module package ledger (per module_id+version staging
    // outcome). Core infra like platformModuleStore — the boot re-verify loop
    // reads it; a standalone db:migrate must create its table too.
    { name: 'platformModulePackageStore', file: './stores/platformModulePackageStore' },
    { name: 'feedbackStore', file: './stores/feedbackStore' },
    { name: 'versionStore', file: './stores/versionStore' },

    // ── DDL owners found by the registration sweep (U1) ────────────────
    // Without this section none of these tables exist after a "successful"
    // `npm run db:migrate`: the no-op runner conceals that 30+ stores are never
    // registered. migrateDb.registration.test.js now keeps the list
    // complete — a new store with CREATE TABLE that is not listed here (or in the
    // exempt list there) is a red test.
    { name: 'knowledgeBases', file: './stores/knowledgeBases' },      // RAG: knowledge_bases + documents + chunks
    { name: 'kbSources', file: './stores/kbSources' },                // kb_sources (wacht zelf op knowledgeBases)
    { name: 'conversationMessages', file: './stores/agent/conversationMessages' },
    { name: 'skillStore', file: './stores/skillStore' },
    { name: 'skillActivations', file: './stores/skillActivations' },
    // Named MCP access tokens (mcp_tokens): sha256 of the secret, scopes, per-token IP list.
    { name: 'mcpTokenStore', file: './stores/mcpTokenStore' },
    { name: 'terminationStore', file: './stores/terminationStore' },
    { name: 'guardrailEventStore', file: './stores/guardrailEventStore' },
    { name: 'invitationStore', file: './stores/invitationStore' },
    { name: 'orgHealthStore', file: './stores/orgHealthStore' },
    { name: 'piiVaultStore', file: './stores/piiVaultStore' },
    { name: 'piiScanLedgerStore', file: './stores/piiScanLedgerStore' },
    { name: 'ipGeoCacheStore', file: './stores/ipGeoCacheStore' },
    { name: 'platformModuleInstallStore', file: './stores/platformModuleInstallStore' },
    { name: 'azureServiceUsageStore', file: './stores/azureServiceUsageStore' },
    // Chat signals: weekly/daily counters of how the Privacy Shield handled
    // chat messages (no ids, no text), and the per-person "Don't count my chat
    // turns" objection. Read only through stores/lib/chatSignalSuppression.js.
    { name: 'chatSignalStore', file: './stores/chatSignalStore' },
    { name: 'chatSignalObjectionStore', file: './stores/chatSignalObjectionStore' },
    // Per-item personal-data signals of project content (content_pii_signals),
    // written by the background scan after a version checkpoint and read by
    // the project compliance checks. No text, no offsets — categories + counts.
    { name: 'contentPiiSignalStore', file: './stores/contentPiiSignalStore' },
    { name: 'platformReleaseStore', file: './stores/platformReleaseStore' },
    // Per-user notification channels and per-project mutes
    // (user_notification_prefs, project_notification_mutes). No FKs, so the
    // place in the ladder does not matter.
    { name: 'notificationPrefsStore', file: './stores/notificationPrefsStore' },
];

/**
 * Every store that owns schema: the core's STORE_MODULES and the stores of the loaded
 * first-party modules, in order-index order. A module that is absent contributes nothing.
 * @param {Pick<Console, 'error'>} [log]
 * @returns {{ name: string, file: string }[]}
 */
function collectStoreModules(log = console) {
    /** @type {{ name: string, file: string }[]} */
    let contributed = [];
    try {
        contributed = require('./modules/firstParty/loader').stores();
    } catch (err) {
        log.error('[migrate] ❌ first-party module stores could not be listed:', /** @type {Error} */ (err).message);
    }
    return mergeByOrder(STORE_MODULES, contributed, (s) => s.name, ORDER.stores);
}

module.exports = { STORE_MODULES, collectStoreModules };
