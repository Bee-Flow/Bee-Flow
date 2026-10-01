// @typecheck
/**
 * Shared store core (§WS5): DB handles + the self-applied migration runner.
 * Leaf module — aggregates require this; it requires nothing in automationStore/.
 */

const { run, getOne, getAll, exec, getClient, pool } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const log = require('../../telemetry/log');

// Ordered migration list. The first (init) is foundational; the rest are
// incremental ALTERs applied on top. §WS3.4: each is tolerated individually so
// one transient failure doesn't block the store, but every failure is now
// LOGGED LOUDLY with its name — the previous silent `catch {}` hid a
// half-migrated schema behind opaque runtime 500s with no breadcrumb.
const MIGRATIONS = [
    'automation-builder-2026-05-init',          // foundational — must succeed
    'automation-locking-and-session-2026-05',
    'automation-clear-first-run-confirm-2026-05',
    'automation-timeout-and-subs-2026-05',
    'automation-event-mode-2026-05',
    'automation-approval-and-parallel-2026-06',
    'automation-error-class-2026-06',
    'automation-approval-expiry-2026-06',
    'automation-heartbeat-2026-06',
    'automation-alerts-2026-06',
    'automation-extras-2026-06',
    'n8n-connections-2026-06',
    'automation-layers-2026-06',
    'automation-inline-layers-2026-06',
    'automation-version-summary-2026-06',
    'automation-steps-2026-06',
    'automation-runs-history-2026-06',
    'automation-fk-cascade-2026-06',            // §WS3.2 — child-table FK/CASCADE
    'automation-shared-groups-jsonb-2026-06',   // §WS3.6 — shared_groups TEXT→JSONB
    'automation-multi-trigger-2026-07',         // trigger_step_id on webhooks/subscriptions
    // Studio Projects membership. This file existed since 2026-07 but was never
    // listed here, so the column was never created and nothing could read it —
    // the projects↔automations integration was written and then abandoned
    // half-way. Registering it is what makes the column real.
    'automation-project-id-2026-07',
    'automation-pii-summary-2026-08',           // pii_summary JSONB on run steps (canvas PII colours)
    'automation-run-token-vault-2026-08',       // pii_token_map JSONB on runs (run-scoped token vault)
    'automation-form-trigger-2026-08',          // automation_form_pages + automation_form_uploads
    'automation-form-sessions-2026-08',         // automation_form_sessions (multi-page forms)
    'automation-run-root-2026-08',              // root_run_id (one history row per paused-and-resumed journey)
    'automation-generated-files-2026-08',       // automation_generated_files (PDF/Word a run produced)
    'automation-folders-2026-08',               // automation_folders + automations.folder_id (sidebar grouping)
    'automation-approvals-2026-08',             // automation_approvals (durable decision records) + audit-log repurpose
    'approvals-v2-2026-09',                     // source-agnostic approvals: app source, on_decided hook, reminder/escalation clocks
    'approvals-panel-2026-09',                  // multi-approver panels: seats, decision rules, votes table, final sign-off stage
    'approvals-stages-2026-08',                 // sequential approval stages (up to 5, named + described) + participant index
    'approvals-deliveries-2026-08',             // automation_approval_deliveries: (channel, external id) → approvalId, so a Nextcloud reaction is routable
    'approvals-project-id-2026-09',             // project_id/project_title on approvals (Solution membership; INSERT-only, never detached)
    // Stamp every routine with its owner's organisation. The column existed
    // and was never written, so the runner derived it per run instead; a
    // shared datatable needs it to be a stored fact. Freezes today's
    // behaviour rather than changing it — see the migration's header.
    'automation-org-backfill-2026-09',
    // Rename every per-tenant datatable schema to the fixed-length hashed name.
    // MUST come before datatable-field-ids-2026-09: that one runs real DDL
    // through the engine, and it should land in the schema this leaves behind
    // rather than through the legacy-name fallback.
    'datatable-schema-rename-2026-09',
    // Address a datatable by (scope_kind, scope_id) instead of by organisation,
    // so an account with no organisation can own a PERSONAL table (BFSF-412).
    // MUST come before datatable-field-ids-2026-09: that one reaches the rows
    // through the engine, and the engine now addresses a tenant by its scope
    // key — which does not exist until the columns below do.
    'datatable-scope-2026-09',
    // Datatable columns were stored without the `fld_*` id the migration
    // planner matches on, so no author column was ever created in Postgres.
    // Backfills the ids and builds the columns that were skipped. Self-limiting:
    // once every field has an id it finds nothing and does no DDL.
    'datatable-field-ids-2026-09',
    // `managed_kind` — a table whose columns the platform owns (the visible
    // tier of the http_request response cache). Additive, nullable, no
    // backfill: NULL is what every existing table already is.
    'datatable-managed-kind-2026-09',
    // `source` + `sync_state` — a table whose ROWS come from elsewhere (a
    // Nextcloud Tables mirror). Additive, nullable, no backfill: NULL is what
    // every existing table already is.
    'datatable-nextcloud-source-2026-09',
    // The second source kind (a worksheet of a spreadsheet file): the
    // file-event fan-out index and one due-list index over both kinds.
    // Indexes only — the columns above already hold it.
    'datatable-spreadsheet-source-2026-09',
    'datatable-form-answers-2026-09',
    'automation-form-audience-2026-09',         // automation_form_pages.audience / shared_groups / shared_user_ids
    // Multi-trigger routines, second slice: `automation_runs.root_step_id`
    // (which trigger a run entered through — what lets an approval under a
    // secondary trigger resume on the right root) and `automation_schedules`
    // (additional schedule triggers; the primary stays on the automations row).
    'automation-multi-trigger-2026-09',
    // automation_evolutions: a routine's proposals to change its own definition,
    // applied after approval as a new version, watched by a canary, rolled back
    // on regression. See automation/evolution.js.
    'automation-evolution-2026-09',
    // BFSF-440: the trigger sample vault's table never had a writer or a
    // reader. automation-extras-2026-06 above no longer creates it; this drops
    // it on installs that still carry it, and is a probe-only no-op after that.
    'drop-automation-trigger-samples-2026-09',
    // BFSF-435: the full copy of a step output the run history truncated, so a
    // run that resumes after a form page or an approval gets it back.
    'automation-run-full-outputs-2026-09',
    // Studio → Automations handoff 5: the live/working split (+ one-time
    // backfill), the trash, version milestones, run outcome/test/caller
    // columns, structured step errors, shares, notification events and org
    // templates. One migration for every package of that work.
    'automation-handoff5-2026-09',
    // The warnings a run collects (a value that was empty, a list that went
    // into a one-value field, a branch with no edge) on the run row, where
    // the run view reads them. They were collected and never written.
    'automation-run-warnings-2026-10',
];

const initDB = makeStoreInit('AutomationStore', _initDB);

async function _initDB() {
    // The init migration creates the base tables — if it fails there is no
    // schema at all, so rethrow and do NOT mark initialized (the next call
    // retries rather than serving a store with no tables).
    await require(`../../migrations/${MIGRATIONS[0]}`).up();

    const failures = [];
    for (const name of MIGRATIONS.slice(1)) {
        try {
            await require(`../../migrations/${name}`).up();
        } catch (e) {
            failures.push(name);
            log.error(`[AutomationStore] migration ${name} FAILED: ${e.message}`);
        }
    }
    if (failures.length) {
        log.error(`[AutomationStore] ${failures.length} migration(s) failed to apply: ${failures.join(', ')} — the automation schema may be incomplete and queries referencing the missing columns will error. Fix the migration / ensure the DB is reachable and restart.`);
    } else {
        log.info('[AutomationStore] PostgreSQL initialized');
    }
}

// MIGRATIONS is exported for the registration tests (read, never mutated).
module.exports = { run, getOne, getAll, exec, getClient, pool, initDB, MIGRATIONS: Object.freeze([...MIGRATIONS]) };
