// @typecheck strict
/**
 * What happens to every table that can name a person when that account is
 * erased. One map, read by deleteUser (it drives the generic steps) and by the
 * footprint test (it must name every user-keyed table the schema has, or the
 * table is on the exemption list next to this file with its reason).
 *
 * The four answers, chosen per table by what the rows ARE:
 *
 *   - `deleted`:    the person's own rows; they go with the account.
 *   - `detached`:   an organisation's or a project's record that merely names
 *                   the person (who created a risk, who authored a support
 *                   reply); the column is cleared, the record stays. The
 *                   column must be nullable — the footprint test checks.
 *   - `reassigned`: the same, where the column is NOT NULL: the record is
 *                   handed to the organisation's oldest remaining admin, the
 *                   way a shared datatable is (usersDelete.oldestOrgAdmin), or
 *                   for a project record to the project's owner.
 *   - `cascade`:    the rows go when their parent goes (a foreign key with
 *                   ON DELETE CASCADE, or a store's own delete that purges the
 *                   bytes outside Postgres). Named here so the test can tell
 *                   "covered through the parent" from "forgotten".
 *
 * Tables erased by the hand-written steps in usersDelete.js are listed as
 * `step` so the map is complete without moving that code.
 */

'use strict';

/**
 * @typedef {{ mode: 'deleted', column: string, detach?: string }
 *   | { mode: 'detached', column: string }
 *   | { mode: 'reassigned', column: string, org: string }
 *   | { mode: 'reassigned', column: string, via: { parent: string, key: string, owner: string } }
 *   | { mode: 'cascade', parent: string }
 *   | { mode: 'step', step: string }} Coverage
 */

