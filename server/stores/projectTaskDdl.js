'use strict';
/** Schema of stores/projectTaskStore (kept apart so the store file stays small). */

const DDL = `
    CREATE TABLE IF NOT EXISTS project_tasks (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'todo'
                      CONSTRAINT project_tasks_status_check CHECK (status IN ('todo', 'doing', 'done')),
        assignee_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
        links         JSONB NOT NULL DEFAULT '[]'::jsonb,
        due_date      DATE,
        created_by    TEXT NOT NULL,
        completed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_tasks_project
        ON project_tasks(project_id, status, created_at DESC);
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS start_date DATE;
    DO $$ BEGIN
        ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_date_range CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS labels TEXT NOT NULL DEFAULT '';
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS checklist TEXT NOT NULL DEFAULT '';
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS sort_order BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS source JSONB;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS notified_due_tier TEXT;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT REFERENCES project_tasks(id) ON DELETE SET NULL;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS story_points INTEGER;
    DO $$ BEGIN
        ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_item_type_check CHECK (item_type IN ('epic', 'story', 'user-story', 'task'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
        ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_story_points_check CHECK (story_points IS NULL OR story_points IN (1, 2, 3, 5, 8, 13, 21));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_project_tasks_parent ON project_tasks(project_id, parent_task_id) WHERE parent_task_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS project_task_poker (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
        phase TEXT NOT NULL CHECK (phase IN ('voting', 'revealed', 'completed', 'cancelled')),
        votes JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- The tasks still to estimate in this session, in order (the current one is task_id).
    ALTER TABLE project_task_poker ADD COLUMN IF NOT EXISTS queue JSONB NOT NULL DEFAULT '[]'::jsonb;
    DO $$ BEGIN
        ALTER TABLE project_tasks ADD CONSTRAINT project_tasks_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_project_tasks_source
        ON project_tasks ((source->>'id')) WHERE source IS NOT NULL;
    -- A meeting item becomes a task once. Rows an earlier race already doubled lose their source
    -- (the task stays, only the claim on the item goes) so the unique index below can always be built.
    UPDATE project_tasks t SET source = NULL
      FROM (SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY project_id, source->>'id', source->>'itemId', COALESCE(source->>'textHash', '')
                     ORDER BY created_at, id) AS n
              FROM project_tasks WHERE source IS NOT NULL) d
     WHERE t.id = d.id AND d.n > 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_tasks_source_item
        ON project_tasks (project_id, (source->>'id'), (source->>'itemId'), (COALESCE(source->>'textHash', '')))
        WHERE source IS NOT NULL;
`;

module.exports = { DDL };
