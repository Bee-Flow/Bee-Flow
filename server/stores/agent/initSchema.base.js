// @typecheck strict
/**
 * Agent schema init, part 1: core tables, listing/search indexes and the
 * conversation column migrations. The steps are run in this order by
 * initSchema.js; the order of the statements is load-bearing (see there).
 */

const { exec } = require('../../db');
const { runDdl, CODES } = require('../lib/_ddl');
const log = require('../../telemetry/log');

async function createCoreTables() {
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
}

async function createListingIndexes() {
    // ── Phase 2: Composite indexes for hot listing queries ─────────────────────
    // listAllConversations(userId) → ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conv_user_updated ON agent_conversations(user_id, updated_at DESC)');
    // listDirectConversations(userId) → ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_direct_conv_user_updated ON direct_conversations(user_id, updated_at DESC)');
    // listConversations(agentId, userId) → WHERE agent_id=$1 AND user_id=$2 ORDER BY updated_at DESC
    await exec('CREATE INDEX IF NOT EXISTS idx_agent_conv_agent_user_updated ON agent_conversations(agent_id, user_id, updated_at DESC)');
}

async function createTrgmIndexes() {
    // ── Phase 6: pg_trgm GIN indexes for fast ILIKE search ────────────────────
    // pg_trgm accelerates ILIKE '%term%' queries from full-scan to index lookup.
    // Wrapped in try/catch: CREATE EXTENSION requires superuser; if unavailable
    // the ILIKE queries in searchConversations() still work, just without the
    // index acceleration (~10–50x slower, but only affects the search endpoint).
    // Documented degradation: without the extension the GIN indexes are skipped
    // on purpose; with it, a failing index build is a real error that runDdl
    // reports loudly (the old catches also swallowed timeouts).
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
                // On a fresh database conversation_messages does not exist yet
                // (that table belongs to agent/conversationMessages.js, which
                // initialises after this file); the next boot creates the index.
                tolerate: CODES.UNDEFINED_TABLE,
                reden: 'conversation_messages bestaat nog niet op een verse DB — index komt bij de volgende boot',
            },
            // Accelerates: agent_conversations.title ILIKE '%query%'
            `CREATE INDEX IF NOT EXISTS idx_agent_conv_title_trgm
                ON agent_conversations USING GIN (title gin_trgm_ops)`,
        ]);
    }
}

async function fixStaleSystemAgentModels() {
    // Migration: Fix stale system agent model values (display labels → tier:fast)
    await exec(`UPDATE agents SET model = 'tier:fast' WHERE owner_id = 'system' AND model IS NOT NULL AND model != '' AND model NOT LIKE 'tier:%'`);
}

async function addConversationColumns() {
    // Column migrations via runDdl (stores/lib/_ddl.js): errors are collected
    // loudly per statement instead of silently swallowed as "already exists".
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
}

async function addProjectForeignKeys() {
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
        log.warn('[initSchema] project_id FK migration skipped:', /** @type {Error} */ (e).message);
    }
}

async function addSharedScopeColumns() {
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
    // Via runDdl one error does not abort the whole loop; the rest keeps going
    // and each failing statement is reported loudly on its own.
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
}

async function addConversationFlagColumns() {
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
}

module.exports = {
    createCoreTables,
    createListingIndexes,
    createTrgmIndexes,
    fixStaleSystemAgentModels,
    addConversationColumns,
    addProjectForeignKeys,
    addSharedScopeColumns,
    addConversationFlagColumns,
};
