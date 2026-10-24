// @typecheck
'use strict';

/**
 * Knowledge Store — WITHDRAWN (Track Z, Z5). Deliberately an empty stub.
 *
 * (a) The table `knowledge_metadata` (per-agent knowledge) is withdrawn. The REST router
 *     that was its only writer — server/routes/knowledge.js, mounted on
 *     /agents/:id/knowledge — has been deleted, together with its two test files and the mount
 *     line in server/index.js. Nothing in the product ever read that table: the
 *     agent runtime retrieves over knowledge_bases/documents/chunks
 *     (core/agentRuntime/knowledgeSearch.js, core/kb/*), and the frontend and the mobile
 *     app talk exclusively to /api/kb. What was stored here therefore never
 *     reached a prompt — it was embedded, paid for and kept.
 *
 *     Defects that leave the codebase with this file: an unscoped delete query (on id, without
 *     agent_id — a BOLA: agent A could touch an item of agent B), a fail-open entitlement check
 *     (`.length` on a Promise → always 0 → the limit never bit) and read paths that returned `{}`
 *     since the pgvector rewrite because nothing was awaited.
 *
 *     The table definition has been dropped, not only the CRUD: if the DDL stayed here,
 *     the migration ladder would silently recreate the table after the drop below.
 *
 * (b) Existing rows are NOT touched by this code. They contain user-uploaded document
 *     text and fetched web pages — potentially personal data, which survives the
 *     deletion of an agent and can no longer be wiped through any screen. The OWNER exports or wipes
 *     them as part of the retention policy (count first per environment: number of rows and
 *     number of distinct agent_id) and drops the table afterwards.
 *
 * (c) Only after that drop may the last two lines go: the STORE_MODULES entry
 *     `{ name: 'knowledgeStore', file: './stores/knowledgeStore' }` in
 *     server/migrateDb.js (line 54) and this file itself. That entry stays until then
 *     because migrateDb.registration.test.js requires that every registered file exists and
 *     exports an awaitable initDB; that is why a no-op initDB sits below.
 *
 * The guard tests for this file are in stores/knowledgeStore.test.js.
 */

/**
 * No-op. Er is geen schema meer om aan te maken; de migratierunner mag hem awaiten.
 */
async function initDB() {}

module.exports = { initDB };
