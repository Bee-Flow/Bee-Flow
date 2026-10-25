// @typecheck
/**
 * Agent schema init, part 2: categories, concept/live split, persona, labels,
 * favorites, test sets and the enabledIntegrations backfill. Run by
 * initSchema.js after the steps in initSchema.base.js.
 */

const { exec } = require('../../db');
const { runDdl } = require('../lib/_ddl');
const log = require('../../telemetry/log');

// One category name per org, case-insensitively. Exported because
// migrations/agent-categories-dedupe-2026-09.js builds this index itself after
// merging existing duplicates: an index with the same name but a different
// definition would make IF NOT EXISTS skip this one for good.
const AGENT_CATEGORY_NAME_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_categories_org_lname ON agent_categories (COALESCE(organization_id,''), LOWER(name))`;

async function createAgentCategories() {
    // Agent categories (org-level)
    await exec(`CREATE TABLE IF NOT EXISTS agent_categories (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        name TEXT NOT NULL,
        icon TEXT DEFAULT '📁',
        color TEXT DEFAULT '#6366f1',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await runDdl('agentSchema', [
        `CREATE INDEX IF NOT EXISTS idx_agent_categories_org ON agent_categories(organization_id)`,
        // BFSF-272: case-insensitive uniqueness per org so duplicate categories
        // ("Sales" vs "sales") stop accumulating. Installs that already contain
        // duplicates must NOT fail db:migrate; runDdl reports that 23505 loudly
        // (failures list) but not fatally. The loose migration
        // agent-categories-dedupe-2026-09 then merges each duplicate group
        // into its oldest row and builds this same index, so from the next
        // boot on this statement is a no-op there too.
        AGENT_CATEGORY_NAME_INDEX_SQL,
        // Migration: Add category_id column to agents
        `ALTER TABLE agents ADD COLUMN IF NOT EXISTS category_id TEXT`,
        // Migration: Add `rev` optimistic-concurrency token (monotonic integer,
        // mirrors studio_apps.definition_version). Bumped on every write; the editor
        // sends its last-seen `rev` so a stale save is rejected (409) instead of
        // silently clobbering a concurrent change. DEFAULT 1 seeds existing rows —
        // no backfill required.
        `ALTER TABLE agents ADD COLUMN IF NOT EXISTS rev INTEGER NOT NULL DEFAULT 1`,
    ]);
}

async function addPublishedConfigColumns() {
    // ── Concept/live split (A1, 2026-09) ────────────────────────────────────
    // `config` + `system_prompt` are the CONCEPT (what the editor autosaves).
    // `published_config` + `published_system_prompt` are what the runtime
    // serves once an agent has been published at least once
    // (`published_version > 0`). Until then — and always for owner_id='system'
    // agents (support singleton, system agents, which have no publish button)
    // — the runtime follows the concept, so adding these columns changes
    // nothing for anyone. `published_rev` is the concept `rev` at publish
    // time: "n unpublished changes" = rev > published_rev. The backfill that
    // flips existing agents into split mode lives in
    // migrations/agents-published-config.js and is NOT run at boot on purpose
    // (see that file's header). Same DDL there, so either path is idempotent.
    await runDdl('agentSchema', [
        `ALTER TABLE agents
            ADD COLUMN IF NOT EXISTS published_config JSONB,
            ADD COLUMN IF NOT EXISTS published_system_prompt TEXT,
            ADD COLUMN IF NOT EXISTS published_version INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS published_rev INTEGER,
            ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`,
    ]);
}

async function addPersonaColumn() {
    // ── Structured role (A1c, 2026-09) ──────────────────────────────────────
    // `persona` is the SOURCE the editor edits; `system_prompt` is generated
    // from it on save (core/agentRuntime/personaPrompt.js). It is deliberately
    // NULLable and there is NO backfill: a NULL persona reads back as
    // `{mode:'free', freeText: system_prompt}` (personaOf), which is exactly
    // the documented migration for pre-A1c agents — computed on read, so no
    // pass ever rewrites live rows and no agent is parsed by an LLM behind its
    // owner's back. The column is CONCEPT-only (there is no published_persona):
    // the runtime reads the generated prompt, which the concept/live split
    // already covers.
    await runDdl('agentSchema', [
        `ALTER TABLE agents ADD COLUMN IF NOT EXISTS persona JSONB`,
    ]);
}

async function createLabelsAndFavorites() {
    // User-defined conversation labels
    await exec(`CREATE TABLE IF NOT EXISTS conversation_labels (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6366f1',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await runDdl('agentSchema', [
        `CREATE INDEX IF NOT EXISTS idx_conversation_labels_user ON conversation_labels(user_id)`,
    ]);

    // Per-user agent favorites (replaces client-side localStorage `agentFavorites`)
    await exec(`CREATE TABLE IF NOT EXISTS agent_favorites (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, agent_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )`);
    await runDdl('agentSchema', [
        `CREATE INDEX IF NOT EXISTS idx_agent_favorites_user ON agent_favorites(user_id)`,
    ]);
}

async function createTestSets() {
    // ── Test sets (A1c, 2026-09) ────────────────────────────────────────────
    // `agent_tests` are the questions someone wrote down for this agent;
    // `agent_test_runs` is what happened the last time they were played back
    // (core/agentRuntime/testSandbox.js grades one turn each).
    //
    // Both CASCADE with the agent and NEITHER is a delete consumer: a test set
    // is an artefact OF the agent, not something that breaks when it goes —
    // counting them would make every agent anybody ever tested undeletable
    // (stores/agent/agentUsage.js lists the same reasoning for the other
    // history tables).
    //
    // `version` on a run is the published version that was actually exercised,
    // 0 when the runtime followed the concept. It is stored rather than derived
    // because "which agent did this verdict describe" stops being answerable
    // the moment somebody publishes again — and a verdict about a version
    // nobody runs any more must not read as a verdict about today's.
    await runDdl('agentSchema', [
        `CREATE TABLE IF NOT EXISTS agent_tests (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            name TEXT NOT NULL DEFAULT '',
            question TEXT NOT NULL,
            expect JSONB NOT NULL DEFAULT '{}'::jsonb,
            from_conversation_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_agent_tests_agent ON agent_tests(agent_id, created_at)`,
        `CREATE TABLE IF NOT EXISTS agent_test_runs (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            version INTEGER NOT NULL DEFAULT 0,
            results JSONB NOT NULL DEFAULT '{}'::jsonb,
            passed INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0,
            ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_agent_test_runs_agent ON agent_test_runs(agent_id, ran_at DESC)`,
        // `ran_at` only has millisecond precision, and `id` is a uuidv4 -
        // random, so not a valid tiebreaker. Runs that arrive in the same
        // millisecond (a prune right after an insert, a quiet machine) came
        // back in id order: random, and sometimes exactly the reverse of the
        // insertion order. `seq` is a separate, ever-increasing counter that
        // does follow insertion order; the ORDER BYs in agentTests.js use it
        // as the tiebreaker after `ran_at DESC`.
        `ALTER TABLE agent_test_runs ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
        `CREATE INDEX IF NOT EXISTS idx_agent_test_runs_agent_seq ON agent_test_runs(agent_id, ran_at DESC, seq DESC)`,
        // Who wrote this expectation document? `written_by` is the per-field
        // provenance from `core/agentRuntime/testSuggest.js` ({mustMention:'ai',
        // toolsExpected:'observed', ...}); `suggested_by` is the model that made
        // the proposal. Both NULL for a test a human typed themselves.
        //
        // Why a column and not a key in `expect`: `expect` is what the grader
        // reads, and a provenance field travelling inside it would turn into an
        // expectation. Why it is kept: without these two, a line a model wrote
        // cannot be told apart after saving from one somebody typed themselves,
        // and every later reader, plus every run result that follows from that
        // expectation, sees an expectation with no sender.
        `ALTER TABLE agent_tests ADD COLUMN IF NOT EXISTS written_by JSONB`,
        `ALTER TABLE agent_tests ADD COLUMN IF NOT EXISTS suggested_by TEXT`,
    ]);
}

async function backfillEnabledIntegrations() {
    // ── R4 backfill: legacy `enabledIntegrations: null` → explicit catalog ──
    // Wizard-created agents historically stored `null`, which the runtime
    // interpreted as "everything enabled". The new default is OFF — empty
    // arrays mean nothing. Convert legacy null/missing rows to an explicit
    // list mirroring every named integration in the wizard catalog so
    // existing agents keep the access they had. Per-credential gating in
    // integrationTools.js still filters tools the user can't actually call.
    // Idempotent: only touches rows whose key is null or missing.
    try {
        const LEGACY_FULL = JSON.stringify([
            'gmail','google-calendar','google-drive','google-sheets','google-docs','google-slides',
            'google-contacts','google-keep','google-groups','outlook','ms-calendar','onedrive',
            'ms-contacts','fireflies','youtrack','gamma','linkedin','n8n','agent-search','image-gen',
        ]);
        // agents.config is a TEXT column (see CREATE TABLE above), so every
        // jsonb operator needs an explicit cast and the result goes back as
        // text. Rows whose config is not a JSON object are left alone rather
        // than failing the whole statement.
        await exec(`
            UPDATE agents
            SET config = jsonb_set(
                COALESCE(NULLIF(config, '')::jsonb, '{}'::jsonb),
                '{enabledIntegrations}',
                '${LEGACY_FULL}'::jsonb,
                true
            )::text
            WHERE
                config IS NULL
                OR config = ''
                OR (config ~ '^\\s*\\{' AND (
                    NOT (config::jsonb ? 'enabledIntegrations')
                    OR config::jsonb -> 'enabledIntegrations' = 'null'::jsonb
                ))
        `);
    } catch (e) { log.warn('[agentStore] R4 backfill skipped:', /** @type {Error} */ (e).message); }
}

module.exports = {
    AGENT_CATEGORY_NAME_INDEX_SQL,
    createAgentCategories,
    addPublishedConfigColumns,
    addPersonaColumn,
    createLabelsAndFavorites,
    createTestSets,
    backfillEnabledIntegrations,
};
