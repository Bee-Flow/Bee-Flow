'use strict';
/**
 * The team-chat schema, split from stores/projectChatStore.js (which re-exports it).
 */

/**
 * The schema, idempotent and PGlite-safe (no extensions). Exported so the pg
 * test creates exactly what production creates.
 */
const DDL = `
    CREATE TABLE IF NOT EXISTS project_chats (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        title_from_message_id TEXT,
        created_by      TEXT NOT NULL,
        ai_mode         TEXT NOT NULL DEFAULT 'mention'
                        CONSTRAINT project_chats_ai_mode_check
                        CHECK (ai_mode IN ('off', 'mention', 'auto', 'always')),
        agent_id        TEXT,
        archived        BOOLEAN NOT NULL DEFAULT FALSE,
        message_count   INTEGER NOT NULL DEFAULT 0,
        last_message_at TIMESTAMPTZ,
        last_seq        BIGINT NOT NULL DEFAULT 0,
        auto_paused_until TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_chats_project
        ON project_chats(project_id, archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS project_chat_messages (
        id             TEXT PRIMARY KEY,
        chat_id        TEXT NOT NULL REFERENCES project_chats(id) ON DELETE CASCADE,
        project_id     TEXT NOT NULL,
        seq            BIGINT NOT NULL,
        author_kind    TEXT NOT NULL CONSTRAINT project_chat_messages_author_kind_check
                       CHECK (author_kind IN ('user', 'assistant', 'system')),
        author_user_id TEXT,
        agent_id       TEXT,
        content        TEXT NOT NULL,
        mentions       JSONB NOT NULL DEFAULT '[]'::jsonb,
        reply_to       TEXT,
        client_msg_id  TEXT,
        ai_trigger     TEXT,
        ai_reason      TEXT,
        notice         TEXT,
        edited_at      TIMESTAMPTZ,
        deleted_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT project_chat_messages_chat_seq UNIQUE (chat_id, seq),
        CONSTRAINT project_chat_messages_author
            CHECK (author_kind = 'assistant' OR author_user_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_chat_messages_client
        ON project_chat_messages(chat_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS project_chat_reads (
        chat_id       TEXT NOT NULL REFERENCES project_chats(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL,
        last_read_seq BIGINT NOT NULL DEFAULT 0,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chat_id, user_id)
    );

    -- A database created before the AI could join on its own: the columns it
    -- lacks, and the two checks widened. Each step looks before it changes, so
    -- a current schema is left untouched.
    ALTER TABLE project_chats ADD COLUMN IF NOT EXISTS auto_paused_until TIMESTAMPTZ;
    ALTER TABLE project_chats ADD COLUMN IF NOT EXISTS title_from_message_id TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS ai_trigger TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS ai_reason TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS notice TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS thread_root_id TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS ai_meta JSONB;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS ai_trace TEXT;
    ALTER TABLE project_chat_messages ADD COLUMN IF NOT EXISTS refs JSONB NOT NULL DEFAULT '[]'::jsonb;
    DO $$
    BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'project_chats_ai_mode_check' AND conrelid = 'project_chats'::regclass
                      AND pg_get_constraintdef(oid) NOT LIKE '%auto%') THEN
            ALTER TABLE project_chats DROP CONSTRAINT project_chats_ai_mode_check;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'project_chats_ai_mode_check' AND conrelid = 'project_chats'::regclass) THEN
            ALTER TABLE project_chats ADD CONSTRAINT project_chats_ai_mode_check
                CHECK (ai_mode IN ('off', 'mention', 'auto', 'always'));
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'project_chat_messages_author_kind_check'
                      AND conrelid = 'project_chat_messages'::regclass
                      AND pg_get_constraintdef(oid) NOT LIKE '%system%') THEN
            ALTER TABLE project_chat_messages DROP CONSTRAINT project_chat_messages_author_kind_check;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'project_chat_messages_author_kind_check'
                          AND conrelid = 'project_chat_messages'::regclass) THEN
            ALTER TABLE project_chat_messages ADD CONSTRAINT project_chat_messages_author_kind_check
                CHECK (author_kind IN ('user', 'assistant', 'system'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'project_chat_messages_ai_trigger_check'
                          AND conrelid = 'project_chat_messages'::regclass) THEN
            ALTER TABLE project_chat_messages ADD CONSTRAINT project_chat_messages_ai_trigger_check
                CHECK (ai_trigger IS NULL OR ai_trigger IN ('ask', 'mention', 'always', 'auto_quiet', 'auto_unanswered'));
        END IF;
    END $$;
`;

module.exports = { DDL };
