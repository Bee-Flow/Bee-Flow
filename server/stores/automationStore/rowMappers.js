// @typecheck
const { safeParse } = require('../lib/json');
/**
 * Pure row→object mappers + JSON helpers (§WS5, extracted verbatim). Leaf module.
 */

function rowToAutomation(r) {
    if (!r) return null;
    const out = {
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id,
        // null = standalone (every pre-existing row); set = filed into a Studio
        // Project, where its members can see and run it. Soft reference, so
        // deleting the project detaches rather than deletes.
        projectId: r.project_id ?? null,
        // null = loose in the sidebar; set = filed into an org-wide folder.
        // Soft reference, so deleting the folder detaches rather than deletes.
        folderId: r.folder_id ?? null,
        // 'automation' (default), 'layer' (legacy standalone sub-automation),
        // or 'block' (a reusable Step — standalone, added to automations via a
        // call_block step or exposed as a chat tool).
        kind: r.kind || 'automation',
        // Sharing + publish-to-apply columns (automation-steps-2026-06). Only
        // meaningful for kind='block'; automations keep the defaults.
        isPublished: r.is_published ?? false,
        sharedGroups: typeof r.shared_groups === 'string' ? safeParse(r.shared_groups, []) : (Array.isArray(r.shared_groups) ? r.shared_groups : []),
        publishedVersion: r.published_version ?? null,
        exposeAsTool: r.expose_as_tool ?? false,
        // A Step's own symbol (Lucide icon name); null = default. Only set for
        // kind='block', but harmless on automations.
        icon: r.icon ?? null,
        // User-set category for grouping Steps in the add-step menu (kind='block').
        category: r.category ?? null,
        title: r.title,
        description: r.description,
        // Repaired on the way out, not on the way in: a definition saved
        // before the builder guard can carry a step that names a built-in step
        // type as an integration tool (`{type:'integration_action',
        // tool:'http_request'}`), which nothing dispatches and which the canvas
        // draws as an Action. Healing here means the editor and the runner see
        // the same corrected step without a data migration, and the next save
        // persists it. Returns the same object when there is nothing to fix.
        definition: repairDefinition(
            typeof r.definition_json === 'string' ? safeParse(r.definition_json, {}) : (r.definition_json || {}),
        ),
        version: r.version,
        isActive: r.is_active,
        isDraft: r.is_draft,
        needsFirstRunConfirm: r.needs_first_run_confirm,
        triggerType: r.trigger_type,
        scheduleCron: r.schedule_cron,
        scheduleTz: r.schedule_tz,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        lastStatus: r.last_status,
        // Lock + retry columns added by automation-locking-and-session-2026-05.
        runningInstanceId: r.running_instance_id ?? null,
        runningStartedAt: r.running_started_at ? new Date(r.running_started_at).toISOString() : null,
        attempts: r.attempts ?? 0,
        // Per-automation timeout override (added by automation-timeout-and-subs-2026-05).
        // NULL means "use the runner's default".
        runTimeoutMs: r.run_timeout_ms ?? null,
        builderSession: typeof r.builder_session === 'string' ? safeParse(r.builder_session, null) : (r.builder_session ?? null),
        createdFromChatId: r.created_from_chat_id,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
        ...liveFields(r),
    };
    // The LIVE definition rides along NON-ENUMERABLE, on purpose:
    //   - it never reaches a JSON response (the editor works on `definition`;
    //     a second copy of the whole flow in every payload buys nothing);
    //   - a caller that builds a synthetic automation by spreading a row and
    //     replacing `definition` (a partial run, a Step run) drops it, so
    //     core/automationRunner/definitionForRun.js cannot swap the caller's
    //     chosen definition for the live one behind its back.
    // Only a row fresh from the store carries it; definitionForRun is the one
    // reader that decides which of the two a run executes.
    Object.defineProperty(out, 'liveDefinition', {
        value: r.live_definition_json == null ? null : repairDefinition(
            typeof r.live_definition_json === 'string' ? safeParse(r.live_definition_json, {}) : r.live_definition_json,
        ),
        enumerable: false,
        writable: true,
        configurable: true,
    });
    return out;
}

/**
 * The handoff-5 columns (automation-handoff5-2026-09) in their API shape.
 *
 *   liveVersion     the version runs execute; null = never live (a draft).
 *   liveAt          when that version went live.
 *   neverLive       true while there is no live version.
 *   pendingChanges  structural versions saved since the live one (layout-only
 *                   saves do not count); 0 when never live. Only present when
 *                   the query selected `pending_changes` (getAutomation and the
 *                   list reads do), else absent rather than a guessed 0.
 *   deletedAt/By    set while the automation sits in the trash.
 */
function liveFields(r) {
    const liveVersion = r.live_version ?? null;
    return {
        liveVersion,
        liveAt: r.live_at ? new Date(r.live_at).toISOString() : null,
        neverLive: liveVersion == null,
        ...(r.pending_changes !== undefined ? { pendingChanges: liveVersion == null ? 0 : Number(r.pending_changes) || 0 } : {}),
        deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
        deletedBy: r.deleted_by ?? null,
    };
}

