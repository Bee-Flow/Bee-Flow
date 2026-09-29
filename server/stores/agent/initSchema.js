// @typecheck
/**
 * Agent Schema Init - Shared PostgreSQL table creation for all agent sub-modules
 * Uses a promise singleton to prevent concurrent CREATE TABLE races.
 */

const { exec } = require('../../db');
const { runDdl, CODES } = require('../lib/_ddl');
const log = require('../../telemetry/log');

let initPromise = null;

// One category name per org, case-insensitively. Exported because
// migrations/agent-categories-dedupe-2026-09.js builds this index itself after
// merging existing duplicates: an index with the same name but a different
// definition would make IF NOT EXISTS skip this one for good.
const AGENT_CATEGORY_NAME_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_categories_org_lname ON agent_categories (COALESCE(organization_id,''), LOWER(name))`;

async function initDB() {
    if (initPromise) return initPromise;
    initPromise = _doInit();
    return initPromise;
}

async function _doInit() {
    await exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            system_prompt TEXT,
            model TEXT,
            owner_id TEXT NOT NULL,
            is_published BOOLEAN DEFAULT FALSE,
            starter_prompts TEXT DEFAULT '[]',
            avatar TEXT,
            threads_enabled BOOLEAN DEFAULT TRUE,
            copy_enabled BOOLEAN DEFAULT TRUE,
            workspace_enabled BOOLEAN DEFAULT FALSE,
            embed_enabled BOOLEAN DEFAULT FALSE,
            config TEXT DEFAULT '{}',
            organization_id TEXT,
            shared_groups TEXT DEFAULT '[]',
            rev INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS agent_tools (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            component_id TEXT NOT NULL,
            params_json TEXT,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
            UNIQUE(agent_id, component_id)
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS agent_conversations (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            title TEXT DEFAULT 'New Chat',
            messages_json TEXT DEFAULT '[]',
            workspace_content TEXT DEFAULT '',
            thread_titles_json TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS direct_conversations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT DEFAULT 'New Chat',
            messages_json TEXT DEFAULT '[]',
            workspace_content TEXT DEFAULT '',
            model_tier TEXT DEFAULT 'fast',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec('CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conversations_agent ON agent_conversations(agent_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conversations_user ON agent_conversations(user_id)');
    await exec('CREATE INDEX IF NOT EXISTS idx_direct_conversations_user ON direct_conversations(user_id)');

    // ── Phase 2: Composite indexes for hot listing queries ─────────────────────
    // listAllConversations(userId) → ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conv_user_updated ON agent_conversations(user_id, updated_at DESC)');
    // listDirectConversations(userId) → ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_direct_conv_user_updated ON direct_conversations(user_id, updated_at DESC)');
    // listConversations(agentId, userId) → WHERE agent_id=$1 AND user_id=$2 ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conv_agent_user_updated ON agent_conversations(agent_id, user_id, updated_at DESC)');

    // ── Phase 6: pg_trgm GIN indexes for fast ILIKE search ────────────────────
    // pg_trgm accelerates ILIKE '%term%' queries from full-scan to index lookup.
    // Wrapped in try/catch: CREATE EXTENSION requires superuser; if unavailable
    // the ILIKE queries in searchConversations() still work, just without the
    // index acceleration (~10–50x slower, but only affects the search endpoint).
    // Gedocumenteerde degradatie: zonder extensie worden de GIN-indexen bewust
    // overgeslagen; mét extensie is een falende indexbouw een échte fout die
    // runDdl luid rapporteert (de oude catches slikten ook timeouts in).
    let trgmAvailable = true;
    try { await exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm`); } catch (e) {
        trgmAvailable = false;
        log.warn('[initSchema] pg_trgm unavailable (superuser needed) — search will use full scans');
    }
    if (trgmAvailable) {
        await runDdl('agentSchema', [
            {
                // Accelerates: conversation_messages.content ILIKE '%query%'
                sql: `CREATE INDEX IF NOT EXISTS idx_conv_messages_content_trgm
                    ON conversation_messages USING GIN (content gin_trgm_ops)`,
                // Op een verse database bestaat conversation_messages hier nog
                // niet (die tabel is van agent/conversationMessages.js, die ná
                // dit bestand initialiseert); de volgende boot zet de index.
                tolerate: CODES.UNDEFINED_TABLE,
                reden: 'conversation_messages bestaat nog niet op een verse DB — index komt bij de volgende boot',
            },
            // Accelerates: agent_conversations.title ILIKE '%query%'
            `CREATE INDEX IF NOT EXISTS idx_agent_conv_title_trgm
                ON agent_conversations USING GIN (title gin_trgm_ops)`,
        ]);
    }

    // Migration: Fix stale system agent model values (display labels → tier:fast)
    await exec(`UPDATE agents SET model = 'tier:fast' WHERE owner_id = 'system' AND model IS NOT NULL AND model != '' AND model NOT LIKE 'tier:%'`);

    // Kolommigraties via runDdl (stores/lib/_ddl.js): fouten per statement
    // luid verzameld i.p.v. stil ingeslikt als "already exists".
    await runDdl('agentSchema', [
        // Migration: Add workspace_content column to direct_conversations if missing
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS workspace_content TEXT DEFAULT ''`,
        // Migration: Add meta_json column for provider-specific state (e.g. OpenAI lastResponseId, compactionSummary)
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS meta_json TEXT DEFAULT '{}'`,
        `ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS meta_json TEXT DEFAULT '{}'`,
        // Migration: Add project_id for Projects feature
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS project_id TEXT`,
        `ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS project_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_direct_conversations_project ON direct_conversations(project_id)`,
        `CREATE INDEX IF NOT EXISTS idx_agent_conversations_project ON agent_conversations(project_id)`,
        // ── An agent can be filed into a Solution (O1) ───────────────────────
        //
        // A SOFT reference, exactly like studio_apps.project_id and
        // notebooks.project_id and for the same reason: deleting a project must
        // hand its members' agents back, never destroy them. Hence no FK — the
        // detacher in projects/membership.js is what clears it, and the pair
        // (detaches + clearProject) is asserted by membership.test.js.
        //
        // NOT the conversations' project_id above: that files a CHAT into a
        // project. This files the agent itself, so it is a nullable column on
        // `agents` with the same shape every other member kind uses.
        `ALTER TABLE agents ADD COLUMN IF NOT EXISTS project_id TEXT`,
        // Partial: the only query is "the agents in THIS project", and almost
        // every agent has no project at all. Mirrors idx_datatables_project.
        `CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id) WHERE project_id IS NOT NULL`,
    ]);

    // Migration: FK constraint so deleting a project clears project_id on its
    // conversations instead of leaving dangling references (a recycled UUID
    // could otherwise silently re-attach old conversations). Requires the
    // projects table to exist, so initialise projectStore first.
    try {
        const projectStore = require('../projectStore');
        if (typeof projectStore.initDB === 'function') await projectStore.initDB();

        await exec(`
            UPDATE direct_conversations SET project_id = NULL
              WHERE project_id IS NOT NULL
                AND project_id NOT IN (SELECT id FROM projects);
        `);
        await exec(`
            UPDATE agent_conversations SET project_id = NULL
              WHERE project_id IS NOT NULL
                AND project_id NOT IN (SELECT id FROM projects);
        `);
        await exec(`
            DO $$ BEGIN
                ALTER TABLE direct_conversations
                  ADD CONSTRAINT direct_conversations_project_fk
                  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
        await exec(`
            DO $$ BEGIN
                ALTER TABLE agent_conversations
                  ADD CONSTRAINT agent_conversations_project_fk
                  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        `);
    } catch (e) {
        log.warn('[initSchema] project_id FK migration skipped:', e.message);
    }

    // ── Migration: shared project conversations ─────────────────────────────
    //
    // TWO columns, and keeping them separate is load-bearing.
    //
    //   shared_scope  WHO MAY READ. 'private' (the owner) or 'project' (every
    //                 member). Filing a conversation under a project — which
    //                 project_id has always meant — is NOT sharing it, and must
    //                 not become sharing on upgrade. Hence the default.
    //
    //   crypto_scope  WHICH KEY THE ROWS ON DISK WERE WRITTEN UNDER. 'user' (the
    //                 owner's DEK) or 'project' (derived from the org root key,
    //                 see auth/projectEscrow.js). A reader must not have to
    //                 guess and catch the failure, and a re-key that dies
    //                 half-way has to be detectable rather than silently
    //                 unreadable.
    //
    // They move together in the normal case, but a conversation can be shared
    // before it is re-keyed, so conflating them into one column would make that
    // window unrepresentable.
    // Voorheen brak één fout de hele loop af ("migration skipped") én bleef
    // elke individuele fout onzichtbaar; via runDdl draait de rest door en
    // wordt elk falend statement apart luid gerapporteerd.
    await runDdl('agentSchema', ['direct_conversations', 'agent_conversations'].flatMap((t) => [
        `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS shared_scope TEXT NOT NULL DEFAULT 'private'`,
        `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS crypto_scope TEXT NOT NULL DEFAULT 'user'`,
        `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ`,
        // Partial index: the project thread list reads exactly this slice.
        `CREATE INDEX IF NOT EXISTS idx_${t}_project_shared
            ON ${t}(project_id, updated_at DESC) WHERE shared_scope = 'project'`,
        // A conversation cannot be shared with a project it is not in.
        `DO $$ BEGIN
            ALTER TABLE ${t} ADD CONSTRAINT ${t}_shared_needs_project
                CHECK (shared_scope = 'private' OR project_id IS NOT NULL);
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;`,
    ]));

    await runDdl('agentSchema', [
        // Migration: Add pinned column for pin/unpin feature
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`,
        `ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`,
        // Migration: Add labels_json column for conversation labels
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS labels_json TEXT DEFAULT '[]'`,
        `ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS labels_json TEXT DEFAULT '[]'`,
        // Migration: Add pii_token_map column for Privacy Shield token round-trip
        // across server restarts. Stores `{ "[person_1]": "Gerard …", … }` so that
        // notebook content / tool history / saved messages with raw tokens can be
        // restored to real values on conversation reload even after the in-memory
        // map at server/core/dlp/dlpRunner.js has been wiped.
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS pii_token_map JSONB`,
        `ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS pii_token_map JSONB`,
        // Migration: Add workspace_notebook_id to link workspace notebook to conversation
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS workspace_notebook_id TEXT`,
        `ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS workspace_notebook_id TEXT`,
        // ── C3: knowledge bases attached to a direct conversation ───────────
        //
        // JSONB, like every other knowledge_base_ids in the product (projects,
        // skills, templates, webpages) — NOT the TEXT-holding-JSON shape
        // labels_json uses on this same table. The containment operator is the
        // reason: `knowledge_base_ids @> to_jsonb($1::text)` is how a deleted
        // base is scrubbed out of its consumers, and that only works on jsonb.
        //
        // `NOT NULL DEFAULT '[]'` is a constant default, so this stays a
        // metadata-only ALTER in Postgres — safe in boot DDL on a table that
        // gets large. Deliberately NO index: this column is read by
        // conversation id, never searched by kb id (see the runbook note in
        // stores/lib/_ddl.js on new indexes over volume tables).
        //
        // Empty is the only "nothing" there is. A conversation with no
        // attached bases stores `[]`, and `[]` means NO knowledge bases at
        // retrieval — never "fall back to all of them".
        `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
    ]);

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
        // `ran_at` heeft alleen milliseconde-precisie, en `id` is een uuidv4 —
        // willekeurig, dus geen geldige tiebreaker. Runs die in dezelfde
        // milliseconde binnenkomen (een prune direct na een insert, een
        // rustige machine) kwamen terug in id-volgorde: willekeurig, en soms
        // exact omgekeerd aan de invoegvolgorde. `seq` is een losse, altijd
        // stijgende teller die wél de invoegvolgorde volgt; de ORDER BY's in
        // agentTests.js gebruiken hem als tiebreaker na `ran_at DESC`.
        `ALTER TABLE agent_test_runs ADD COLUMN IF NOT EXISTS seq BIGSERIAL`,
        `CREATE INDEX IF NOT EXISTS idx_agent_test_runs_agent_seq ON agent_test_runs(agent_id, ran_at DESC, seq DESC)`,
        // Wie schreef dit verwachtingsdocument? `written_by` is de per-veld
        // herkomst van `core/agentRuntime/testSuggest.js` ({mustMention:'ai',
        // toolsExpected:'observed', …}); `suggested_by` is het model dat het
        // voorstel deed. Beide NULL voor een test die een mens zelf tikte.
        //
        // Waarom dit een kolom is en geen sleutel in `expect`: `expect` is wat
        // de grader leest, en een herkomstveld dat daarin meereist zou een
        // verwachting worden. Waarom het bewaard wordt: zonder deze twee is een
        // regel die een model schreef na het opslaan niet te onderscheiden van
        // een die iemand zelf tikte — en elke latere lezer, plus elke
        // run-uitslag die uit die verwachting volgt, ziet dan een verwachting
        // zonder afzender.
        `ALTER TABLE agent_tests ADD COLUMN IF NOT EXISTS written_by JSONB`,
        `ALTER TABLE agent_tests ADD COLUMN IF NOT EXISTS suggested_by TEXT`,
    ]);

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
    } catch (e) { log.warn('[agentStore] R4 backfill skipped:', e.message); }
}

module.exports = { initDB, AGENT_CATEGORY_NAME_INDEX_SQL };