/** @type {Readonly<Record<string, Coverage>>} */
const ERASURE_COVERAGE = Object.freeze({
    // ── The hand-written steps in deleteUser ─────────────────────────────
    mcp_tokens: { mode: 'step', step: 'mcp_tokens' },
    notebooks: { mode: 'step', step: 'notebooks' },
    notebook_versions: { mode: 'cascade', parent: 'notebooks' },
    notebook_conversations: { mode: 'step', step: 'notebook_conversations' },
    user_memories: { mode: 'step', step: 'user_memories' },
    pii_vault_entries: { mode: 'step', step: 'pii_vault_entries' },
    pii_vault_counters: { mode: 'step', step: 'pii_vault_counters' },
    agent_conversations: { mode: 'step', step: 'conversations' },
    direct_conversations: { mode: 'step', step: 'conversations' },
    execution_history: { mode: 'step', step: 'execution_history' },
    message_feedback: { mode: 'step', step: 'message_feedback' },
    ai_usage_log: { mode: 'step', step: 'ai_usage_log' },
    chat_signal_objections: { mode: 'step', step: 'chat_signal_objections' },
    suggestion_scan_cache: { mode: 'step', step: 'suggestion traces' },
    automation_suggestion_feedback: { mode: 'step', step: 'suggestion traces' },
    automation_credentials: { mode: 'step', step: 'automation_credentials' },
    integration_response_cache: { mode: 'step', step: 'integration cache' },
    connection_grants: { mode: 'step', step: 'connection_grants' },
    integration_connections: { mode: 'step', step: 'integration_connections' },
    voiceprints: { mode: 'step', step: 'voiceprints' },
    projects: { mode: 'step', step: 'owned projects' },
    project_shares: { mode: 'step', step: 'project_shares' },
    project_chat_messages: { mode: 'step', step: 'project team chat messages' },
    project_comments: { mode: 'step', step: 'project comments' },
    collab_doc_updates: { mode: 'step', step: 'project co-editing log' },
    project_hint_dismissals: { mode: 'step', step: 'project compliance hint dismissals' },
    agents: { mode: 'step', step: 'agents' },
    datatables: { mode: 'step', step: 'datatables' },
    notifications: { mode: 'step', step: 'notifications' },

    // ── The person's own rows ────────────────────────────────────────────
    conversation_labels: { mode: 'deleted', column: 'user_id' },
    agent_favorites: { mode: 'deleted', column: 'user_id' },
    kb_favorites: { mode: 'deleted', column: 'user_id' },
    meeting_prefs: { mode: 'deleted', column: 'user_id' },
    gmeet_import_jobs: { mode: 'deleted', column: 'user_id' },
    teams_import_jobs: { mode: 'deleted', column: 'user_id' },
    reminders: { mode: 'deleted', column: 'user_id' },
    playbooks: { mode: 'deleted', column: 'user_id' },
    ai_tasks: { mode: 'deleted', column: 'user_id' },
    ai_task_termination_log: { mode: 'deleted', column: 'user_id' },
    cowork_schedules: { mode: 'deleted', column: 'user_id' },
    cowork_runs: { mode: 'cascade', parent: 'cowork_schedules' },
    studio_documents: { mode: 'deleted', column: 'user_id' },
    studio_document_versions: { mode: 'cascade', parent: 'studio_documents' },
    studio_document_folders: { mode: 'deleted', column: 'user_id' },
    document_suggestions: { mode: 'deleted', column: 'author_user_id' },
    word_templates: { mode: 'deleted', column: 'user_id' },
    icon_packs: { mode: 'deleted', column: 'user_id' },
    // Personal templates go; an organisation template the person wrote stays and loses its author.
    summary_templates: { mode: 'deleted', column: 'user_id', detach: 'created_by' },
    user_security_keys: { mode: 'deleted', column: 'user_id' },
    user_notification_prefs: { mode: 'deleted', column: 'user_id' },
    consent_acceptances: { mode: 'deleted', column: 'user_id' },
    consumer_subscriptions: { mode: 'deleted', column: 'user_id' },
    azure_sync_memberships: { mode: 'deleted', column: 'user_id' },
    azure_service_usage_log: { mode: 'deleted', column: 'user_id' },
    integration_activity_log: { mode: 'deleted', column: 'user_id' },
    skill_activations: { mode: 'deleted', column: 'user_id' },
    workflows: { mode: 'deleted', column: 'owner_id' },
    folders: { mode: 'deleted', column: 'owner_id' },
    project_chat_reads: { mode: 'deleted', column: 'user_id' },
    project_item_reads: { mode: 'deleted', column: 'user_id' },
    project_member_colors: { mode: 'deleted', column: 'user_id' },
    project_member_state: { mode: 'deleted', column: 'user_id' },
    project_notification_mutes: { mode: 'deleted', column: 'user_id' },
    project_ai_feedback: { mode: 'deleted', column: 'user_id' },
    project_ai_watch: { mode: 'deleted', column: 'author_user_id' },
    collab_doc_clients: { mode: 'deleted', column: 'user_id' },
    // Automations the person made go whole (every child table cascades on the
    // automations FK); what they did on a colleague's automation goes by row.
    automations: { mode: 'deleted', column: 'user_id' },
    automation_runs: { mode: 'deleted', column: 'user_id' },
    automation_approvals: { mode: 'deleted', column: 'owner_id' },
    automation_approval_deliveries: { mode: 'deleted', column: 'user_id' },
    automation_caller_notices: { mode: 'deleted', column: 'user_id' },
    automation_event_subscriptions: { mode: 'deleted', column: 'user_id' },
    automation_evolutions: { mode: 'deleted', column: 'user_id' },
    automation_alert_rules: { mode: 'deleted', column: 'user_id' },
    automation_usage: { mode: 'deleted', column: 'owner_user_id' },
    automation_schedules: { mode: 'cascade', parent: 'automations' },
    webpage_public_shares: { mode: 'deleted', column: 'created_by' },
    studio_app_members: { mode: 'deleted', column: 'user_id' },
    studio_app_attachments: { mode: 'deleted', column: 'owner_user_id' },
    studio_app_connector_sync: { mode: 'deleted', column: 'owner_user_id' },
    studio_app_data_meta: { mode: 'deleted', column: 'owner_user_id' },
    studio_app_datasets: { mode: 'deleted', column: 'owner_user_id' },
    studio_app_dataset_files: { mode: 'deleted', column: 'owner_id' },

    // ── Through the store that also owns the bytes outside Postgres ──────
    transcriptions: { mode: 'step', step: 'transcriptions' },
    webpages: { mode: 'step', step: 'webpages' },
    webpage_versions: { mode: 'cascade', parent: 'webpages' },
    studio_apps: { mode: 'step', step: 'studio apps' },
    studio_app_public_pages: { mode: 'cascade', parent: 'studio_apps' },
    skills: { mode: 'step', step: 'skills' },
    conversation_messages: { mode: 'step', step: 'conversations' },

    // ── Records of the organisation or a project that name the person ───
    guardrail_events: { mode: 'detached', column: 'user_id' },
    license_keys: { mode: 'detached', column: 'user_id' },
    agent_versions: { mode: 'detached', column: 'created_by' },
    documents: { mode: 'detached', column: 'created_by' },
    kb_sources: { mode: 'detached', column: 'created_by' },
    collab_docs: { mode: 'detached', column: 'created_by' },
    support_messages: { mode: 'detached', column: 'author_user_id' },
    support_canned_responses: { mode: 'detached', column: 'created_by' },
    org_house_styles: { mode: 'detached', column: 'created_by' },
    dsr_requests: { mode: 'detached', column: 'created_by' },
    compliance_custom_frameworks: { mode: 'detached', column: 'created_by' },
    compliance_incidents: { mode: 'detached', column: 'created_by' },
    isms_documents: { mode: 'detached', column: 'owner_user_id' },
    iso_audits: { mode: 'detached', column: 'created_by' },
    iso_management_reviews: { mode: 'detached', column: 'created_by' },
    iso_nonconformities: { mode: 'detached', column: 'created_by,owner_user_id' },
    iso_objectives: { mode: 'detached', column: 'created_by,owner_user_id' },
    iso_obligations: { mode: 'detached', column: 'created_by,owner_user_id' },
    iso_risks: { mode: 'detached', column: 'created_by,owner_user_id' },
    iso_risk_treatments: { mode: 'detached', column: 'owner_user_id' },
    iso_soa_entries: { mode: 'detached', column: 'owner_user_id' },
    automation_agent_bindings: { mode: 'detached', column: 'created_by' },
    automation_form_scenarios: { mode: 'detached', column: 'created_by' },
    automation_golden_runs: { mode: 'detached', column: 'created_by' },
    automation_shares: { mode: 'detached', column: 'created_by' },
    automation_test_cases: { mode: 'detached', column: 'created_by' },

    // NOT NULL author columns on organisation records: to the oldest remaining org admin.
    apps: { mode: 'reassigned', column: 'created_by', org: 'organization_id' },
    automation_templates: { mode: 'reassigned', column: 'created_by', org: 'organization_id' },
    studio_app_templates: { mode: 'reassigned', column: 'created_by', org: 'organization_id' },
    project_blueprints: { mode: 'reassigned', column: 'created_by', org: 'organization_id' },
    solution_stages: { mode: 'reassigned', column: 'created_by', org: 'organization_id' },
    support_inboxes: { mode: 'reassigned', column: 'created_by', org: 'organization_id' },
    org_custom_integrations: { mode: 'reassigned', column: 'created_by', org: 'org_id' },
    // (after its parent above, so a version takes the parent's new author)
    org_custom_integration_versions: { mode: 'reassigned', column: 'created_by', via: { parent: 'org_custom_integrations', key: 'integration_id', owner: 'created_by' } },
    // NOT NULL author columns on project records: to the project's owner.
    project_chats: { mode: 'reassigned', column: 'created_by', via: { parent: 'projects', key: 'project_id', owner: 'owner_id' } },
    project_comment_threads: { mode: 'reassigned', column: 'created_by', via: { parent: 'projects', key: 'project_id', owner: 'owner_id' } },
    project_sprints: { mode: 'reassigned', column: 'created_by', via: { parent: 'projects', key: 'project_id', owner: 'owner_id' } },
    project_tasks: { mode: 'reassigned', column: 'created_by', via: { parent: 'projects', key: 'project_id', owner: 'owner_id' } },
    // A version the person saved of a colleague's app: to that app's owner.
    studio_app_versions: { mode: 'reassigned', column: 'user_id', via: { parent: 'studio_apps', key: 'app_id', owner: 'user_id' } },
});

/**
 * The entries of one mode, as `[table, entry]` pairs in map order.
 * @template {Coverage['mode']} M
 * @param {M} mode
 * @returns {Array<[string, Extract<Coverage, { mode: M }>]>}
 */
function entriesOf(mode) {
    return /** @type {Array<[string, Extract<Coverage, { mode: M }>]>} */ (
        Object.entries(ERASURE_COVERAGE).filter(([, c]) => c.mode === mode));
}

module.exports = { ERASURE_COVERAGE, entriesOf };
