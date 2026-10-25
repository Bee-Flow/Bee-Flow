// @typecheck noImplicitAny
'use strict';
/** Schema of projectAiParticipationStore (kept apart so the store file stays small). */

const DDL = `
    CREATE TABLE IF NOT EXISTS project_ai_watch (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        surface        TEXT NOT NULL CHECK (surface IN ('chat', 'comment')),
        container_id   TEXT NOT NULL,
        message_id     TEXT NOT NULL,
        author_user_id TEXT NOT NULL,
        org_id         TEXT,
        limit_org_id   TEXT,
        kind           TEXT NOT NULL CHECK (kind IN ('quiet', 'unanswered')),
        due_at         TIMESTAMPTZ NOT NULL,
        first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        state          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'claimed', 'done', 'cancelled')),
        claim_id       TEXT,
        claimed_at     TIMESTAMPTZ,
        attempts       INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_ai_watch_pending
        ON project_ai_watch(surface, container_id, kind) WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_project_ai_watch_due
        ON project_ai_watch(due_at) WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_project_ai_watch_claimed
        ON project_ai_watch(container_id) WHERE state = 'claimed';

    CREATE TABLE IF NOT EXISTS project_ai_decisions (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        org_id             TEXT,
        surface            TEXT NOT NULL CHECK (surface IN ('chat', 'comment')),
        container_id       TEXT NOT NULL,
        trigger_message_id TEXT,
        trigger_kind       TEXT NOT NULL CHECK (trigger_kind IN ('quiet', 'unanswered', 'explicit', 'always')),
        decision           TEXT NOT NULL CHECK (decision IN ('pending', 'replied', 'silent', 'deferred', 'skipped')),
        skip_reason        TEXT,
        reason_code        TEXT,
        confidence         REAL,
        model              TEXT,
        gate_called        BOOLEAN NOT NULL DEFAULT FALSE,
        last_seq           BIGINT,
        reply_message_id   TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at         TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_ai_decisions_gate
        ON project_ai_decisions(surface, container_id, last_seq, trigger_kind) WHERE gate_called;
    CREATE INDEX IF NOT EXISTS idx_project_ai_decisions_container
        ON project_ai_decisions(container_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_ai_decisions_project
        ON project_ai_decisions(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_ai_decisions_org_gate
        ON project_ai_decisions(org_id, created_at DESC) WHERE gate_called;

    CREATE TABLE IF NOT EXISTS project_ai_feedback (
        message_id   TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        surface      TEXT NOT NULL CHECK (surface IN ('chat', 'comment')),
        container_id TEXT NOT NULL,
        helpful      BOOLEAN NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_ai_feedback_container
        ON project_ai_feedback(container_id, created_at DESC);
`;

module.exports = { DDL };
