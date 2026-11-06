/**
 * The schema of the KB query log: the settings columns on knowledge_bases and the
 * kb_query_log table. One list, run by stores/kb/schema.js and by the store tests.
 *
 * kb_id is UUID because knowledge_bases.id is. Content columns (`*_enc`) hold the
 * envelope of core/kb/queryLog/crypto.mts, or plain text when the org has encryption off.
 */

export const KB_QUERY_LOG_COLUMN_DDL: string[] = [
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_enabled BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_retention_days INT NOT NULL DEFAULT 90`,
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_changed_at TIMESTAMPTZ`,
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_changed_by TEXT`,
    // Round 2 (legal safeguards): the organisation's attestation of its preconditions, pseudonymous askers by
    // default, and the AI Act high-risk flag (retention of at least six months).
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_attestation JSONB`,
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_attested_by TEXT`,
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_attested_at TIMESTAMPTZ`,
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_show_names BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS query_log_ai_act_high_risk BOOLEAN NOT NULL DEFAULT false`,
];

export const KB_QUERY_LOG_TABLE_DDL: string[] = [
    `CREATE TABLE IF NOT EXISTS kb_query_log (
        id TEXT PRIMARY KEY,
        search_group_id TEXT NOT NULL,
        organization_id TEXT,
        kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        user_id TEXT,
        channel TEXT NOT NULL,
        channel_ref JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now(),
        query_enc TEXT,
        chunks_enc TEXT,
        chunk_count INT DEFAULT 0,
        top_score REAL,
        retrieval_ms INT,
        answer_enc TEXT,
        citations_enc TEXT,
        model TEXT,
        answer_ms INT,
        outcome TEXT NOT NULL DEFAULT 'no_results',
        error_code TEXT,
        answered_at TIMESTAMPTZ,
        review_status TEXT NOT NULL DEFAULT 'to_review',
        review_note_enc TEXT,
        reviewed_by TEXT,
        reviewed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kb_query_log_kb ON kb_query_log(kb_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_kb_query_log_user ON kb_query_log(organization_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_kb_query_log_expires ON kb_query_log(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_kb_query_log_group ON kb_query_log(search_group_id)`,
    // The user's recorded acknowledgement that questions to this base are logged (legal basis is legitimate
    // interest, so this is being informed, not consent). Valid while acknowledged_at >= query_log_changed_at.
    `CREATE TABLE IF NOT EXISTS kb_query_log_ack (
        user_id TEXT NOT NULL,
        kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, kb_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kb_query_log_ack_kb ON kb_query_log_ack(kb_id)`,
];
