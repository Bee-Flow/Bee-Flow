'use strict';

/**
 * The world of the KB query-log channel tests (channels*.pg.test.js): a PGlite database with
 * two knowledge bases (one that logs, one that does not), the retrieval (searchLocally), the
 * configuration and the access checks stubbed before the modules under test run, and the
 * recorder wired to the PGlite store. A test file calls `useChannelWorld()` once, at the top.
 */

const { before, after, beforeEach } = require('node:test');

const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { makeKbQueryLogStore } = require('../../../stores/kb/queryLog/index.mts');
const { KB_QUERY_LOG_COLUMN_DDL, KB_QUERY_LOG_TABLE_DDL } = require('../../../stores/kb/queryLog/ddl.mts');
const crypto = require('../../../stores/kb/queryLog/crypto.mts');
const rec = require('./recorder.mts');

// The retrieval and the configuration, stubbed before the modules under test run.
const configStore = require('../../../stores/configStore');
configStore.getConfig = async () => '';
configStore.getSecret = async () => '';
const localKBIngest = require('../localKBIngest');
const resolveProvider = require('../resolveProvider');
resolveProvider.resolveKbProvider = async () => 'local';
const kbVisibility = require('../kbVisibility');
kbVisibility.filterKbIdsForUser = async (ids) => ids;

const { pg, db } = pgliteDb();
const store = makeKbQueryLogStore(db);

const KB_ON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // logs
const KB_OFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // does not log
const DOC_ON = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const DOC_OFF = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';

let found = [];
localKBIngest.searchLocally = async () => found;
/** @param {any[]} rows what the next search finds */
const setFound = (rows) => { found = rows; };
const getFound = () => found;

const warnings = [];
const raw = async () => (await pg.query('SELECT * FROM kb_query_log ORDER BY created_at')).rows;
const entry = async (row) => store.getEntry(row.kb_id, row.id);
const settle = async (...handles) => { for (const h of handles) await h.settled(); await new Promise((r) => setTimeout(r, 50)); };

/** Register the hooks that build the world, empty the log before each test and close it after. */
function useChannelWorld() {
    before(async () => {
        crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 3), sealingEnabled: async () => true });
        await pg.exec(`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, tenant_id TEXT, name TEXT, organization_id TEXT);
            CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE CASCADE, content_hash TEXT);
            CREATE TABLE kb_document_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL, deleted_at TIMESTAMPTZ DEFAULT now());`);
        for (const sql of KB_QUERY_LOG_COLUMN_DDL) await pg.exec(sql);
        for (const sql of KB_QUERY_LOG_TABLE_DDL) await pg.exec(sql);
        await pg.exec(`INSERT INTO knowledge_bases (id, tenant_id, name, organization_id, query_log_enabled, query_log_retention_days) VALUES
            ('${KB_ON}', 't', 'On', 'org1', true, 90), ('${KB_OFF}', 't', 'Off', 'org1', false, 90);
            UPDATE knowledge_bases SET query_log_attestation = '{"purpose":"ai_quality"}'::jsonb WHERE query_log_enabled;
            INSERT INTO documents (id, knowledge_base_id) VALUES ('${DOC_ON}', '${KB_ON}'), ('${DOC_OFF}', '${KB_OFF}');
            INSERT INTO kb_query_log_ack (user_id, kb_id) SELECT u, '${KB_ON}'::uuid FROM unnest(ARRAY['u1','asker','u','owner','viewer','author','viewer1']) AS u;`);
    });
    after(async () => { rec._setRecorderDeps(null); crypto._setCryptoDeps(null); await pg.close(); });
    beforeEach(async () => {
        await pg.exec('DELETE FROM kb_query_log');
        warnings.length = 0;
        found = [{ id: 'c1', chunk_id: 'c1', document_id: DOC_ON, source_uri: 'policy.pdf', title: 'Policy', score: 0.5, content: 'The notice period is two months.' }];
        rec._setRecorderDeps({ store, hasFeature: async () => true, log: { warn: (m) => warnings.push(m) } });
    });
}

module.exports = {
    useChannelWorld, pg, db, store, raw, entry, settle, warnings, setFound, getFound,
    KB_ON, KB_OFF, DOC_ON, DOC_OFF,
};