function rowToRun(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        version: r.version,
        userId: r.user_id,
        triggerKind: r.trigger_kind,
        triggerPayload: typeof r.trigger_payload === 'string' ? safeParse(r.trigger_payload, null) : (r.trigger_payload || null),
        mode: r.mode,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        durationMs: r.duration_ms,
        error: r.error,
        summary: r.summary,
        // Cancel + retry plumbing (added by automation-timeout-and-subs-2026-05).
        // parentRunId is the run a retry replays. cancelRequested is flipped
        // by the cancel endpoint and read by the runner between steps.
        parentRunId: r.parent_run_id ?? null,
        // The JOURNEY this run belongs to: itself, unless it continues a run
        // that paused on a form/approval. Legacy rows predate the column, and
        // for those a run is trivially its own journey.
        rootRunId: r.root_run_id ?? r.id,
        // FRM-08 — who submitted, when the run is a form journey (null = unknown).
        submittedByUserId: r.submitted_by_user_id || null,
        // The trigger node the run entered through (multi-trigger automations).
        // NULL on legacy rows and on every primary-trigger run.
        rootStepId: r.root_step_id ?? null,
        cancelRequested: !!r.cancel_requested,
        // Approval / resume plumbing (added by automation-approval-and-parallel-2026-06).
        awaitingStepId: r.awaiting_step_id ?? null,
        // approval_token is deliberately NOT mapped. It is a reserved
        // credential (a future no-session approve link); nothing server-side
        // reads it back off this object, and mapping it meant every
        // GET /runs/:id shipped the token to the browser for no reason.
        // §27a — optional deadline on awaiting_approval. NULL means "no
        // expiry"; a past timestamp causes the approve route to 410.
        awaitingStepExpiresAt: r.awaiting_step_expires_at
            ? new Date(r.awaiting_step_expires_at).toISOString()
            : null,
        // §25 — typed error class persisted alongside the free-text error.
        errorClass: r.error_class ?? null,
        // §WS4 — how many step failures were absorbed by on_error branches.
        // The run itself still reports 'success'; the UI surfaces the count
        // as a "N handled" note.
        handledErrorCount: r.handled_error_count ?? 0,
        // Handoff 5 (automation-handoff5-2026-09). isTest: a live-mode run of
        // the WORKING copy (the builder's Test button); dry runs keep
        // mode='dry_run'. outcome: the one-sentence outcome as structured data
        // ({ code, params, text }) — null until the run writes one.
        startedByUserId: r.started_by_user_id ?? null,
        isTest: !!r.is_test,
        outcome: fromJsonb(r.outcome_json) ?? null,
        callerAgentId: r.caller_agent_id ?? null,
        callerConversationId: r.caller_conversation_id ?? null,
    };
}

function rowToRunStep(r) {
    if (!r) return null;
    const out = {
        runId: r.run_id,
        stepId: r.step_id,
        // Layer sub-step nesting: non-null on rows recorded inside a
        // call_layer ('cl1/out' → parent 'cl1'). Run-history UIs nest on it;
        // replay-state builders skip rows that carry it.
        parentStepId: r.parent_step_id ?? null,
        stepType: r.step_type,
        attempts: r.attempts,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        // input_json / output_json are jsonb — node-postgres already parses
        // them to JS (object / array / string / number / bool). They must NOT
        // be re-parsed: a bare-STRING value (e.g. an AI step's free-text or a
        // ```json fenced reply) comes back as a JS string, and JSON.parse-ing
        // that throws → the old `safeParse(..., null)` turned it into null, so
        // string outputs silently vanished from the Run/Output panels.
        input: fromJsonb(r.input_json),
        output: fromJsonb(r.output_json),
        error: r.error,
        errorClass: r.error_class ?? null,
        branchIndex: r.branch_index ?? null,
        // Aggregate PII counts (safety.buildPiiSummary) — drives the canvas's
        // "colour lines by PII" mode. Null on rows from before the column.
        piiSummary: fromJsonb(r.pii_summary) ?? null,
        // Handoff 5: tools an agent step was not given, and the structured
        // error ({ code, settingKey, fixes }) the drawer draws its fix
        // buttons from. Null on rows from before the columns.
        toolsWithheld: fromJsonb(r.tools_withheld) ?? null,
        errorInfo: fromJsonb(r.error_info) ?? null,
        // The mappings that found nothing while the step ran, each with the
        // server's sentence (stores/automationStore/bindingWarnings.js). Null
        // when none missed, and on rows from before the column.
        bindingWarnings: fromJsonb(r.binding_warnings) ?? null,
    };
    // A failed row from before the runner wrote error_info still gets the
    // plain-language card, classified from its message, its step type and its
    // recorded inputs (the tool name was never stored, so it is less precise).
    if (!out.errorInfo && r.error && (r.status === 'error' || r.status === 'handled_error')) {
        try {
            out.errorInfo = require('../../utils/stepErrorInfo').legacyStepErrorInfo(r.error, r.step_type, out.input);
        } catch { /* best-effort */ }
    }
    // Derive a human "what to do next" hint for LEGACY Nextcloud error rows
    // recorded before the runner enriched the message. New rows already embed
    // "<cause> — <remediation>" in `error`, so skip those to avoid doubling.
    if (r.error && !String(r.error).includes(' — ') && /nextcloud|webdav|deck|talk|ocs/i.test(String(r.error))) {
        try {
            const { classifyNextcloudError } = require('../../utils/nextcloudErrorClassifier');
            out.errorRemediation = classifyNextcloudError(r.error).remediation;
        } catch { /* best-effort */ }
    }
    return out;
}

// Best-effort: a read must never fail because a repair did.
function repairDefinition(definition) {
    try {
        return require('../../automation/repairBuiltinToolSteps').repairBuiltinToolSteps(definition);
    } catch {
        return definition;
    }
}

// Read a value from a jsonb column. node-postgres already parses jsonb to the
// right JS type (object / array / string / number / bool), so we pass it
// through verbatim. Re-running JSON.parse here — as the old code did for string
// values — corrupted data both ways: a non-JSON string (an AI step's free-text
// or a ```json fenced reply) threw and became null, while a string that merely
// looked like JSON ("42", "[…]") was silently retyped. The driver's single
// parse is the correct one.
function fromJsonb(v) {
    return v ?? null;
}

// ── Automations CRUD ───────────────────────────────────


module.exports = { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb };
