// @typecheck strict
'use strict';
/**
 * The skill store's tables (skills, skill_test_runs) and its memoised init,
 * which also schedules the one-time structured-fields parse. Every function
 * of the store awaits initDB first (../skillStore.js and its siblings).
 */

const { exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');
const { runDdl } = require('../lib/_ddl');
const log = require('../../telemetry/log');

const TEST_RUNS_KEEP = 20;

const initDB = makeStoreInit('SkillStore', _initDB);

async function _initDB() {

    await exec(`
        CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            workflow TEXT DEFAULT '',
            rules TEXT DEFAULT '',
            examples TEXT DEFAULT '',
            icon TEXT DEFAULT '⚡',
            is_shared BOOLEAN DEFAULT false,
            dynamic_activation BOOLEAN DEFAULT false,
            shared_groups TEXT DEFAULT '[]',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE skills ADD COLUMN IF NOT EXISTS dynamic_activation BOOLEAN DEFAULT false;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]';
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS automation_id TEXT DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS enabled_integrations TEXT DEFAULT '[]';

        -- Structured fields (S1). Same statements as migrations/skills-structured-fields.js:
        -- either side may run first on a rolling deploy.
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS steps JSONB DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS rules_v2 JSONB DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS examples_v2 JSONB DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS allowed_automation_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NULL;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS output_schema JSONB DEFAULT NULL;
        -- The project a skill is filed into (soft reference; a Solution stage
        -- project makes it a managed part).
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT NULL;

        CREATE INDEX IF NOT EXISTS idx_skills_org ON skills(org_id);
        CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);
        CREATE INDEX IF NOT EXISTS idx_skills_created ON skills(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id) WHERE project_id IS NOT NULL;

        -- Test-tab results (S3 writes, S1 owns): the last ${TEST_RUNS_KEEP} per skill.
        CREATE TABLE IF NOT EXISTS skill_test_runs (
            id TEXT PRIMARY KEY,
            skill_id TEXT NOT NULL,
            agent_id TEXT,
            question TEXT NOT NULL DEFAULT '',
            results JSONB NOT NULL DEFAULT '[]'::jsonb,
            status TEXT NOT NULL DEFAULT 'ok',
            advice TEXT,
            ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_skill_test_runs_skill ON skill_test_runs(skill_id, ran_at DESC);
    `);

    // Personal skills: a user without an organisation owns skills directly
    // (org_id NULL, scoped to user_id — the same model owner-owned KBs use).
    // Drop the original NOT NULL so org-less accounts can create skills.
    // DROP NOT NULL is idempotent itself, so through runDdl any failure here
    // is a real one and is reported loudly instead of silently swallowed.
    await runDdl('skillStore', [
        `ALTER TABLE skills ALTER COLUMN org_id DROP NOT NULL`,
    ]);
    log.info('[SkillStore] PostgreSQL initialized');

    // One-time parse of the free text into structure. Idempotent (only NULL
    // facets), so it costs one SELECT per boot once applied. Registered here
    // — the house pattern of automationStore/core.js — so it can never be
    // forgotten in a boot list.
    setImmediate(() => {
        require('../../migrations/skills-structured-fields').up().catch(err =>
            log.warn('[SkillStore] skills-structured-fields migration error:', err.message));
    });
}

module.exports = { initDB, TEST_RUNS_KEEP };
